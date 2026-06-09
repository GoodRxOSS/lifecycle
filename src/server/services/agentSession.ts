/**
 * Copyright 2025 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import 'server/lib/dependencies';
import * as k8s from '@kubernetes/client-node';
import { Writable } from 'stream';
import { v4 as uuid } from 'uuid';
import type Database from 'server/database';
import AgentSandbox from 'server/models/AgentSandbox';
import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import Configuration from 'server/models/Configuration';
import Deploy from 'server/models/Deploy';
import { createAgentPvc, deleteAgentPvc } from 'server/lib/agentSession/pvcFactory';
import { createAgentApiKeySecret, deleteAgentApiKeySecret } from 'server/lib/agentSession/apiKeySecretFactory';
import {
  SESSION_WORKSPACE_GATEWAY_CONTAINER_NAME,
  createSessionWorkspacePodWithoutWaiting,
  createSessionWorkspacePod,
  deleteSessionWorkspacePod,
  waitForSessionWorkspacePodReady,
  waitForSessionWorkspacePodScheduled,
} from 'server/lib/agentSession/podFactory';
import {
  createSessionWorkspaceService,
  deleteSessionWorkspaceService,
} from 'server/lib/agentSession/editorServiceFactory';
import { ensureAgentSessionServiceAccount } from 'server/lib/agentSession/serviceAccountFactory';
import { isGvisorAvailable } from 'server/lib/agentSession/gvisorCheck';
import {
  buildChatPreviewHostSlug,
  resolveChatPreviewPublicPublication,
} from 'server/lib/agentSession/chatPreviewFactory';
import { DevModeManager } from 'server/lib/agentSession/devModeManager';
import type { DevModeResourceSnapshot } from 'server/lib/agentSession/devModeManager';
import { createOrUpdateNamespace, deleteNamespace, probeWorkspacePodPresence } from 'server/lib/kubernetes';
import { buildAgentNetworkPolicy } from 'server/lib/kubernetes/networkPolicyFactory';
import { DevConfig } from 'server/models/yaml/YamlService';
import RedisClient from 'server/lib/redisClient';
import { extractContextForQueue, getLogger } from 'server/lib/logger';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus, BuildKind, FeatureFlags } from 'shared/constants';
import type { RequestUserIdentity } from 'server/lib/get-user';
import {
  resolveAgentSessionRuntimeConfig,
  resolveAgentSessionWorkspaceStorageIntent,
  resolveKeepAttachedServicesOnSessionNode,
  type ResolvedAgentSessionReadinessConfig,
  type ResolvedAgentSessionResources,
  type ResolvedAgentSessionWorkspaceStorageIntent,
} from 'server/lib/agentSession/runtimeConfig';
import { applyForwardedAgentEnvSecrets, cleanupForwardedAgentEnvSecrets } from 'server/lib/agentSession/forwardedEnv';
import { EMPTY_AGENT_SESSION_SKILL_PLAN, resolveAgentSessionSkillPlan } from 'server/lib/agentSession/skillPlan';
import { generateSkillBootstrapCommand } from 'server/lib/agentSession/skillBootstrap';
import {
  SESSION_WORKSPACE_ROOT,
  type AgentSessionSelectedService,
  type AgentSessionWorkspaceRepo,
} from 'server/lib/agentSession/workspace';
import {
  applyWorkspaceReposToServices,
  buildCombinedInstallCommand,
  workspaceRepoKey,
} from 'server/lib/agentSession/servicePlan';
import {
  resolveWorkspaceRuntimePlan,
  toWorkspaceRuntimePlanMetadata,
  type WorkspaceRuntimePlan,
  type WorkspaceRuntimePlanMetadata,
} from 'server/lib/agentSession/workspaceRuntimePlan';
import {
  buildAgentSessionDynamicSystemPrompt,
  combineAgentSessionAppendSystemPrompt,
  resolveAgentSessionPromptContext,
} from 'server/lib/agentSession/systemPrompt';
import {
  AgentSessionStartupFailureStage,
  PublicAgentSessionStartupFailure,
  buildAgentSessionStartupFailure,
  buildWorkspaceRuntimeFailure,
  clearAgentSessionStartupFailure,
  getAgentSessionStartupFailure,
  normalizeWorkspaceRuntimeFailure,
  setAgentSessionStartupFailure,
  toPublicAgentSessionStartupFailure,
  type WorkspaceRuntimeFailureOrigin,
} from 'server/lib/agentSession/startupFailureState';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import GlobalConfigService from './globalConfig';
import { SESSION_POD_MCP_CONFIG_SECRET_KEY } from 'server/services/agentRuntime/mcp/sessionPod';
import AgentPrewarmService from './agentPrewarm';
import AgentSessionConfigService from './agentSessionConfig';
import AgentChatSessionService from './agent/ChatSessionService';
import AgentPolicyService from './agent/PolicyService';
import AgentSandboxService from './agent/SandboxService';
import { assertBackendCapabilities } from './workspaceRuntime/catalog';
import {
  LIFECYCLE_GATEWAY_TOKEN_ENV,
  encryptWorkspaceGatewayToken,
  mintKubernetesGatewayToken,
  mintWorkspaceGatewayToken,
} from './workspaceRuntime/gatewayToken';
import {
  resolveRemoteBackendIdForPlan,
  resolveRemoteRuntimeProviderForPlan,
  resolveRemoteRuntimeProviderForSandbox,
} from './workspaceRuntime/registry';
import {
  LIFECYCLE_KUBERNETES_PROVIDER,
  WorkspaceRuntimeGoneError,
  WorkspaceRuntimeSecurityError,
  type RemoteRuntimeHandle,
  type RemoteWorkspaceRuntimeProvider,
  type WorkspaceRuntimeEndpoint,
} from './workspaceRuntime/types';
import { buildWorkspaceGatewayPreviewEndpoint } from './workspaceRuntime/gatewayPreview';
import AgentSourceService from './agent/SourceService';
import type { AgentRuntimeToolMetadata } from './agent/toolMetadata';
import WorkspaceRuntimeStateService, {
  WorkspaceActionBlockedError,
  type WorkspaceRuntimeAction,
} from './agent/WorkspaceRuntimeStateService';
import { buildWorkspaceCorePromptLines } from './workspaceCoreMcp/prompt';
import { canSessionAcceptMessages, getSessionMessageBlockReason } from './agent/sessionReadiness';
import {
  loadAgentSessionServiceCandidates,
  resolveRequestedAgentSessionServices,
  type RequestedAgentSessionServiceRef,
} from './agentSessionCandidates';
import { normalizeKubernetesLabelValue } from 'server/lib/kubernetes/utils';
import type { AgentSessionSkillRef } from 'server/models/yaml/YamlService';

const logger = () => getLogger();

// One-time warning when K8s sessions provision without gateway-token enforcement (ENCRYPTION_KEY unset).
let warnedK8sGatewayTokenDisabled = false;
function mintK8sGatewayTokenOrWarn(): { gatewayToken?: string; encryptedGatewayToken?: string } {
  const minted = mintKubernetesGatewayToken();
  if (!minted.gatewayToken && !warnedK8sGatewayTokenDisabled) {
    warnedK8sGatewayTokenDisabled = true;
    logger().warn(
      'ENCRYPTION_KEY is not set: Kubernetes workspace sessions will provision without gateway bearer-token enforcement. ' +
        'Set ENCRYPTION_KEY (secrets.encryptionKey) to enable per-session gateway auth.'
    );
  }
  return minted;
}

export interface ChatHttpProbeResult {
  status: 'healthy' | 'unhealthy';
  reachable: boolean;
  ok: boolean;
  checkedAt: string;
  attempts: number;
  durationMs: number;
  statusCode: number | null;
  statusText: string | null;
  error: string | null;
  message: string;
}

const CHAT_HTTP_PROBE_TIMEOUT_MS = 10000;
const CHAT_HTTP_PROBE_POLL_MS = 500;
const CHAT_HTTP_SINGLE_PROBE_TIMEOUT_MS = 2000;

function readProbeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeWorkspaceHttpEndpointOnce(
  endpoint: WorkspaceRuntimeEndpoint,
  timeoutMs: number
): Promise<Pick<ChatHttpProbeResult, 'reachable' | 'ok' | 'statusCode' | 'statusText' | 'error'>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint.url, {
      method: 'GET',
      headers: endpoint.headers || {},
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    return {
      reachable: true,
      ok: response.ok,
      statusCode: response.status,
      statusText: response.statusText || null,
      error: null,
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      statusCode: null,
      statusText: null,
      error: readProbeErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyWorkspaceHttpEndpoint(endpoint: WorkspaceRuntimeEndpoint): Promise<ChatHttpProbeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + CHAT_HTTP_PROBE_TIMEOUT_MS;
  let attempts = 0;
  let latestProbe: Pick<ChatHttpProbeResult, 'reachable' | 'ok' | 'statusCode' | 'statusText' | 'error'> = {
    reachable: false,
    ok: false,
    statusCode: null,
    statusText: null,
    error: 'Preview target was not probed.',
  };

  do {
    attempts += 1;
    latestProbe = await probeWorkspaceHttpEndpointOnce(
      endpoint,
      Math.min(CHAT_HTTP_SINGLE_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now()))
    );
    if (latestProbe.ok) {
      return {
        status: 'healthy',
        reachable: true,
        ok: true,
        checkedAt: new Date().toISOString(),
        attempts,
        durationMs: Date.now() - startedAt,
        statusCode: latestProbe.statusCode,
        statusText: latestProbe.statusText,
        error: null,
        message: 'Preview target responded with a successful HTTP status.',
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(CHAT_HTTP_PROBE_POLL_MS, remainingMs));
    }
  } while (Date.now() < deadline);

  const detail = latestProbe.reachable
    ? `HTTP ${latestProbe.statusCode}${latestProbe.statusText ? ` ${latestProbe.statusText}` : ''}`
    : latestProbe.error || 'No HTTP response';

  return {
    status: 'unhealthy',
    reachable: latestProbe.reachable,
    ok: false,
    checkedAt: new Date().toISOString(),
    attempts,
    durationMs: Date.now() - startedAt,
    statusCode: latestProbe.statusCode,
    statusText: latestProbe.statusText,
    error: latestProbe.error,
    message: `Preview target did not pass the reachability check before timeout: ${detail}.`,
  };
}

const SESSION_REDIS_PREFIX = 'lifecycle:agent:session:';
const ACTIVE_ENVIRONMENT_SESSION_UNIQUE_INDEX = 'agent_sessions_active_environment_build_unique';
const DEV_MODE_REDEPLOY_GRAPH = '[deployable.[repository], repository, service, build.[pullRequest.[repository]]]';
const SESSION_DEPLOY_GRAPH = '[deployable, repository, service]';
const agentNetworkPolicySetupByNamespace = new Map<string, Promise<void>>();

type AgentSessionSummaryRecordBase = AgentSession & {
  id: string;
  uuid: string;
  baseBuildUuid: string | null;
  repo: string | null;
  branch: string | null;
  primaryRepo: string | null;
  primaryBranch: string | null;
  services: string[];
};

type AgentSessionSummaryRecord = AgentSessionSummaryRecordBase & {
  startupFailure: PublicAgentSessionStartupFailure | null;
};

type ActiveEnvironmentSessionSummary = {
  id: string | null;
  status: AgentSession['status'];
  ownerGithubUsername: string | null;
  ownedByCurrentUser: boolean;
};

function resolveSessionKindFromBuildKind(buildKind: BuildKind): AgentSessionKind {
  return buildKind === BuildKind.SANDBOX ? AgentSessionKind.SANDBOX : AgentSessionKind.ENVIRONMENT;
}

function warmDefaultThread(sessionUuid: string, userId: string): void {
  // Default-thread creation stays best-effort so chat readiness does not
  // depend on secondary DB work; ThreadService.listThreadsForSession() will
  // create or retry the default thread on first access if this warm-up fails.
  void (async () => {
    const AgentThreadService = (await import('server/services/agent/ThreadService')).default;
    await AgentThreadService.getDefaultThreadForSession(sessionUuid, userId);
  })().catch((error: unknown) => {
    logger().warn(
      { error, sessionId: sessionUuid },
      `Session: default thread creation skipped sessionId=${sessionUuid}`
    );
  });
}

export function buildAgentSessionPodName(sessionUuid: string, buildUuid?: string | null): string {
  const identifier = buildUuid ?? sessionUuid.slice(0, 8);
  return normalizeKubernetesLabelValue(`agent-${identifier}`.toLowerCase()).replace(/[_.]/g, '-');
}

function buildChatSessionNamespace(sessionUuid: string): string {
  return normalizeKubernetesLabelValue(`chat-${sessionUuid.slice(0, 8)}`.toLowerCase()).replace(/[_.]/g, '-');
}

export class ActiveEnvironmentSessionError extends Error {
  activeSession: ActiveEnvironmentSessionSummary;

  constructor(activeSession: ActiveEnvironmentSessionSummary) {
    super(
      activeSession.ownerGithubUsername
        ? `An active environment session is already running for this environment by ${activeSession.ownerGithubUsername}. Fork the environment into a sandbox instead.`
        : 'An active environment session is already running for this environment. Fork the environment into a sandbox instead.'
    );
    this.name = 'ActiveEnvironmentSessionError';
    this.activeSession = activeSession;
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(Date.now() - startedAt, 0);
}

async function ensureAgentNetworkPolicy(namespace: string): Promise<void> {
  let setupPromise = agentNetworkPolicySetupByNamespace.get(namespace);
  if (!setupPromise) {
    setupPromise = (async () => {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const netApi = kc.makeApiClient(k8s.NetworkingV1Api);
      const policy = buildAgentNetworkPolicy(namespace);
      await netApi.createNamespacedNetworkPolicy(namespace, policy).catch((err: any) => {
        if (err?.statusCode !== 409) {
          throw err;
        }
      });
    })();
    agentNetworkPolicySetupByNamespace.set(namespace, setupPromise);
  }

  try {
    await setupPromise;
  } catch (error) {
    if (agentNetworkPolicySetupByNamespace.get(namespace) === setupPromise) {
      agentNetworkPolicySetupByNamespace.delete(namespace);
    }

    throw error;
  }
}

async function restoreDeploys(deploys: Deploy[]): Promise<void> {
  if (deploys.length === 0) {
    return;
  }

  const { DeploymentManager } = await import('server/lib/deploymentManager/deploymentManager');
  await new DeploymentManager(deploys).deploy();
}

async function attachStartupFailures<T extends { uuid: string; status: AgentSession['status'] }>(
  sessions: T[],
  sessionDatabaseIdByUuid: Map<string, number> = new Map()
): Promise<Array<T & { startupFailure: PublicAgentSessionStartupFailure | null }>> {
  if (sessions.length === 0) {
    return [];
  }

  const errorSessions = sessions.filter((session) => session.status === 'error');
  if (errorSessions.length === 0) {
    return sessions.map((session) => ({
      ...session,
      startupFailure: null,
    }));
  }

  const durableFailureBySessionDbId = new Map<number, PublicAgentSessionStartupFailure>();
  const errorSessionDatabaseIds = errorSessions
    .map((session) => sessionDatabaseIdByUuid.get(session.uuid))
    .filter((sessionId): sessionId is number => typeof sessionId === 'number');

  if (errorSessionDatabaseIds.length > 0) {
    let sandboxRows: AgentSandbox[] = [];
    try {
      const queriedSandboxes = await AgentSandbox.query()
        .whereIn('sessionId', errorSessionDatabaseIds)
        .orderBy('generation', 'desc')
        .orderBy('createdAt', 'desc');
      sandboxRows = Array.isArray(queriedSandboxes) ? queriedSandboxes : [];
    } catch {
      sandboxRows = [];
    }

    for (const sandbox of sandboxRows) {
      if (durableFailureBySessionDbId.has(sandbox.sessionId)) {
        continue;
      }

      if (sandbox.error || sandbox.status === 'failed') {
        durableFailureBySessionDbId.set(
          sandbox.sessionId,
          normalizeWorkspaceRuntimeFailure(sandbox.error, {
            origin: 'legacy',
            retryable: false,
          })
        );
      }
    }
  }

  const redis = RedisClient.getInstance().getRedis();
  const sessionsMissingDurableFailure = errorSessions.filter((session) => {
    const sessionDbId = sessionDatabaseIdByUuid.get(session.uuid);
    return typeof sessionDbId !== 'number' || !durableFailureBySessionDbId.has(sessionDbId);
  });
  const failures = await Promise.all(
    sessionsMissingDurableFailure.map(async (session) => {
      const failure = await getAgentSessionStartupFailure(redis, session.uuid).catch(() => null);
      return [session.uuid, failure ? toPublicAgentSessionStartupFailure(failure) : null] as const;
    })
  );
  const failureBySessionId = new Map(failures);

  return sessions.map((session) => ({
    ...session,
    startupFailure:
      durableFailureBySessionDbId.get(sessionDatabaseIdByUuid.get(session.uuid) || -1) ??
      failureBySessionId.get(session.uuid) ??
      null,
  }));
}

type SessionSnapshotMap = Record<string, DevModeResourceSnapshot>;
type SessionService = NonNullable<CreateSessionOptions['services']>[number];
type RequestedSessionService = string | RequestedAgentSessionServiceRef;
type DevModeEnabledService = {
  deployId: number;
  deploymentName: string;
  serviceName: string;
  snapshot: DevModeResourceSnapshot;
};

function getSessionSnapshot(
  snapshots: SessionSnapshotMap | null | undefined,
  deployId: number
): DevModeResourceSnapshot | null {
  const snapshot = snapshots?.[String(deployId)];
  return snapshot ?? null;
}

function mergeSelectedServices(
  existingServices: AgentSessionSelectedService[] | null | undefined,
  nextServices: AgentSessionSelectedService[]
): AgentSessionSelectedService[] {
  const mergedServices = [...(existingServices || [])];
  const seenDeployIds = new Set(mergedServices.map((service) => service.deployId));

  for (const service of nextServices) {
    if (seenDeployIds.has(service.deployId)) {
      continue;
    }

    mergedServices.push(service);
    seenDeployIds.add(service.deployId);
  }

  return mergedServices;
}

class DevModeBatchEnableError extends Error {
  successfulServices: DevModeEnabledService[];
  failures: Array<{ deployId: number; error: unknown }>;

  constructor(successfulServices: DevModeEnabledService[], failures: Array<{ deployId: number; error: unknown }>) {
    const primaryError = failures[0]?.error;
    super(primaryError instanceof Error ? primaryError.message : String(primaryError ?? 'Failed to enable dev mode'));
    this.name = 'DevModeBatchEnableError';
    this.successfulServices = successfulServices;
    this.failures = failures;
  }
}

class AgentSessionStageError extends Error {
  stage: AgentSessionStartupFailureStage;
  causeError: unknown;

  constructor(stage: AgentSessionStartupFailureStage, error: unknown) {
    super(error instanceof Error ? error.message : String(error ?? 'Agent session startup failed'));
    this.name = 'AgentSessionStageError';
    this.stage = stage;
    this.causeError = error;
  }
}

function buildSnapshotMapFromEnabledServices(enabledServices: DevModeEnabledService[]): SessionSnapshotMap {
  return Object.fromEntries(enabledServices.map((service) => [String(service.deployId), service.snapshot]));
}

function recordEnabledServicesFromResult(
  result: DevModeEnabledService[],
  enabledDevModeDeployIds: number[],
  devModeSnapshots: SessionSnapshotMap
): void {
  enabledDevModeDeployIds.push(...result.map((service) => service.deployId));
  Object.assign(devModeSnapshots, buildSnapshotMapFromEnabledServices(result));
}

function recordEnabledServicesFromError(
  error: unknown,
  enabledDevModeDeployIds: number[],
  devModeSnapshots: SessionSnapshotMap
): void {
  if (!(error instanceof DevModeBatchEnableError)) {
    return;
  }

  recordEnabledServicesFromResult(error.successfulServices, enabledDevModeDeployIds, devModeSnapshots);
}

async function enableServicesInDevModeParallel(opts: {
  namespace: string;
  pvcName: string;
  services: Array<Pick<SessionService, 'name' | 'deployId' | 'devConfig'> & { resourceName?: string | null }>;
  requiredNodeName?: string;
}): Promise<DevModeEnabledService[]> {
  if (opts.services.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    opts.services.map(async (service): Promise<DevModeEnabledService> => {
      const deploymentName = service.resourceName || service.name;
      const snapshot = await new DevModeManager().enableDevMode({
        namespace: opts.namespace,
        deploymentName,
        serviceName: deploymentName,
        pvcName: opts.pvcName,
        devConfig: service.devConfig,
        requiredNodeName: opts.requiredNodeName,
      });

      return {
        deployId: service.deployId,
        deploymentName,
        serviceName: deploymentName,
        snapshot,
      };
    })
  );

  const successfulServices: DevModeEnabledService[] = [];
  const failures: Array<{ deployId: number; error: unknown }> = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successfulServices.push(result.value);
      return;
    }

    const deployId = opts.services[index]?.deployId;
    failures.push({
      deployId: typeof deployId === 'number' ? deployId : -1,
      error: result.reason,
    });
  });

  if (failures.length > 0) {
    throw new DevModeBatchEnableError(successfulServices, failures);
  }

  return successfulServices;
}

async function resolveAgentPodNodeName(namespace: string, podName: string): Promise<string | null> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const response = await coreApi.readNamespacedPod(podName, namespace);

  return response.body.spec?.nodeName || null;
}

async function resolveSessionAttachmentPlacementPolicy(
  session: Pick<AgentSession, 'keepAttachedServicesOnSessionNode'>
): Promise<boolean> {
  if (typeof session.keepAttachedServicesOnSessionNode === 'boolean') {
    return session.keepAttachedServicesOnSessionNode;
  }

  const agentSessionDefaults = (await GlobalConfigService.getInstance().getConfig('agentSessionDefaults')) as
    | { scheduling?: { keepAttachedServicesOnSessionNode?: boolean | null } }
    | undefined;

  return resolveKeepAttachedServicesOnSessionNode(agentSessionDefaults?.scheduling);
}

function getExecExitCode(status: any): number | null {
  const causes = status?.details?.causes;
  if (Array.isArray(causes)) {
    const exitCodeCause = causes.find((cause) => cause?.reason === 'ExitCode');
    const parsedExitCode = Number.parseInt(exitCodeCause?.message || '', 10);
    if (Number.isFinite(parsedExitCode)) {
      return parsedExitCode;
    }
  }

  if (status?.status === 'Success') {
    return 0;
  }

  return null;
}

async function runCommandInSessionWorkspace(
  namespace: string,
  podName: string,
  command: string,
  container = SESSION_WORKSPACE_GATEWAY_CONTAINER_NAME
): Promise<void> {
  if (!command.trim()) {
    return;
  }

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const exec = new k8s.Exec(kc);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(chunk.toString());
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(chunk.toString());
      callback();
    },
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const settleResolve = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    void exec
      .exec(namespace, podName, container, ['sh', '-lc', command], stdout, stderr, null, false, (status: any) => {
        const exitCode = getExecExitCode(status);
        if (exitCode === 0) {
          settleResolve();
          return;
        }

        const stderrOutput = stderrChunks.join('').trim();
        const stdoutOutput = stdoutChunks.join('').trim();
        const detail =
          stderrOutput || stdoutOutput || status?.message || `Command exited with code ${exitCode ?? 'unknown'}`;
        settleReject(new Error(detail));
      })
      .then((ws) => {
        if (ws && typeof ws.on === 'function') {
          ws.on('error', (error: Error) => {
            settleReject(error);
          });
          ws.on('close', () => {
            if (!settled) {
              settleResolve();
            }
          });
        }
      })
      .catch((error) => {
        settleReject(error as Error);
      });
  });
}

async function resolveTemplatedDevConfigEnvs(
  buildUuid: string | undefined,
  namespace: string,
  services: CreateSessionOptions['services']
): Promise<CreateSessionOptions['services']> {
  if (!buildUuid || !services?.length) {
    return services;
  }

  const hasTemplatedEnv = services.some((service) =>
    Object.values(service.devConfig.env || {}).some((value) => typeof value === 'string' && value.includes('{{'))
  );
  if (!hasTemplatedEnv) {
    return services;
  }

  const build = await Build.query()
    .findOne({ uuid: buildUuid })
    .withGraphFetched('[deploys.[service, deployable], pullRequest]');
  if (!build) {
    throw new Error('Build not found');
  }

  const envResolver = new BuildEnvironmentVariables({
    models: {
      Build,
      Configuration,
    },
  } as unknown as Database);
  const availableEnv = envResolver.cleanup(await envResolver.availableEnvironmentVariablesForBuild(build));
  const useDefaultUUID =
    !Array.isArray(build.enabledFeatures) || !build.enabledFeatures.includes(FeatureFlags.NO_DEFAULT_ENV_RESOLVE);
  const resolvedNamespace = build.namespace || namespace;

  return Promise.all(
    services.map(async (service): Promise<SessionService> => {
      if (!service.devConfig.env) {
        return service;
      }

      return {
        ...service,
        devConfig: {
          ...service.devConfig,
          env: envResolver.parseTemplateData(
            await envResolver.compileEnv(service.devConfig.env, availableEnv, useDefaultUUID, resolvedNamespace)
          ),
        },
      };
    })
  );
}

async function cleanupDevModePatches(
  namespace: string,
  snapshots: SessionSnapshotMap | null | undefined,
  deploys: Deploy[]
): Promise<void> {
  if (deploys.length === 0) {
    return;
  }

  const devModeManager = new DevModeManager();
  for (const deploy of deploys) {
    const deploymentName = deploy.uuid || deploy.deployable?.name || deploy.service?.name;
    if (!deploymentName) {
      continue;
    }

    const serviceName = deploy.uuid || deploy.service?.name || deploymentName;
    const snapshot = getSessionSnapshot(snapshots, deploy.id);
    await devModeManager.disableDevMode(namespace, deploymentName, serviceName, snapshot);
  }
}

async function restoreDevModeDeploys(
  namespace: string,
  snapshots: SessionSnapshotMap | null | undefined,
  deploys: Deploy[]
): Promise<void> {
  if (deploys.length === 0) {
    return;
  }

  // Revert direct dev-mode mutations first so Helm/native deploys do not roll
  // forward from a mixed runtime state.
  await cleanupDevModePatches(namespace, snapshots, deploys);
  await restoreDeploys(deploys);
  await cleanupDevModePatches(namespace, snapshots, deploys);
}

function triggerDevModeDeployRestore(
  namespace: string,
  snapshots: SessionSnapshotMap | null | undefined,
  deploys: Deploy[]
): void {
  if (deploys.length === 0) {
    return;
  }

  // Restore runs in the background after agent teardown so ending a session
  // does not block on workload rollout/readiness.
  void (async () => {
    const deployIds = deploys.map(
      (deploy) => deploy.uuid || deploy.deployable?.name || deploy.service?.name || deploy.id
    );
    const deployList = deployIds.join(',');

    try {
      await restoreDeploys(deploys);
      await cleanupDevModePatches(namespace, snapshots, deploys);
      logger().info(`DevMode: restore complete mode=background namespace=${namespace} deploys=${deployList}`);
    } catch (error) {
      logger().error(
        {
          error,
          namespace,
          deploys: deployIds,
        },
        `DevMode: restore failed mode=background namespace=${namespace} deploys=${deployList}`
      );
    }
  })();
}

async function deleteAgentRuntimeResources(
  namespace: string,
  podName: string,
  apiKeySecretName: string
): Promise<void> {
  await Promise.all([
    deleteSessionWorkspaceService(namespace, podName),
    deleteSessionWorkspacePod(namespace, podName),
    deleteAgentApiKeySecret(namespace, apiKeySecretName),
  ]);
}

async function resolveSessionPrewarmByPvc(buildUuid: string | null, pvcName: string) {
  if (!buildUuid) {
    return null;
  }

  return new AgentPrewarmService().getReadyPrewarmByPvc({
    buildUuid,
    pvcName,
  });
}

async function shouldDeleteSessionPvc(session: Pick<AgentSession, 'id' | 'buildUuid' | 'pvcName'>): Promise<boolean> {
  if (!session.pvcName) {
    return false;
  }

  const runtimePlanPvc = await AgentSandboxService.getLatestRuntimePlanPvcMetadata(session.id);
  if (runtimePlanPvc?.name === session.pvcName) {
    return runtimePlanPvc.ownsPvc;
  }

  const reusablePrewarm = await resolveSessionPrewarmByPvc(session.buildUuid, session.pvcName);
  return !reusablePrewarm;
}

function buildCurrentSessionStatePatch(session: AgentSession): Partial<AgentSession> {
  return {
    status: session.status,
    chatStatus: session.chatStatus,
    workspaceStatus: session.workspaceStatus,
  } as unknown as Partial<AgentSession>;
}

interface SessionRemoteRuntime {
  provider: RemoteWorkspaceRuntimeProvider;
  state: Record<string, unknown>;
}

/** Resolves the remote provider for the session's latest sandbox row; null for the native K8s path. */
async function resolveRemoteRuntimeForSession(session: AgentSession): Promise<SessionRemoteRuntime | null> {
  const sandbox = await AgentSandboxService.getLatestSandboxForSession(session.id);
  const provider = await resolveRemoteRuntimeProviderForSandbox(sandbox);
  if (!sandbox || !provider) {
    return null;
  }

  return { provider, state: sandbox.providerState || {} };
}

async function provisionRemoteWorkspaceRuntime(params: {
  session: AgentSession;
  runtimePlan: WorkspaceRuntimePlan;
  provider: RemoteWorkspaceRuntimeProvider;
  userIdentity?: RequestUserIdentity | null;
  installCommand?: string;
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
  runtimePlanMetadata?: WorkspaceRuntimePlanMetadata;
  expectedLifecycle: { action: WorkspaceRuntimeAction; claimedAt?: string };
  redisTtlSeconds: number;
  namespace: string;
}): Promise<{ podName: string | null; sessionPatch: Partial<AgentSession> }> {
  const { session, runtimePlan, provider } = params;
  const readiness = runtimePlan.runtimeConfig.readiness;

  // Retries must reuse the previous sandbox (it holds the user's workspace) instead of leaking it.
  const existingSandbox = await AgentSandboxService.getLatestSandboxForSession(session.id);
  const reattached =
    existingSandbox?.provider === provider.backendId
      ? await provider.reattach(existingSandbox.providerState, readiness)
      : null;
  let handle = reattached;
  if (!handle) {
    // Fresh runtimes get a fresh gateway bearer token; encrypt up front so a missing
    // ENCRYPTION_KEY fails before any backend resources exist.
    const gatewayToken = mintWorkspaceGatewayToken();
    const encryptedGatewayToken = encryptWorkspaceGatewayToken(gatewayToken);
    const provisioned = await provider.provision({
      plan: runtimePlan,
      readiness,
      userIdentity: params.userIdentity || null,
      installCommand: params.installCommand,
      gatewayToken,
    });
    handle = {
      ...provisioned,
      providerState: { ...provisioned.providerState, gatewayToken: encryptedGatewayToken },
    };
  }
  const podName = handle.podNameAlias ?? session.podName ?? null;
  const sessionPatch = {
    status: 'active',
    chatStatus: AgentChatStatus.READY,
    workspaceStatus: AgentWorkspaceStatus.READY,
    namespace: params.namespace,
    podName,
    pvcName: null,
  } as unknown as Partial<AgentSession>;

  try {
    await WorkspaceRuntimeStateService.recordWorkspaceState(
      session.id,
      {
        sessionPatch,
        sandboxStatus: 'ready',
        runtimeProvider: provider.backendId,
        providerState: handle.providerState,
        capabilitySnapshot: handle.capabilitySnapshot,
        workspaceStorage: params.workspaceStorage,
        runtimePlanMetadata: params.runtimePlanMetadata,
        runtimeLifecycle: null,
      },
      { expectedLifecycle: params.expectedLifecycle }
    );
    const redis = RedisClient.getInstance().getRedis();
    await redis.setex(
      `${SESSION_REDIS_PREFIX}${session.uuid}`,
      params.redisTtlSeconds,
      JSON.stringify({ podName, namespace: params.namespace, status: 'active', provider: provider.backendId })
    );
    await clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {});
  } catch (error) {
    // Destroy the runtime when persistence failed to record this handle's identity. Fresh provisions
    // always leak; a Modal reattach that recreated from a snapshot also leaks because the prior state
    // points at the OLD (dead) sandboxId, not the new one on the handle. E2B/Daytona reattach reconnect
    // the SAME sandboxId the row still references, so they stay alive untouched.
    const handleSandboxId = (handle.providerState as { sandboxId?: unknown }).sandboxId;
    const persistedSandboxId = (existingSandbox?.providerState as { sandboxId?: unknown } | undefined)?.sandboxId;
    if (!reattached || (handleSandboxId && handleSandboxId !== persistedSandboxId)) {
      await provider.destroy(handle.providerState).catch(() => {});
    }
    throw error;
  }

  logger().info(
    `Session: workspace runtime ready sessionId=${session.uuid} backend=${provider.backendId} sandboxId=${podName}`
  );
  return { podName, sessionPatch };
}

async function recordCleanupFailure(
  session: AgentSession,
  error: unknown,
  expectedLifecycle?: { action: 'cleanup'; claimedAt: string }
): Promise<void> {
  const failure = buildWorkspaceRuntimeFailure({
    error,
    stage: 'cleanup',
    origin: 'cleanup',
    retryable: false,
  });
  await WorkspaceRuntimeStateService.recordWorkspaceFailure(
    session.id,
    {
      sessionPatch: {
        workspaceStatus: AgentWorkspaceStatus.FAILED,
      } as unknown as Partial<AgentSession>,
      failure,
    },
    expectedLifecycle ? { expectedLifecycle } : {}
  ).catch(() => {});
}

function isUniqueConstraintError(error: unknown, constraintName: string): boolean {
  const knexError = error as { code?: string; constraint?: string };
  return knexError?.code === '23505' && knexError?.constraint === constraintName;
}

function getRequestedWorkspaceStorageSize(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const workspace = (input as { workspace?: unknown }).workspace;
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return null;
  }

  const storageSize = (workspace as { storageSize?: unknown }).storageSize;
  return typeof storageSize === 'string' && storageSize.trim() ? storageSize.trim() : null;
}

export interface CreateSessionOptions {
  userId: string;
  userIdentity?: RequestUserIdentity;
  githubToken?: string | null;
  buildUuid?: string;
  buildKind?: BuildKind;
  services?: Array<{
    name: string;
    deployId: number;
    devConfig: DevConfig;
    resourceName?: string;
    repo?: string | null;
    branch?: string | null;
    revision?: string | null;
    workspacePath?: string;
    workDir?: string | null;
  }>;
  provider?: string;
  model?: string;
  environmentSkillRefs?: AgentSessionSkillRef[];
  repoUrl?: string;
  branch?: string;
  revision?: string;
  workspaceRepos?: AgentSessionWorkspaceRepo[];
  prNumber?: number;
  namespace: string;
  workspaceImage?: string;
  workspaceEditorImage?: string;
  workspaceGatewayImage?: string;
  nodeSelector?: Record<string, string>;
  keepAttachedServicesOnSessionNode?: boolean;
  readiness?: ResolvedAgentSessionReadinessConfig;
  resources?: ResolvedAgentSessionResources;
  workspaceStorageSize?: string | null;
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
  redisTtlSeconds?: number;
}

export class AgentSessionStartupError extends Error {
  public readonly sessionId: string;
  public readonly buildUuid: string | null;
  public readonly namespace: string;
  public readonly failure: PublicAgentSessionStartupFailure;
  public readonly cause: unknown;

  constructor(params: {
    sessionId: string;
    buildUuid?: string | null;
    namespace: string;
    failure: PublicAgentSessionStartupFailure;
    cause: unknown;
  }) {
    const message = params.cause instanceof Error ? params.cause.message : params.failure.message;
    super(message);
    this.name = 'AgentSessionStartupError';
    this.sessionId = params.sessionId;
    this.buildUuid = params.buildUuid ?? null;
    this.namespace = params.namespace;
    this.failure = params.failure;
    this.cause = params.cause;
  }
}

export interface CreateChatSessionOptions {
  userId: string;
  userIdentity?: RequestUserIdentity;
  model?: string;
}

interface CreateChatRuntimeOptions {
  sessionId: string;
  userId: string;
  userIdentity?: RequestUserIdentity;
  githubToken?: string | null;
  allowedActiveRunUuid?: string | null;
  failureOrigin?: WorkspaceRuntimeFailureOrigin;
  failureStage?: AgentSessionStartupFailureStage;
  failureRetryable?: boolean;
  workspaceAction?: 'provision' | 'retry';
}

async function recordUnpersistedCreateSessionStartupFailure(params: {
  opts: CreateSessionOptions;
  sessionUuid: string;
  buildKind: BuildKind;
  sessionKind: AgentSessionKind;
  failedPatch: Partial<AgentSession>;
  startupFailure: ReturnType<typeof buildAgentSessionStartupFailure>;
  runtimePlan?: WorkspaceRuntimePlan;
  runtimePlanMetadata?: WorkspaceRuntimePlanMetadata;
}): Promise<void> {
  const model = params.runtimePlan?.provider.selection.modelId ?? params.opts.model?.trim() ?? 'unresolved';
  const remoteBackendId = params.runtimePlan ? resolveRemoteBackendIdForPlan(params.runtimePlan) : null;
  const failedSessionPayload = {
    uuid: params.sessionUuid,
    userId: params.opts.userId,
    ownerGithubUsername: params.opts.userIdentity?.githubUsername || null,
    buildUuid: params.opts.buildUuid || null,
    buildKind: params.buildKind,
    sessionKind: params.sessionKind,
    podName: remoteBackendId ? null : params.runtimePlan?.podName ?? null,
    namespace: params.opts.namespace,
    pvcName: remoteBackendId ? null : params.runtimePlan?.prewarm.pvcName ?? null,
    model,
    defaultModel: model,
    defaultHarness: 'lifecycle_ai_sdk',
    ...params.failedPatch,
    devModeSnapshots: {},
    forwardedAgentSecretProviders: params.runtimePlan?.forwardedEnv.secretProviders ?? [],
    workspaceRepos: params.runtimePlan?.servicePlan.workspaceRepos ?? params.opts.workspaceRepos ?? [],
    selectedServices: params.runtimePlan?.servicePlan.selectedServices ?? [],
    skillPlan: params.runtimePlan?.skillPlan ?? EMPTY_AGENT_SESSION_SKILL_PLAN,
    keepAttachedServicesOnSessionNode:
      params.opts.keepAttachedServicesOnSessionNode ??
      params.runtimePlan?.runtimeConfig.keepAttachedServicesOnSessionNode ??
      null,
  } as unknown as Partial<AgentSession>;

  await AgentSession.transaction(async (trx) => {
    const insertedSession = await AgentSession.query(trx).insertAndFetch(failedSessionPayload);
    const failedSession = {
      ...insertedSession,
      ...failedSessionPayload,
    } as AgentSession;

    await AgentSourceService.createSessionSource(failedSession, {
      trx,
      ...(params.runtimePlan?.workspaceStorage ? { workspaceStorage: params.runtimePlan.workspaceStorage } : {}),
      defaultProvider: params.runtimePlan?.provider.selection.provider ?? null,
    });
    await WorkspaceRuntimeStateService.recordWorkspaceFailure(
      failedSession.id,
      {
        sessionPatch: params.failedPatch,
        ...(params.runtimePlan?.workspaceStorage ? { workspaceStorage: params.runtimePlan.workspaceStorage } : {}),
        failure: params.startupFailure,
        ...(params.runtimePlanMetadata ? { runtimePlanMetadata: params.runtimePlanMetadata } : {}),
        ...(remoteBackendId ? { runtimeProvider: remoteBackendId } : {}),
      },
      { trx }
    );
  });
}

export default class AgentSessionService {
  static canAcceptMessages(session: Pick<AgentSession, 'sessionKind' | 'chatStatus' | 'workspaceStatus'>): boolean {
    return canSessionAcceptMessages(session);
  }

  static getMessageBlockReason(
    session: Pick<AgentSession, 'sessionKind' | 'status' | 'chatStatus' | 'workspaceStatus'>
  ): string {
    return getSessionMessageBlockReason(session);
  }

  static async getSessionStartupFailure(sessionId: string): Promise<PublicAgentSessionStartupFailure | null> {
    const redis = RedisClient.getInstance().getRedis();
    const failure = await getAgentSessionStartupFailure(redis, sessionId);

    return failure ? toPublicAgentSessionStartupFailure(failure) : null;
  }

  static async markSessionRuntimeFailure(
    sessionId: string,
    error: unknown,
    stage: AgentSessionStartupFailureStage = 'connect_runtime'
  ): Promise<PublicAgentSessionStartupFailure> {
    const redis = RedisClient.getInstance().getRedis();
    const failure = buildAgentSessionStartupFailure({
      sessionId,
      error,
      stage,
      origin: 'manual_runtime',
    });

    await setAgentSessionStartupFailure(redis, failure).catch(() => {});
    await redis.del(`${SESSION_REDIS_PREFIX}${sessionId}`).catch(() => {});

    const session = await AgentSession.query()
      .findOne({ uuid: sessionId })
      .catch(() => null);
    if (session && (session.status === 'starting' || session.status === 'active')) {
      const failedPatch = {
        status: 'error',
        chatStatus: AgentChatStatus.ERROR,
        workspaceStatus: AgentWorkspaceStatus.FAILED,
      } as unknown as Partial<AgentSession>;
      await WorkspaceRuntimeStateService.recordWorkspaceFailure(session.id, {
        sessionPatch: failedPatch,
        failure,
      }).catch(() => {});
    }

    return toPublicAgentSessionStartupFailure(failure);
  }

  static async enrichSessions(sessions: AgentSession[]): Promise<AgentSessionSummaryRecord[]> {
    if (sessions.length === 0) {
      return [];
    }

    const buildUuids = [...new Set(sessions.map((session) => session.buildUuid).filter(Boolean) as string[])];
    const builds = buildUuids.length
      ? await Build.query()
          .whereIn('uuid', buildUuids)
          .withGraphFetched('[pullRequest.[repository], baseBuild.[pullRequest.[repository]]]')
      : [];
    const buildByUuid = new Map(builds.map((build) => [build.uuid, build]));

    const snapshotDeployIds = [
      ...new Set(
        sessions.flatMap((session) =>
          Object.keys(session.devModeSnapshots || {})
            .map((deployId) => Number(deployId))
            .filter((deployId) => Number.isInteger(deployId))
        )
      ),
    ];

    const liveSessionIds = sessions
      .filter((session) => session.status === 'starting' || session.status === 'active')
      .map((session) => session.id);

    const [liveDeploys, snapshotDeploys] = await Promise.all([
      liveSessionIds.length
        ? Deploy.query().whereIn('devModeSessionId', liveSessionIds).withGraphFetched(SESSION_DEPLOY_GRAPH)
        : Promise.resolve([] as Deploy[]),
      snapshotDeployIds.length
        ? Deploy.query().whereIn('id', snapshotDeployIds).withGraphFetched(SESSION_DEPLOY_GRAPH)
        : Promise.resolve([] as Deploy[]),
    ]);

    const liveDeploysBySessionId = new Map<number, Deploy[]>();
    for (const deploy of liveDeploys) {
      if (!deploy.devModeSessionId) {
        continue;
      }

      const current = liveDeploysBySessionId.get(deploy.devModeSessionId) || [];
      current.push(deploy);
      liveDeploysBySessionId.set(deploy.devModeSessionId, current);
    }

    const snapshotDeployById = new Map(snapshotDeploys.map((deploy) => [deploy.id, deploy]));

    const sessionDatabaseIdByUuid = new Map(sessions.map((session) => [session.uuid, session.id]));
    const enrichedSessions = sessions.map((session) => {
      const build = session.buildUuid ? buildByUuid.get(session.buildUuid) : null;
      const primaryWorkspaceRepo =
        session.workspaceRepos?.find((repo) => repo.primary) || session.workspaceRepos?.[0] || null;
      const primarySelectedService = session.selectedServices?.[0] || null;
      const sessionDeploys =
        liveDeploysBySessionId.get(session.id) ||
        Object.keys(session.devModeSnapshots || {})
          .map((deployId) => snapshotDeployById.get(Number(deployId)))
          .filter((deploy): deploy is Deploy => Boolean(deploy));
      const primaryDeploy = sessionDeploys[0] || null;
      const persistedServices = (session.selectedServices || []).map((service) => service.name).filter(Boolean);
      const liveServices = sessionDeploys
        .map((deploy) => deploy.deployable?.name || deploy.service?.name || null)
        .filter((name): name is string => Boolean(name));
      const services = [...new Set([...(persistedServices || []), ...liveServices])];

      return {
        ...session,
        id: session.uuid,
        uuid: session.uuid,
        baseBuildUuid: build?.baseBuild?.uuid || null,
        primaryRepo:
          primaryWorkspaceRepo?.repo ||
          primarySelectedService?.repo ||
          primaryDeploy?.repository?.fullName ||
          build?.pullRequest?.fullName ||
          build?.pullRequest?.repository?.fullName ||
          build?.baseBuild?.pullRequest?.fullName ||
          build?.baseBuild?.pullRequest?.repository?.fullName ||
          null,
        primaryBranch:
          primaryWorkspaceRepo?.branch ||
          primarySelectedService?.branch ||
          primaryDeploy?.branchName ||
          build?.pullRequest?.branchName ||
          build?.baseBuild?.pullRequest?.branchName ||
          null,
        repo:
          primaryWorkspaceRepo?.repo ||
          primarySelectedService?.repo ||
          primaryDeploy?.repository?.fullName ||
          build?.pullRequest?.fullName ||
          build?.pullRequest?.repository?.fullName ||
          build?.baseBuild?.pullRequest?.fullName ||
          build?.baseBuild?.pullRequest?.repository?.fullName ||
          null,
        branch:
          primaryWorkspaceRepo?.branch ||
          primarySelectedService?.branch ||
          primaryDeploy?.branchName ||
          build?.pullRequest?.branchName ||
          build?.baseBuild?.pullRequest?.branchName ||
          null,
        services,
      } as AgentSessionSummaryRecordBase;
    });

    return attachStartupFailures(enrichedSessions, sessionDatabaseIdByUuid);
  }

  static async getEnvironmentActiveSession(
    buildUuid: string,
    viewerUserId?: string | null
  ): Promise<ActiveEnvironmentSessionSummary | null> {
    const session = await AgentSession.query()
      .where({
        buildUuid,
        buildKind: BuildKind.ENVIRONMENT,
      })
      .whereIn('status', ['starting', 'active'])
      .orderBy('updatedAt', 'desc')
      .orderBy('createdAt', 'desc')
      .first();

    if (!session) {
      return null;
    }

    return {
      id: session.userId === viewerUserId ? session.uuid : null,
      status: session.status,
      ownerGithubUsername: session.ownerGithubUsername,
      ownedByCurrentUser: session.userId === viewerUserId,
    };
  }

  static async createChatSession(opts: CreateChatSessionOptions): Promise<AgentSession> {
    return AgentChatSessionService.createChatSession(opts);
  }

  static async openChatRuntime(opts: CreateChatRuntimeOptions): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: opts.sessionId, userId: opts.userId });
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.sessionKind !== AgentSessionKind.CHAT) {
      throw new Error('Runtime provisioning is only supported for chat sessions');
    }

    if (session.status !== 'active') {
      throw new Error('Only active chat sessions can provision a workspace runtime');
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.READY) {
      if (session.namespace && session.podName) {
        return session;
      }

      throw new Error('Workspace runtime is marked ready but missing runtime references');
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.NONE) {
      return this.provisionChatRuntime({
        ...opts,
        failureRetryable: true,
        workspaceAction: 'provision',
      });
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.FAILED) {
      return this.provisionChatRuntime({
        ...opts,
        failureOrigin: 'chat_runtime',
        failureRetryable: true,
        workspaceAction: 'retry',
      });
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.HIBERNATED) {
      return this.resumeChatRuntime(opts);
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.PROVISIONING) {
      await WorkspaceRuntimeStateService.assertNoActiveWorkspaceAction(session.id);
      throw new Error('Workspace runtime is already provisioning');
    }

    throw new Error('Workspace runtime cannot be opened from the current state');
  }

  static async provisionChatRuntime(opts: CreateChatRuntimeOptions): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: opts.sessionId, userId: opts.userId });
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.sessionKind !== AgentSessionKind.CHAT) {
      throw new Error('Runtime provisioning is only supported for chat sessions');
    }

    if (session.status !== 'active') {
      throw new Error('Only active chat sessions can provision a workspace runtime');
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.PROVISIONING) {
      await WorkspaceRuntimeStateService.assertNoActiveWorkspaceAction(session.id);
      throw new Error('Workspace runtime is already provisioning');
    }

    if (
      session.workspaceStatus === AgentWorkspaceStatus.READY &&
      session.namespace &&
      session.podName &&
      (session.pvcName || (await resolveRemoteRuntimeForSession(session)))
    ) {
      return session;
    }

    const source = await AgentSourceService.getSessionSource(session.id).catch(() => null);
    const chatNamespace = buildChatSessionNamespace(session.uuid);
    const fallbackPodName = buildAgentSessionPodName(session.uuid);
    const fallbackPvcName = `agent-pvc-${session.uuid.slice(0, 8)}`;
    const fallbackApiKeySecretName = `agent-secret-${session.uuid.slice(0, 8)}`;
    const redis = RedisClient.getInstance().getRedis();
    const failureOrigin = opts.failureOrigin || 'chat_runtime';
    let failureStage: AgentSessionStartupFailureStage =
      opts.failureStage || (failureOrigin === 'resume' ? 'resume' : 'prepare_infrastructure');
    const workspaceAction = opts.workspaceAction || (failureOrigin === 'resume' ? 'resume' : 'provision');
    const claimSandboxStatus = failureOrigin === 'resume' ? 'resuming' : 'provisioning';
    const failureRetryable = opts.failureRetryable ?? workspaceAction === 'retry';
    // A resume reuses the persisted PVC; its data must never be deleted on a failed resume.
    const resumeReusesExistingPvc = failureOrigin === 'resume' || Boolean(session.pvcName);
    let namespace = chatNamespace;
    let podName = fallbackPodName;
    let pvcName = fallbackPvcName;
    let apiKeySecretName = fallbackApiKeySecretName;
    let workspaceStorage: ResolvedAgentSessionWorkspaceStorageIntent | undefined;
    let runtimePlanMetadata: ReturnType<typeof toWorkspaceRuntimePlanMetadata> | undefined;
    let resourcesStarted = false;
    let ownsPvc = true;
    let actionClaimedAt: string | undefined;

    try {
      const runtimePlan = await resolveWorkspaceRuntimePlan({
        kind: 'chat',
        sessionUuid: session.uuid,
        namespace: chatNamespace,
        userId: opts.userId,
        userIdentity: opts.userIdentity || null,
        githubToken: opts.githubToken || null,
        buildUuid: null,
        repoUrl: null,
        branch: null,
        revision: null,
        workspaceRepos: session.workspaceRepos || null,
        services: undefined,
        environmentSkillRefs: null,
        provider: null,
        model: session.model || null,
        workspaceStorageSize: getRequestedWorkspaceStorageSize(source?.input),
      });
      runtimePlanMetadata = toWorkspaceRuntimePlanMetadata(runtimePlan);
      namespace = runtimePlan.namespace;
      podName = runtimePlan.podName;
      pvcName = runtimePlan.prewarm.pvcName;
      apiKeySecretName = runtimePlan.apiKeySecretName;
      workspaceStorage = runtimePlan.workspaceStorage;
      ownsPvc = runtimePlan.prewarm.ownsPvc;
      const workspaceRepos = runtimePlan.servicePlan.workspaceRepos;
      const selectedServices = runtimePlan.servicePlan.selectedServices;
      const skillPlan = runtimePlan.skillPlan;
      const runtimeConfig = runtimePlan.runtimeConfig;
      const sessionPodMcpConfigJson = runtimePlan.startupMcp.serializedConfig;
      // Sessions stay on the backend that provisioned them: a kubernetes workspace lives in its
      // PVC, a remote one in its sandbox — flipping the global provider must strand neither.
      const sessionRemoteRuntime = await resolveRemoteRuntimeForSession(session);
      // Honor the row's backend only when it actually provisioned a reattachable handle. A row stamped
      // with a provider at claim time but never provisioned (empty providerState) must fall through to
      // the currently-configured backend, so a failed remote session can retry onto K8s instead of
      // staying permanently pinned to a possibly-broken backend.
      const sessionHasRemoteHandle = Boolean(
        sessionRemoteRuntime && sessionRemoteRuntime.provider.hasPersistedHandle(sessionRemoteRuntime.state)
      );
      const remoteProvider = sessionHasRemoteHandle
        ? sessionRemoteRuntime!.provider
        : !session.pvcName
        ? resolveRemoteRuntimeProviderForPlan(runtimePlan)
        : null;

      const provisioningPatch = {
        namespace,
        podName,
        pvcName: remoteProvider ? null : pvcName,
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        workspaceRepos,
        selectedServices,
        devModeSnapshots: {},
        forwardedAgentSecretProviders: runtimePlan.forwardedEnv.secretProviders,
        skillPlan,
      } as unknown as Partial<AgentSession>;
      actionClaimedAt = new Date().toISOString();
      await WorkspaceRuntimeStateService.claimWorkspaceAction(session.id, {
        action: workspaceAction,
        claimedAt: actionClaimedAt,
        activeActionTimeoutMs: runtimeConfig.cleanup.startingTimeoutMs,
        ...(opts.allowedActiveRunUuid ? { allowedActiveRunUuid: opts.allowedActiveRunUuid } : {}),
        sessionPatch: provisioningPatch,
        sandboxStatus: claimSandboxStatus,
        workspaceStorage,
        runtimePlanMetadata,
        // Always stamp the backend that actually wins this claim. Omitting it on the K8s path leaves a
        // stale remote provider stamp (from a prior failed remote attempt) on the row, which routes
        // suspend/resume/teardown down the remote branch and leaks the K8s namespace/pod/PVC.
        runtimeProvider: remoteProvider ? remoteProvider.backendId : LIFECYCLE_KUBERNETES_PROVIDER,
      });

      if (remoteProvider) {
        if (!opts.failureStage && failureOrigin !== 'resume') {
          failureStage = 'connect_runtime';
        }

        const provisioned = await provisionRemoteWorkspaceRuntime({
          session,
          runtimePlan,
          provider: remoteProvider,
          userIdentity: opts.userIdentity,
          installCommand: buildCombinedInstallCommand(runtimePlan.servicePlan.services),
          workspaceStorage,
          runtimePlanMetadata,
          expectedLifecycle: { action: workspaceAction, claimedAt: actionClaimedAt },
          redisTtlSeconds: runtimeConfig.cleanup.redisTtlSeconds,
          namespace,
        });
        podName = provisioned.podName ?? podName;

        const readySession = await AgentSession.query().findOne({ uuid: session.uuid });
        if (!readySession) {
          throw new Error('Session not found after runtime provisioning');
        }

        return readySession;
      }

      if (session.namespace && session.namespace !== namespace) {
        await deleteNamespace(session.namespace).catch(() => {});
      }

      // Suspend deletes the per-session secret, so resume re-mints a fresh token alongside it.
      // Degrades gracefully on keyless installs (ENCRYPTION_KEY unset → no enforcement, K8s only).
      const { gatewayToken, encryptedGatewayToken } = mintK8sGatewayTokenOrWarn();

      resourcesStarted = true;
      await createOrUpdateNamespace({
        name: namespace,
        buildUUID: session.uuid,
        staticEnv: false,
        ttl: true,
        author: opts.userIdentity?.githubUsername || session.ownerGithubUsername || null,
      });

      const forwardedAgentEnv = await applyForwardedAgentEnvSecrets({
        plan: runtimePlan.forwardedEnv,
        namespace,
        buildUuid: undefined,
      });
      const forwardedPlainAgentEnv = Object.fromEntries(
        Object.entries(forwardedAgentEnv.env).filter(
          ([envKey]) => !forwardedAgentEnv.secretRefs.some((secretRef) => secretRef.envKey === envKey)
        )
      );
      const [, , agentServiceAccountName, useGvisor] = await Promise.all([
        runtimePlan.prewarm.ownsPvc
          ? createAgentPvc(namespace, pvcName, workspaceStorage.storageSize, undefined, workspaceStorage.accessMode)
          : Promise.resolve(),
        createAgentApiKeySecret(
          namespace,
          apiKeySecretName,
          runtimePlan.provider.credentialEnv,
          runtimePlan.credentials.githubToken || undefined,
          undefined,
          forwardedPlainAgentEnv,
          {
            [SESSION_POD_MCP_CONFIG_SECRET_KEY]: sessionPodMcpConfigJson,
            ...(gatewayToken ? { [LIFECYCLE_GATEWAY_TOKEN_ENV]: gatewayToken } : {}),
          }
        ),
        ensureAgentSessionServiceAccount(namespace),
        isGvisorAvailable(),
        createSessionWorkspaceService(namespace, podName),
        ensureAgentNetworkPolicy(namespace),
      ]);

      if (!opts.failureStage && failureOrigin !== 'resume') {
        failureStage = 'connect_runtime';
      }

      await createSessionWorkspacePod({
        podName,
        namespace,
        pvcName,
        workspaceImage: runtimeConfig.workspaceImage,
        workspaceEditorImage: runtimeConfig.workspaceEditorImage,
        workspaceGatewayImage: runtimeConfig.workspaceGatewayImage,
        apiKeySecretName,
        hasGitHubToken: runtimePlan.credentials.hasGitHubToken,
        workspacePath: SESSION_WORKSPACE_ROOT,
        workspaceRepos,
        skillPlan,
        forwardedAgentEnv: forwardedAgentEnv.env,
        forwardedAgentSecretRefs: forwardedAgentEnv.secretRefs,
        forwardedAgentSecretServiceName: forwardedAgentEnv.secretServiceName,
        useGvisor,
        userIdentity: opts.userIdentity,
        nodeSelector: runtimeConfig.nodeSelector,
        readiness: runtimeConfig.readiness,
        serviceAccountName: agentServiceAccountName,
        resources: runtimeConfig.resources,
        skipWorkspaceBootstrap: runtimePlan.prewarm.skipWorkspaceBootstrap,
      });

      await WorkspaceRuntimeStateService.recordWorkspaceState(
        session.id,
        {
          sessionPatch: {
            status: 'active',
            chatStatus: AgentChatStatus.READY,
            workspaceStatus: AgentWorkspaceStatus.READY,
            namespace,
            podName,
            pvcName,
          } as unknown as Partial<AgentSession>,
          sandboxStatus: 'ready',
          providerState: encryptedGatewayToken ? { gatewayToken: encryptedGatewayToken } : {},
          workspaceStorage,
          runtimePlanMetadata,
          runtimeLifecycle: null,
        },
        {
          expectedLifecycle: {
            action: workspaceAction,
            claimedAt: actionClaimedAt,
          },
        }
      );
      await redis.setex(
        `${SESSION_REDIS_PREFIX}${session.uuid}`,
        runtimeConfig.cleanup.redisTtlSeconds,
        JSON.stringify({ podName, namespace, status: 'active' })
      );

      logger().info(`Session: runtime ready sessionId=${session.uuid} namespace=${namespace} podName=${podName}`);

      const readySession = await AgentSession.query().findOne({ uuid: session.uuid });
      if (!readySession) {
        throw new Error('Session not found after runtime provisioning');
      }

      if (failureOrigin === 'resume') {
        await AgentSandboxService.restorePreviewExposures(readySession);
      }

      return readySession;
    } catch (error) {
      if (error instanceof WorkspaceActionBlockedError) {
        throw error;
      }

      logger().warn(
        { error, sessionId: session.uuid, namespace },
        `Session: runtime provision failed sessionId=${session.uuid}`
      );
      const failure = buildWorkspaceRuntimeFailure({
        error,
        stage: failureStage,
        origin: failureOrigin,
        // A failed security verification must never be retried into a ready workspace.
        retryable: error instanceof WorkspaceRuntimeSecurityError ? false : failureRetryable,
      });

      if (!workspaceStorage) {
        workspaceStorage = await resolveAgentSessionRuntimeConfig()
          .then((runtimeConfig) =>
            resolveAgentSessionWorkspaceStorageIntent({
              requestedSize: getRequestedWorkspaceStorageSize(source?.input),
              storage: runtimeConfig.workspaceStorage,
            })
          )
          .catch(() => undefined);
      }

      const cleanupTasks: Array<Promise<unknown>> = [
        redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {}),
      ];
      if (resourcesStarted) {
        cleanupTasks.push(deleteAgentRuntimeResources(namespace, podName, apiKeySecretName).catch(() => {}));
        // Never destroy a resume's persisted PVC/namespace on a transient failure (sr-1).
        if (!resumeReusesExistingPvc) {
          cleanupTasks.push(
            ownsPvc ? deleteAgentPvc(namespace, pvcName).catch(() => {}) : Promise.resolve(),
            deleteNamespace(namespace).catch(() => {})
          );
        }
      }
      await Promise.all(cleanupTasks);

      const failedRuntimeRefs = resourcesStarted
        ? { namespace, podName, pvcName }
        : { namespace: null, podName: null, pvcName: null };
      await WorkspaceRuntimeStateService.recordWorkspaceFailure(
        session.id,
        {
          sessionPatch: {
            status: 'active',
            chatStatus: AgentChatStatus.READY,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            ...failedRuntimeRefs,
            devModeSnapshots: {},
          } as unknown as Partial<AgentSession>,
          workspaceStorage,
          failure,
          runtimePlanMetadata,
        },
        actionClaimedAt
          ? {
              expectedLifecycle: {
                action: workspaceAction,
                claimedAt: actionClaimedAt,
              },
            }
          : {}
      ).catch(() => {});

      throw error;
    }
  }

  static async publishChatHttpPort({
    sessionId,
    userId,
    port,
  }: {
    sessionId: string;
    userId: string;
    port: number;
  }): Promise<{
    url: string;
    host: string | null;
    path: string;
    port: number;
    upstreamHealth?: ChatHttpProbeResult;
  }> {
    const session = await AgentSession.query().findOne({ uuid: sessionId, userId });
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.sessionKind !== AgentSessionKind.CHAT) {
      throw new Error('HTTP publishing is only supported for chat sessions');
    }

    if (session.workspaceStatus !== AgentWorkspaceStatus.READY || !session.namespace || !session.podName) {
      throw new Error('Workspace runtime is not ready yet');
    }

    const gatewayEndpoint = await AgentSandboxService.resolveWorkspaceGatewayEndpoint(session.uuid);
    if (!gatewayEndpoint) {
      throw new Error('Workspace gateway endpoint is not available');
    }

    const endpoint = buildWorkspaceGatewayPreviewEndpoint(gatewayEndpoint, port);
    const upstreamHealth = await verifyWorkspaceHttpEndpoint(endpoint);
    const previewSlug = buildChatPreviewHostSlug({ sessionUuid: session.uuid, port });
    const publicPreview = resolveChatPreviewPublicPublication({ port, previewSlug });
    // SECURITY: never return the raw gateway endpoint to the model — the exposure row stores only the URL; auth is re-resolved per request.
    const publication = {
      ...publicPreview,
      port,
      upstreamHealth,
    };
    await AgentSandboxService.recordPreviewExposure(session, {
      port,
      url: publicPreview.url,
      endpointUrl: endpoint.url,
      attachmentKind: 'workspace_gateway_preview',
      previewSlug,
    });

    logger().info(
      `Session: preview ready sessionId=${session.uuid} namespace=${session.namespace} port=${port} url=${publication.url}`
    );

    return publication;
  }

  static async suspendChatRuntime({ sessionId, userId }: { sessionId: string; userId: string }): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: sessionId, userId });
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.sessionKind !== AgentSessionKind.CHAT) {
      throw new Error('Runtime suspension is only supported for chat sessions');
    }

    if (session.status !== 'active') {
      throw new Error('Only active chat sessions can be suspended');
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.HIBERNATED) {
      return session;
    }

    const derivedBackend = await AgentSandboxService.deriveWorkspaceBackendForAction(session);
    if (derivedBackend.provider) {
      if (session.workspaceStatus !== AgentWorkspaceStatus.READY || !session.namespace || !session.podName) {
        throw new Error('Workspace runtime is not ready');
      }

      const { provider, state } = derivedBackend;
      const runtimeConfig = await resolveAgentSessionRuntimeConfig();
      const redis = RedisClient.getInstance().getRedis();
      const suspendClaimedAt = new Date().toISOString();
      await WorkspaceRuntimeStateService.claimWorkspaceAction(session.id, {
        action: 'suspend',
        claimedAt: suspendClaimedAt,
        sessionPatch: {
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.READY,
        } as unknown as Partial<AgentSession>,
        sandboxStatus: 'suspending',
        runtimeProvider: provider.backendId,
      });

      let suspendedHandle: RemoteRuntimeHandle | undefined;
      try {
        // Keep the suspended sandbox alive for the whole hibernated retention window plus reaper slack.
        suspendedHandle =
          (await provider.suspend(state, {
            retainForMs: runtimeConfig.cleanup.hibernatedRetentionMs + 60 * 60 * 1000,
          })) || undefined;
      } catch (error) {
        const failure = buildWorkspaceRuntimeFailure({
          error,
          stage: 'suspend',
          origin: 'suspend',
          retryable: false,
        });
        await WorkspaceRuntimeStateService.recordWorkspaceFailure(
          session.id,
          {
            sessionPatch: {
              workspaceStatus: AgentWorkspaceStatus.FAILED,
            } as unknown as Partial<AgentSession>,
            failure,
            runtimeProvider: provider.backendId,
            providerState: state,
          },
          {
            expectedLifecycle: {
              action: 'suspend',
              claimedAt: suspendClaimedAt,
            },
          }
        ).catch(() => {});
        throw error;
      }

      await Promise.all([
        redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {}),
        clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {}),
      ]);

      const { session: suspendedSession } = await WorkspaceRuntimeStateService.recordWorkspaceState(
        session.id,
        {
          sessionPatch: {
            status: 'active',
            chatStatus: AgentChatStatus.READY,
            workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
            podName: session.podName,
            pvcName: null,
          } as unknown as Partial<AgentSession>,
          sandboxStatus: 'suspended',
          runtimeProvider: provider.backendId,
          providerState: suspendedHandle?.providerState ?? state,
          capabilitySnapshot: suspendedHandle?.capabilitySnapshot ?? provider.capabilities(state),
          runtimeLifecycle: null,
        },
        {
          expectedLifecycle: {
            action: 'suspend',
            claimedAt: suspendClaimedAt,
          },
        }
      );

      logger().info(
        `Session: workspace runtime suspended sessionId=${session.uuid} backend=${provider.backendId} sandboxId=${session.podName}`
      );
      return suspendedSession;
    }

    if (
      session.workspaceStatus !== AgentWorkspaceStatus.READY ||
      !session.namespace ||
      !session.podName ||
      !session.pvcName
    ) {
      throw new Error('Workspace runtime is not ready');
    }

    const redis = RedisClient.getInstance().getRedis();
    const apiKeySecretName = `agent-secret-${session.uuid.slice(0, 8)}`;
    const suspendClaimedAt = new Date().toISOString();
    // sr-3: capture the live pod before the claim nulls podName, so a crash mid-suspend never leaves a dead URL.
    const namespace = session.namespace;
    const podName = session.podName;
    await WorkspaceRuntimeStateService.claimWorkspaceAction(session.id, {
      action: 'suspend',
      claimedAt: suspendClaimedAt,
      sessionPatch: {
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        podName: null,
      } as unknown as Partial<AgentSession>,
      sandboxStatus: 'suspending',
      // The winning backend restamps the row so a stale remote stamp self-heals.
      runtimeProvider: LIFECYCLE_KUBERNETES_PROVIDER,
    });
    try {
      await deleteAgentRuntimeResources(namespace, podName, apiKeySecretName);
    } catch (error) {
      const failure = buildWorkspaceRuntimeFailure({
        error,
        stage: 'suspend',
        origin: 'suspend',
        retryable: false,
      });
      await WorkspaceRuntimeStateService.recordWorkspaceFailure(
        session.id,
        {
          sessionPatch: {
            workspaceStatus: AgentWorkspaceStatus.FAILED,
          } as unknown as Partial<AgentSession>,
          failure,
        },
        {
          expectedLifecycle: {
            action: 'suspend',
            claimedAt: suspendClaimedAt,
          },
        }
      ).catch(() => {});
      throw error;
    }

    await Promise.all([
      redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {}),
      clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {}),
    ]);

    const { session: suspendedSession } = await WorkspaceRuntimeStateService.recordWorkspaceState(
      session.id,
      {
        sessionPatch: {
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
          podName: null,
        } as unknown as Partial<AgentSession>,
        sandboxStatus: 'suspended',
        runtimeLifecycle: null,
      },
      {
        expectedLifecycle: {
          action: 'suspend',
          claimedAt: suspendClaimedAt,
        },
      }
    );

    logger().info(`Session: runtime suspended sessionId=${session.uuid} namespace=${session.namespace}`);
    return suspendedSession;
  }

  /**
   * Settles a chat session whose READY workspace no longer exists (namespace TTL-reaped, pod evicted,
   * remote sandbox expired outside a lifecycle action). Fail-safe: only a runtime-confirmed NotFound
   * transitions state — an inconclusive probe leaves the session untouched. A recoverable loss demotes
   * to HIBERNATED so the existing resume lane restores data (PVC / provider snapshot) or falls through
   * to a fresh provision; a fully reaped Kubernetes workspace releases to NONE.
   */
  static async reconcileLostChatWorkspaceRuntime(
    sessionId: string,
    opts: { allowedActiveRunUuid?: string | null } = {}
  ): Promise<AgentSession | null> {
    const session = await AgentSession.query().findOne({ uuid: sessionId });
    if (
      !session ||
      session.sessionKind !== AgentSessionKind.CHAT ||
      session.status !== 'active' ||
      session.workspaceStatus !== AgentWorkspaceStatus.READY ||
      !session.namespace ||
      !session.podName
    ) {
      return null;
    }

    let loss: 'runtime' | 'workspace' | null = null;
    let derivedBackend: Awaited<ReturnType<typeof AgentSandboxService.deriveWorkspaceBackendForAction>>;
    try {
      derivedBackend = await AgentSandboxService.deriveWorkspaceBackendForAction(session);
      if (derivedBackend.provider) {
        const runtimeConfig = await resolveAgentSessionRuntimeConfig();
        const handle = await derivedBackend.provider.reattach(derivedBackend.state, runtimeConfig.readiness);
        loss = handle ? null : 'runtime';
      } else {
        const presence = await probeWorkspacePodPresence(session.namespace, session.podName);
        loss = presence === 'namespace_missing' ? 'workspace' : presence === 'pod_missing' ? 'runtime' : null;
      }
    } catch (error) {
      logger().warn({ error, sessionId }, `Session: workspace loss probe inconclusive sessionId=${sessionId}`);
      return null;
    }

    if (!loss) {
      return null;
    }

    try {
      if (loss === 'workspace') {
        await this.releaseWorkspace(sessionId, { allowedActiveRunUuid: opts.allowedActiveRunUuid ?? null });
        logger().info(`Session: lost workspace released sessionId=${sessionId} namespace=${session.namespace}`);
        return AgentSession.query().findOne({ uuid: sessionId });
      }

      // Remote rows keep podName (the sandbox-id alias resume reads); Kubernetes clears it — the pod is gone.
      const podNamePatch = derivedBackend.provider ? session.podName : null;
      const claimedAt = new Date().toISOString();
      await WorkspaceRuntimeStateService.claimWorkspaceAction(session.id, {
        action: 'suspend',
        claimedAt,
        ...(opts.allowedActiveRunUuid ? { allowedActiveRunUuid: opts.allowedActiveRunUuid } : {}),
        sessionPatch: {
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.READY,
          podName: podNamePatch,
        } as unknown as Partial<AgentSession>,
        sandboxStatus: 'suspending',
        runtimeProvider: derivedBackend.backendId,
      });
      const { session: settled } = await WorkspaceRuntimeStateService.recordWorkspaceState(
        session.id,
        {
          sessionPatch: {
            status: 'active',
            chatStatus: AgentChatStatus.READY,
            workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
            podName: podNamePatch,
          } as unknown as Partial<AgentSession>,
          sandboxStatus: 'suspended',
          runtimeLifecycle: null,
        },
        { expectedLifecycle: { action: 'suspend', claimedAt } }
      );
      const redis = RedisClient.getInstance().getRedis();
      await redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {});
      logger().info(
        `Session: lost workspace runtime hibernated for recovery sessionId=${sessionId} backend=${derivedBackend.backendId} podName=${session.podName}`
      );
      return settled;
    } catch (error) {
      if (error instanceof WorkspaceActionBlockedError) {
        logger().info(`Session: workspace loss reconcile skipped sessionId=${sessionId} reason=${error.reason}`);
        return null;
      }
      logger().warn({ error, sessionId }, `Session: workspace loss reconcile failed sessionId=${sessionId}`);
      return null;
    }
  }

  static async resumeChatRuntime(opts: CreateChatRuntimeOptions): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: opts.sessionId, userId: opts.userId });
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.sessionKind !== AgentSessionKind.CHAT) {
      throw new Error('Runtime provisioning is only supported for chat sessions');
    }

    if (session.status !== 'active') {
      throw new Error('Only active chat sessions can provision a workspace runtime');
    }

    if (session.workspaceStatus !== AgentWorkspaceStatus.HIBERNATED) {
      await WorkspaceRuntimeStateService.assertNoActiveWorkspaceAction(session.id);
      throw new Error('Workspace runtime can only be resumed from hibernated state');
    }

    const remoteRuntime = await resolveRemoteRuntimeForSession(session);
    if (remoteRuntime) {
      const { provider, state } = remoteRuntime;
      const runtimeConfig = await resolveAgentSessionRuntimeConfig();
      const redis = RedisClient.getInstance().getRedis();
      const resumeClaimedAt = new Date().toISOString();
      await WorkspaceRuntimeStateService.claimWorkspaceAction(session.id, {
        action: 'resume',
        claimedAt: resumeClaimedAt,
        activeActionTimeoutMs: runtimeConfig.cleanup.startingTimeoutMs,
        ...(opts.allowedActiveRunUuid ? { allowedActiveRunUuid: opts.allowedActiveRunUuid } : {}),
        sessionPatch: {
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
          podName: session.podName,
          pvcName: null,
        } as unknown as Partial<AgentSession>,
        sandboxStatus: 'resuming',
        runtimeProvider: provider.backendId,
        providerState: state,
      });

      let handle: RemoteRuntimeHandle | undefined;
      try {
        handle = await provider.resume(state, runtimeConfig.readiness);
        const podName = handle.podNameAlias ?? session.podName;
        const { session: resumedSession } = await WorkspaceRuntimeStateService.recordWorkspaceState(
          session.id,
          {
            sessionPatch: {
              status: 'active',
              chatStatus: AgentChatStatus.READY,
              workspaceStatus: AgentWorkspaceStatus.READY,
              namespace: session.namespace,
              podName,
              pvcName: null,
            } as unknown as Partial<AgentSession>,
            sandboxStatus: 'ready',
            runtimeProvider: provider.backendId,
            providerState: handle.providerState,
            capabilitySnapshot: handle.capabilitySnapshot,
            runtimeLifecycle: null,
          },
          {
            expectedLifecycle: {
              action: 'resume',
              claimedAt: resumeClaimedAt,
            },
          }
        );
        await redis.setex(
          `${SESSION_REDIS_PREFIX}${session.uuid}`,
          runtimeConfig.cleanup.redisTtlSeconds,
          JSON.stringify({ podName, namespace: session.namespace, status: 'active', provider: provider.backendId })
        );
        await clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {});
        const restoredPreviewCount = await AgentSandboxService.restorePreviewExposures(resumedSession);

        logger().info(
          `Session: workspace runtime resumed sessionId=${session.uuid} backend=${provider.backendId} sandboxId=${podName} restoredPreviews=${restoredPreviewCount}`
        );
        return resumedSession;
      } catch (error) {
        // A Modal resume recreates the sandbox from its snapshot; if resume succeeded but persistence
        // failed (e.g. the claim was superseded), the new sandbox leaks because the row still points at
        // the old sandboxId. Destroy the handle's runtime when its identity differs from the persisted state.
        const handleSandboxId = (handle?.providerState as { sandboxId?: unknown } | undefined)?.sandboxId;
        const persistedSandboxId = (state as { sandboxId?: unknown }).sandboxId;
        if (handle && handleSandboxId && handleSandboxId !== persistedSandboxId) {
          await provider.destroy(handle.providerState).catch(() => {});
        }
        // An expired runtime cannot be resumed: settle the workspace as gone and provision a fresh
        // one in the same call, so a message to a long-idle session just works instead of failing.
        if (error instanceof WorkspaceRuntimeGoneError) {
          await WorkspaceRuntimeStateService.recordWorkspaceState(
            session.id,
            {
              sessionPatch: {
                status: 'active',
                chatStatus: AgentChatStatus.READY,
                workspaceStatus: AgentWorkspaceStatus.NONE,
                podName: null,
                pvcName: null,
              } as unknown as Partial<AgentSession>,
              sandboxStatus: 'ended',
              runtimeProvider: provider.backendId,
              runtimeLifecycle: null,
            },
            { expectedLifecycle: { action: 'resume', claimedAt: resumeClaimedAt } }
          );
          await redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {});
          logger().info(
            `Session: expired workspace released, provisioning fresh sessionId=${session.uuid} backend=${provider.backendId}`
          );
          return this.provisionChatRuntime({
            ...opts,
            failureOrigin: 'chat_runtime',
            failureStage: 'prepare_infrastructure',
            failureRetryable: true,
            workspaceAction: 'provision',
          });
        }
        const securityBlocked = error instanceof WorkspaceRuntimeSecurityError;
        const failure = buildWorkspaceRuntimeFailure({
          error,
          stage: 'resume',
          origin: 'resume',
          retryable: !securityBlocked,
        });
        await WorkspaceRuntimeStateService.recordWorkspaceFailure(
          session.id,
          {
            sessionPatch: {
              workspaceStatus: AgentWorkspaceStatus.FAILED,
            } as unknown as Partial<AgentSession>,
            failure,
            runtimeProvider: provider.backendId,
            providerState: state,
          },
          {
            expectedLifecycle: {
              action: 'resume',
              claimedAt: resumeClaimedAt,
            },
          }
        ).catch(() => {});
        await redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {});
        throw error;
      }
    }

    return this.provisionChatRuntime({
      ...opts,
      failureOrigin: 'resume',
      failureStage: 'resume',
      // Resume failures are retryable: the PVC persists (sr-1), so FAILED→retry recovers it.
      failureRetryable: true,
    });
  }

  static async createSession(opts: CreateSessionOptions) {
    const sessionStartedAt = Date.now();
    const sessionUuid = uuid();
    const buildKind = opts.buildKind || BuildKind.ENVIRONMENT;
    const sessionKind = resolveSessionKindFromBuildKind(buildKind);
    const devModeSnapshots: SessionSnapshotMap = {};
    const enabledDevModeDeployIds: number[] = [];
    const persistedDevModeDeployIds: number[] = [];
    let pendingEnabledServicesPromise: Promise<DevModeEnabledService[]> | null = null;
    let pendingWorkspacePodReadyPromise: Promise<k8s.V1Pod> | null = null;
    let failureStage: AgentSessionStartupFailureStage = 'create_session';
    let sessionPersisted = false;
    let session: AgentSession | null = null;
    const redis = RedisClient.getInstance().getRedis();
    const preflightStartedAt = Date.now();
    let runtimePlan: WorkspaceRuntimePlan;
    try {
      const templatedServices = await resolveTemplatedDevConfigEnvs(opts.buildUuid, opts.namespace, opts.services);
      runtimePlan = await resolveWorkspaceRuntimePlan({
        kind: sessionKind === AgentSessionKind.SANDBOX ? 'sandbox' : 'environment',
        sessionUuid,
        namespace: opts.namespace,
        userId: opts.userId,
        userIdentity: opts.userIdentity || null,
        githubToken: opts.githubToken || null,
        buildUuid: opts.buildUuid || null,
        repoUrl: opts.repoUrl || null,
        branch: opts.branch || null,
        revision: opts.revision || null,
        workspaceRepos: opts.workspaceRepos || null,
        services: templatedServices,
        environmentSkillRefs: opts.environmentSkillRefs || null,
        provider: opts.provider || null,
        model: opts.model || null,
        workspaceStorageSize: opts.workspaceStorageSize ?? opts.workspaceStorage?.requestedSize ?? null,
      });
    } catch (err) {
      const startupFailure = buildAgentSessionStartupFailure({
        sessionId: sessionUuid,
        error: err,
        stage: 'create_session',
        origin: sessionKind === AgentSessionKind.SANDBOX ? 'sandbox_launch' : 'agent_session',
      });
      logger().error(
        { error: err, sessionId: sessionUuid, failureStage: 'create_session' },
        `Session: startup failed sessionId=${sessionUuid} stage=create_session`
      );
      await setAgentSessionStartupFailure(redis, startupFailure).catch(() => {});
      const failedPatch = {
        status: 'error',
        chatStatus: AgentChatStatus.ERROR,
        workspaceStatus: AgentWorkspaceStatus.FAILED,
      } as unknown as Partial<AgentSession>;
      let startupFailurePersisted = false;
      try {
        await recordUnpersistedCreateSessionStartupFailure({
          opts,
          sessionUuid,
          buildKind,
          sessionKind,
          failedPatch,
          startupFailure,
        });
        startupFailurePersisted = true;
      } catch (persistenceError) {
        logger().warn(
          { error: persistenceError, sessionId: sessionUuid },
          `Session: failure persistence failed sessionId=${sessionUuid}`
        );
      }
      if (startupFailurePersisted) {
        throw new AgentSessionStartupError({
          sessionId: sessionUuid,
          buildUuid: opts.buildUuid ?? null,
          namespace: opts.namespace,
          failure: startupFailure,
          cause: err,
        });
      }
      throw err;
    }
    const runtimePlanMetadata = toWorkspaceRuntimePlanMetadata(runtimePlan);
    const podName = runtimePlan.podName;
    const apiKeySecretName = runtimePlan.apiKeySecretName;
    const workspaceStorage = runtimePlan.workspaceStorage;
    const workspaceRepos = runtimePlan.servicePlan.workspaceRepos;
    const resolvedServices = runtimePlan.servicePlan.services;
    const selectedServices = runtimePlan.servicePlan.selectedServices;
    const skillPlan = runtimePlan.skillPlan;
    const primaryWorkspaceRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0];
    const resolvedModelId = runtimePlan.provider.selection.modelId;
    const resolvedServiceNames = (resolvedServices || []).map((service) => service.name);
    const sessionPodMcpConfigJson = runtimePlan.startupMcp.serializedConfig;
    const pvcName = runtimePlan.prewarm.pvcName;
    const startupActionClaimedAt = new Date().toISOString();
    let forwardedAgentEnv = runtimePlan.forwardedEnv;
    const redisTtlSeconds = opts.redisTtlSeconds ?? runtimePlan.runtimeConfig.cleanup.redisTtlSeconds;
    const preflightMs = elapsedMs(preflightStartedAt);
    const remoteProvider = resolveRemoteRuntimeProviderForPlan(runtimePlan);

    logger().info(
      `Session: starting sessionId=${sessionUuid} buildKind=${buildKind} namespace=${opts.namespace} buildUuid=${
        opts.buildUuid || 'none'
      } services=${resolvedServiceNames.join(',') || 'none'} prewarm=${
        runtimePlan.prewarm.compatiblePrewarm ? 'reused' : 'new'
      } preflightMs=${preflightMs}`
    );

    try {
      if (remoteProvider && (resolvedServices || []).length > 0) {
        assertBackendCapabilities(remoteProvider.backendId, ['environmentSessions', 'developWorkspaces']);
      }

      const keepAttachedServicesOnSessionNode =
        opts.keepAttachedServicesOnSessionNode ?? runtimePlan.runtimeConfig.keepAttachedServicesOnSessionNode;

      session = await AgentSession.transaction(async (trx) => {
        const createdSession = await AgentSession.query(trx).insertAndFetch({
          uuid: sessionUuid,
          buildUuid: opts.buildUuid || null,
          buildKind,
          sessionKind,
          userId: opts.userId,
          ownerGithubUsername: opts.userIdentity?.githubUsername || null,
          podName,
          namespace: opts.namespace,
          pvcName: remoteProvider ? null : pvcName,
          model: resolvedModelId,
          defaultModel: resolvedModelId,
          defaultHarness: 'lifecycle_ai_sdk',
          status: 'starting',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
          keepAttachedServicesOnSessionNode,
          devModeSnapshots,
          forwardedAgentSecretProviders: forwardedAgentEnv.secretProviders,
          workspaceRepos,
          selectedServices,
          skillPlan,
        } as unknown as Partial<AgentSession>);

        await AgentSourceService.createSessionSource(createdSession, {
          trx,
          workspaceStorage,
          defaultProvider: runtimePlan.provider.selection.provider,
        });
        await WorkspaceRuntimeStateService.recordWorkspaceState(
          createdSession.id,
          {
            sessionPatch: {
              workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
            } as unknown as Partial<AgentSession>,
            sandboxStatus: 'provisioning',
            workspaceStorage,
            runtimePlanMetadata,
            ...(remoteProvider ? { runtimeProvider: remoteProvider.backendId } : {}),
            runtimeLifecycle: {
              currentAction: 'provision',
              claimedAt: startupActionClaimedAt,
            },
          },
          { trx }
        );
        return createdSession;
      });
      sessionPersisted = true;

      const combinedInstallCommand = buildCombinedInstallCommand(resolvedServices);
      if (remoteProvider) {
        failureStage = 'connect_runtime';
        const provisioned = await provisionRemoteWorkspaceRuntime({
          session,
          runtimePlan,
          provider: remoteProvider,
          userIdentity: opts.userIdentity,
          installCommand: combinedInstallCommand,
          workspaceStorage,
          runtimePlanMetadata,
          expectedLifecycle: { action: 'provision', claimedAt: startupActionClaimedAt },
          redisTtlSeconds,
          namespace: opts.namespace,
        });

        session = {
          ...session,
          ...provisioned.sessionPatch,
        } as AgentSession;

        logger().info(
          `Session: workspace ready sessionId=${sessionUuid} backend=${remoteProvider.backendId} sandboxId=${
            provisioned.podName
          } durationMs=${elapsedMs(sessionStartedAt)} preflightMs=${preflightMs}`
        );

        warmDefaultThread(session.uuid, opts.userId);

        return session!;
      }

      const infraSetupStartedAt = Date.now();
      failureStage = 'prepare_infrastructure';
      // Degrades gracefully on keyless installs (ENCRYPTION_KEY unset → no enforcement, K8s only).
      const { gatewayToken, encryptedGatewayToken } = mintK8sGatewayTokenOrWarn();
      if (runtimePlan.prewarm.ownsPvc) {
        await createAgentPvc(
          opts.namespace,
          pvcName,
          workspaceStorage.storageSize,
          opts.buildUuid,
          workspaceStorage.accessMode
        );
      }
      forwardedAgentEnv = await applyForwardedAgentEnvSecrets({
        plan: runtimePlan.forwardedEnv,
        namespace: opts.namespace,
        buildUuid: opts.buildUuid,
      });
      const forwardedPlainAgentEnv = Object.fromEntries(
        Object.entries(forwardedAgentEnv.env).filter(
          ([envKey]) => !forwardedAgentEnv.secretRefs.some((secretRef) => secretRef.envKey === envKey)
        )
      );
      const [, agentServiceAccountName, useGvisor] = await Promise.all([
        createAgentApiKeySecret(
          opts.namespace,
          apiKeySecretName,
          runtimePlan.provider.credentialEnv,
          runtimePlan.credentials.githubToken || undefined,
          opts.buildUuid,
          forwardedPlainAgentEnv,
          {
            [SESSION_POD_MCP_CONFIG_SECRET_KEY]: sessionPodMcpConfigJson,
            ...(gatewayToken ? { [LIFECYCLE_GATEWAY_TOKEN_ENV]: gatewayToken } : {}),
          }
        ),
        ensureAgentSessionServiceAccount(opts.namespace),
        isGvisorAvailable(),
        createSessionWorkspaceService(opts.namespace, podName, opts.buildUuid),
        ensureAgentNetworkPolicy(opts.namespace),
      ]);
      const infraSetupMs = elapsedMs(infraSetupStartedAt);

      failureStage = 'connect_runtime';
      const servicesToEnable = resolvedServices || [];
      const readiness = opts.readiness ?? runtimePlan.runtimeConfig.readiness;
      const resources = opts.resources ?? runtimePlan.runtimeConfig.resources;
      const workspacePodOptions = {
        podName,
        namespace: opts.namespace,
        pvcName,
        workspaceImage: opts.workspaceImage ?? runtimePlan.runtimeConfig.workspaceImage,
        workspaceEditorImage: opts.workspaceEditorImage ?? runtimePlan.runtimeConfig.workspaceEditorImage,
        workspaceGatewayImage: opts.workspaceGatewayImage ?? runtimePlan.runtimeConfig.workspaceGatewayImage,
        apiKeySecretName,
        hasGitHubToken: runtimePlan.credentials.hasGitHubToken,
        repoUrl: primaryWorkspaceRepo?.repoUrl,
        branch: primaryWorkspaceRepo?.branch,
        revision: primaryWorkspaceRepo?.revision || undefined,
        workspacePath: SESSION_WORKSPACE_ROOT,
        workspaceRepos,
        skillPlan,
        installCommand: combinedInstallCommand,
        forwardedAgentEnv: forwardedAgentEnv.env,
        forwardedAgentSecretRefs: forwardedAgentEnv.secretRefs,
        forwardedAgentSecretServiceName: forwardedAgentEnv.secretServiceName,
        useGvisor,
        buildUuid: opts.buildUuid,
        userIdentity: opts.userIdentity,
        nodeSelector: opts.nodeSelector ?? runtimePlan.runtimeConfig.nodeSelector,
        readiness,
        skipWorkspaceBootstrap: runtimePlan.prewarm.skipWorkspaceBootstrap,
        serviceAccountName: agentServiceAccountName,
        resources,
      };
      const startEnabledServices = (requiredNodeName?: string): Promise<DevModeEnabledService[]> =>
        enableServicesInDevModeParallel({
          namespace: opts.namespace,
          pvcName,
          services: servicesToEnable,
          requiredNodeName,
        })
          .then((enabledServices) => {
            recordEnabledServicesFromResult(enabledServices, enabledDevModeDeployIds, devModeSnapshots);
            return enabledServices;
          })
          .catch((error) => {
            recordEnabledServicesFromError(error, enabledDevModeDeployIds, devModeSnapshots);
            throw new AgentSessionStageError('attach_services', error);
          });
      const podStartupStartedAt = Date.now();
      let enabledServices: DevModeEnabledService[];
      const shouldOverlapPrewarmServiceAttach = Boolean(
        runtimePlan.prewarm.compatiblePrewarm && servicesToEnable.length > 0
      );

      if (shouldOverlapPrewarmServiceAttach) {
        logger().info(
          `Session: overlap start sessionId=${sessionUuid} namespace=${opts.namespace} podName=${podName} sameNode=${
            keepAttachedServicesOnSessionNode ? 'true' : 'false'
          } services=${resolvedServiceNames.join(',')}`
        );

        await createSessionWorkspacePodWithoutWaiting(workspacePodOptions);
        pendingWorkspacePodReadyPromise = waitForSessionWorkspacePodReady(opts.namespace, podName, readiness).catch(
          (error) => {
            throw new AgentSessionStageError('connect_runtime', error);
          }
        );

        if (keepAttachedServicesOnSessionNode) {
          const scheduledPod = await waitForSessionWorkspacePodScheduled(opts.namespace, podName, readiness).catch(
            (error) => {
              throw new AgentSessionStageError('connect_runtime', error);
            }
          );
          const agentNodeName = scheduledPod.spec?.nodeName || null;

          if (!agentNodeName) {
            throw new AgentSessionStageError(
              'connect_runtime',
              new Error(`Session workspace pod ${podName} did not report a scheduled node`)
            );
          }

          pendingEnabledServicesPromise = startEnabledServices(agentNodeName);
        } else {
          pendingEnabledServicesPromise = startEnabledServices();
        }

        [, enabledServices] = await Promise.all([pendingWorkspacePodReadyPromise, pendingEnabledServicesPromise]);
      } else {
        const workspacePod = await createSessionWorkspacePod(workspacePodOptions);
        const agentNodeName = workspacePod.spec?.nodeName || null;

        if (servicesToEnable.length > 0 && keepAttachedServicesOnSessionNode && !agentNodeName) {
          throw new Error(`Session workspace pod ${podName} did not report a scheduled node`);
        }

        enabledServices = await startEnabledServices(
          keepAttachedServicesOnSessionNode ? agentNodeName || undefined : undefined
        );
      }

      const podStartupMs = elapsedMs(podStartupStartedAt);

      if (enabledServices.length > 0) {
        await AgentSession.query()
          .findById(session.id)
          .patch({
            devModeSnapshots,
          } as unknown as Partial<AgentSession>);
      }

      await Promise.all(
        enabledServices.map((service) =>
          Deploy.query().findById(service.deployId).patch({
            devMode: true,
            devModeSessionId: session!.id,
          })
        )
      );
      persistedDevModeDeployIds.push(...enabledServices.map((service) => service.deployId));

      const finalizeStartedAt = Date.now();
      const readyPatch = {
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
      } as unknown as Partial<AgentSession>;
      await WorkspaceRuntimeStateService.recordWorkspaceState(
        session.id,
        {
          sessionPatch: readyPatch,
          sandboxStatus: 'ready',
          providerState: encryptedGatewayToken ? { gatewayToken: encryptedGatewayToken } : {},
          workspaceStorage,
          runtimePlanMetadata,
          runtimeLifecycle: null,
        },
        {
          expectedLifecycle: {
            action: 'provision',
            claimedAt: startupActionClaimedAt,
          },
        }
      );
      await redis.setex(
        `${SESSION_REDIS_PREFIX}${sessionUuid}`,
        redisTtlSeconds,
        JSON.stringify({ podName, namespace: opts.namespace, status: 'active' })
      );
      const finalizeMs = elapsedMs(finalizeStartedAt);

      session = {
        ...session,
        ...readyPatch,
      } as AgentSession;

      await clearAgentSessionStartupFailure(redis, sessionUuid).catch(() => {});

      logger().info(
        `Session: ready sessionId=${sessionUuid} namespace=${opts.namespace} podName=${podName} services=${
          resolvedServiceNames.join(',') || 'none'
        } prewarm=${runtimePlan.prewarm.compatiblePrewarm ? 'reused' : 'new'} durationMs=${elapsedMs(
          sessionStartedAt
        )} preflightMs=${preflightMs} infraMs=${infraSetupMs} podMs=${podStartupMs} finalizeMs=${finalizeMs} overlap=${
          shouldOverlapPrewarmServiceAttach ? 'true' : 'false'
        }`
      );

      warmDefaultThread(session.uuid, opts.userId);

      return session!;
    } catch (err) {
      if (pendingWorkspacePodReadyPromise) {
        void pendingWorkspacePodReadyPromise.catch(() => {});
      }

      if (pendingEnabledServicesPromise) {
        await pendingEnabledServicesPromise.catch(() => {});
      }

      const startupError = err instanceof AgentSessionStageError ? err.causeError : err;
      failureStage = err instanceof AgentSessionStageError ? err.stage : failureStage;
      const startupFailure = buildAgentSessionStartupFailure({
        sessionId: sessionUuid,
        error: startupError,
        stage: failureStage,
        origin: sessionKind === AgentSessionKind.SANDBOX ? 'sandbox_launch' : 'agent_session',
      });

      if (
        buildKind === BuildKind.ENVIRONMENT &&
        opts.buildUuid &&
        isUniqueConstraintError(startupError, ACTIVE_ENVIRONMENT_SESSION_UNIQUE_INDEX)
      ) {
        const activeSession = await AgentSessionService.getEnvironmentActiveSession(opts.buildUuid, opts.userId);
        if (activeSession) {
          throw new ActiveEnvironmentSessionError(activeSession);
        }
      }

      logger().error(
        { error: startupError, sessionId: sessionUuid, failureStage },
        `Session: startup failed sessionId=${sessionUuid} stage=${failureStage}`
      );

      await setAgentSessionStartupFailure(redis, startupFailure).catch(() => {});
      const failedPatch = {
        status: 'error',
        chatStatus: AgentChatStatus.ERROR,
        workspaceStatus: AgentWorkspaceStatus.FAILED,
        ...(remoteProvider ? { podName: null, pvcName: null } : {}),
      } as unknown as Partial<AgentSession>;

      let startupFailurePersisted = false;
      if (sessionPersisted) {
        session = {
          ...session!,
          ...failedPatch,
        } as AgentSession;
      } else {
        try {
          await recordUnpersistedCreateSessionStartupFailure({
            opts,
            sessionUuid,
            buildKind,
            sessionKind,
            failedPatch,
            startupFailure,
            runtimePlan,
            runtimePlanMetadata,
          });
          startupFailurePersisted = true;
        } catch (persistenceError) {
          logger().warn(
            { error: persistenceError, sessionId: sessionUuid },
            `Session: failure persistence failed sessionId=${sessionUuid}`
          );
        }
      }

      const revertPromise =
        enabledDevModeDeployIds.length > 0
          ? (async () => {
              const deploysToRevert = await Deploy.query()
                .whereIn('id', enabledDevModeDeployIds)
                .withGraphFetched(DEV_MODE_REDEPLOY_GRAPH)
                .catch(() => [] as Deploy[]);
              for (const deployId of persistedDevModeDeployIds) {
                await Deploy.query()
                  .findById(deployId)
                  .patch({ devMode: false, devModeSessionId: null })
                  .catch(() => {});
              }
              if (deploysToRevert.length > 0) {
                await restoreDevModeDeploys(opts.namespace, devModeSnapshots, deploysToRevert).catch(() => {});
              }
            })()
          : Promise.resolve();

      await revertPromise;

      await Promise.all(
        remoteProvider
          ? [redis.del(`${SESSION_REDIS_PREFIX}${sessionUuid}`).catch(() => {})]
          : [
              deleteAgentRuntimeResources(opts.namespace, podName, apiKeySecretName).catch(() => {}),
              cleanupForwardedAgentEnvSecrets(opts.namespace, sessionUuid, forwardedAgentEnv.secretProviders).catch(
                () => {}
              ),
              runtimePlan.prewarm.ownsPvc ? deleteAgentPvc(opts.namespace, pvcName).catch(() => {}) : Promise.resolve(),
            ]
      );

      if (sessionPersisted && Object.keys(devModeSnapshots).length > 0) {
        await AgentSession.query()
          .findById(session!.id)
          .patch({
            devModeSnapshots: {},
          } as unknown as Partial<AgentSession>)
          .catch(() => {});
      }

      if (sessionPersisted) {
        const failedState = await WorkspaceRuntimeStateService.recordWorkspaceFailure(
          session!.id,
          {
            sessionPatch: failedPatch,
            workspaceStorage,
            failure: startupFailure,
            runtimePlanMetadata,
            ...(remoteProvider ? { runtimeProvider: remoteProvider.backendId } : {}),
          },
          {
            expectedLifecycle: {
              action: 'provision',
              claimedAt: startupActionClaimedAt,
            },
          }
        ).catch(() => null);
        if (failedState?.session) {
          startupFailurePersisted = true;
          await AgentSourceService.recordSessionState(failedState.session).catch(() => {});
        }
      }

      if (startupFailurePersisted) {
        throw new AgentSessionStartupError({
          sessionId: sessionUuid,
          buildUuid: opts.buildUuid ?? null,
          namespace: opts.namespace,
          failure: startupFailure,
          cause: startupError,
        });
      }
      throw startupError;
    }
  }

  /** Reclaims the workspace and archives the session; reversible via unarchiveSession. */
  static async archiveSession(sessionId: string): Promise<void> {
    return this.teardownWorkspaceRuntime(sessionId, { archive: true });
  }

  /** Reclaims the workspace only; the session stays live and a fresh workspace provisions on the next message. */
  static async releaseWorkspace(sessionId: string, opts: { allowedActiveRunUuid?: string | null } = {}): Promise<void> {
    return this.teardownWorkspaceRuntime(sessionId, { archive: false, ...opts });
  }

  static async unarchiveSession(sessionId: string, userId: string): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: sessionId, userId });
    if (!session) {
      throw new Error('Session not found');
    }
    if (session.status !== 'archived') {
      return session;
    }

    try {
      const restored = await AgentSession.query().patchAndFetchById(session.id, {
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        archivedAt: null,
        lastActivity: new Date().toISOString(),
      } as unknown as Partial<AgentSession>);
      await AgentSourceService.recordSessionState(restored).catch(() => {});
      logger().info(`Session: unarchived sessionId=${sessionId}`);
      return restored;
    } catch (error) {
      if (
        session.buildUuid &&
        session.sessionKind === AgentSessionKind.ENVIRONMENT &&
        isUniqueConstraintError(error, ACTIVE_ENVIRONMENT_SESSION_UNIQUE_INDEX)
      ) {
        const activeSession = await AgentSessionService.getEnvironmentActiveSession(session.buildUuid, userId);
        if (activeSession) {
          throw new ActiveEnvironmentSessionError(activeSession);
        }
      }
      throw error;
    }
  }

  /** Pin a workspace so the cleanup job never reclaims it (it can still sleep). */
  static async setKeepWorkspace(sessionId: string, userId: string, keep: boolean): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: sessionId, userId });
    if (!session) {
      throw new Error('Session not found');
    }
    if (session.keepWorkspace === keep) {
      return session;
    }

    const updated = await AgentSession.query().patchAndFetchById(session.id, {
      keepWorkspace: keep,
    } as Partial<AgentSession>);
    logger().info(`Session: keepWorkspace=${keep} sessionId=${sessionId}`);
    return updated;
  }

  /** Sending to an archived session revives it instead of bouncing with a 409. */
  static async ensureSessionActive(session: AgentSession, userId: string): Promise<AgentSession> {
    if (session.status !== 'archived') {
      return session;
    }

    return this.unarchiveSession(session.uuid, userId);
  }

  private static async teardownWorkspaceRuntime(
    sessionId: string,
    opts: { archive: boolean; allowedActiveRunUuid?: string | null }
  ): Promise<void> {
    const session = await AgentSession.query().findOne({ uuid: sessionId });
    if (!session || (session.status !== 'active' && session.status !== 'starting' && session.status !== 'error')) {
      throw new Error('Session not found or already archived');
    }

    const apiKeySecretName = `agent-secret-${session.uuid.slice(0, 8)}`;
    const redis = RedisClient.getInstance().getRedis();
    const cleanupClaimedAt = new Date().toISOString();
    const derivedBackend = await AgentSandboxService.deriveWorkspaceBackendForAction(session);
    const { session: claimedSession } = await WorkspaceRuntimeStateService.claimWorkspaceAction(session.id, {
      action: 'cleanup',
      claimedAt: cleanupClaimedAt,
      ...(opts.allowedActiveRunUuid ? { allowedActiveRunUuid: opts.allowedActiveRunUuid } : {}),
      sessionPatch: buildCurrentSessionStatePatch(session),
      // The winning backend restamps the row so a stale remote stamp self-heals.
      runtimeProvider: derivedBackend.backendId,
    });
    const cleanupSession = {
      ...session,
      ...claimedSession,
    } as AgentSession;
    const finalizeTeardown = async (targetSession: AgentSession, extraPatch: Partial<AgentSession> = {}) => {
      const teardownPatch = {
        // Teardown settles the session: archived when requested, otherwise live with no workspace.
        status: opts.archive ? 'archived' : 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.NONE,
        archivedAt: opts.archive ? new Date().toISOString() : null,
        podName: null,
        pvcName: null,
        devModeSnapshots: {},
        ...extraPatch,
      } as unknown as Partial<AgentSession>;
      const { session: settledSession } = await WorkspaceRuntimeStateService.recordWorkspaceState(
        targetSession.id,
        {
          sessionPatch: teardownPatch,
          sandboxStatus: 'ended',
          runtimeLifecycle: null,
        },
        {
          expectedLifecycle: {
            action: 'cleanup',
            claimedAt: cleanupClaimedAt,
          },
        }
      );

      await AgentSourceService.recordSessionState(settledSession).catch(() => {});
    };

    logger().info(
      `Session: ${opts.archive ? 'archiving' : 'releasing workspace'} sessionId=${sessionId} status=${
        session.status
      } namespace=${session.namespace}`
    );

    try {
      if (derivedBackend.provider) {
        await Promise.all([
          derivedBackend.provider.destroy(derivedBackend.state),
          // Belt-and-braces for CHAT only: retries can leave a session-owned chat namespace alongside the
          // remote sandbox. Env/sandbox sessions carry the BUILD's namespace, which teardown must never delete.
          ...(cleanupSession.sessionKind === AgentSessionKind.CHAT && cleanupSession.namespace
            ? [deleteNamespace(cleanupSession.namespace)]
            : []),
          redis.del(`${SESSION_REDIS_PREFIX}${cleanupSession.uuid}`),
          clearAgentSessionStartupFailure(redis, cleanupSession.uuid).catch(() => {}),
        ]);

        const build = cleanupSession.buildUuid
          ? await Build.query()
              .findOne({ uuid: cleanupSession.buildUuid })
              .withGraphFetched('[deploys.[service, build], pullRequest.[repository]]')
          : null;
        if (build?.kind === BuildKind.SANDBOX) {
          const { default: BuildService } = await import('./build');
          const buildService = new BuildService();

          try {
            await buildService.deleteQueue.add('delete', {
              buildId: build.id,
              buildUuid: build.uuid,
              sender: 'agent-session',
              ...extractContextForQueue(),
            });
          } catch (error) {
            logger().warn(
              { error, buildUuid: build.uuid, sessionId },
              `Sandbox: cleanup enqueue failed action=sync_fallback sessionId=${sessionId} buildUuid=${build.uuid}`
            );
            await buildService.deleteBuild(build);
          }
        }

        await finalizeTeardown(cleanupSession);

        logger().info(
          `Session: workspace released sessionId=${sessionId} backend=${derivedBackend.backendId} sandboxId=${cleanupSession.podName}`
        );
        return;
      }

      if (cleanupSession.sessionKind === AgentSessionKind.CHAT && cleanupSession.namespace) {
        await Promise.all([
          deleteNamespace(cleanupSession.namespace),
          redis.del(`${SESSION_REDIS_PREFIX}${cleanupSession.uuid}`),
          clearAgentSessionStartupFailure(redis, cleanupSession.uuid).catch(() => {}),
        ]);

        await finalizeTeardown(cleanupSession, { namespace: null });

        logger().info(`Session: workspace released sessionId=${sessionId} namespace=${cleanupSession.namespace}`);
        return;
      }

      if (!cleanupSession.namespace || !cleanupSession.podName || !cleanupSession.pvcName) {
        await Promise.all([
          redis.del(`${SESSION_REDIS_PREFIX}${cleanupSession.uuid}`),
          clearAgentSessionStartupFailure(redis, cleanupSession.uuid).catch(() => {}),
        ]);

        await finalizeTeardown(cleanupSession);

        logger().info(`Session: workspace released sessionId=${sessionId} namespace=none`);
        return;
      }

      const build = cleanupSession.buildUuid
        ? await Build.query()
            .findOne({ uuid: cleanupSession.buildUuid })
            .withGraphFetched('[deploys.[service, build], pullRequest.[repository]]')
        : null;

      if (build?.kind === BuildKind.SANDBOX) {
        await Promise.all([
          redis.del(`${SESSION_REDIS_PREFIX}${cleanupSession.uuid}`),
          clearAgentSessionStartupFailure(redis, cleanupSession.uuid).catch(() => {}),
        ]);

        const { default: BuildService } = await import('./build');
        const buildService = new BuildService();

        try {
          await buildService.deleteQueue.add('delete', {
            buildId: build.id,
            buildUuid: build.uuid,
            sender: 'agent-session',
            ...extractContextForQueue(),
          });
        } catch (error) {
          logger().warn(
            { error, buildUuid: build.uuid, sessionId },
            `Sandbox: cleanup enqueue failed action=sync_fallback sessionId=${sessionId} buildUuid=${build.uuid}`
          );
          await buildService.deleteBuild(build);
        }

        await finalizeTeardown(cleanupSession);

        logger().info(`Sandbox: releasing sessionId=${sessionId} buildUuid=${build.uuid} cleanup=queued`);
        return;
      }

      const devModeDeploys = await Deploy.query()
        .where({ devModeSessionId: cleanupSession.id, devMode: true })
        .withGraphFetched(DEV_MODE_REDEPLOY_GRAPH);
      for (const deploy of devModeDeploys) {
        await Deploy.query().findById(deploy.id).patch({ devMode: false, devModeSessionId: null });
      }

      const deleteSessionPvc = await shouldDeleteSessionPvc(cleanupSession);

      await Promise.all([
        deleteAgentRuntimeResources(cleanupSession.namespace, cleanupSession.podName, apiKeySecretName),
        cleanupForwardedAgentEnvSecrets(
          cleanupSession.namespace,
          cleanupSession.uuid,
          cleanupSession.forwardedAgentSecretProviders
        ),
        redis.del(`${SESSION_REDIS_PREFIX}${cleanupSession.uuid}`),
        clearAgentSessionStartupFailure(redis, cleanupSession.uuid).catch(() => {}),
      ]);
      await cleanupDevModePatches(cleanupSession.namespace, cleanupSession.devModeSnapshots, devModeDeploys);
      if (deleteSessionPvc) {
        await deleteAgentPvc(cleanupSession.namespace, cleanupSession.pvcName);
      }

      triggerDevModeDeployRestore(cleanupSession.namespace, cleanupSession.devModeSnapshots, devModeDeploys);

      await finalizeTeardown(cleanupSession);

      logger().info(`Session: workspace released sessionId=${sessionId} namespace=${cleanupSession.namespace}`);
    } catch (error) {
      await recordCleanupFailure(cleanupSession, error, {
        action: 'cleanup',
        claimedAt: cleanupClaimedAt,
      });
      throw error;
    }
  }

  static async attachServices(sessionId: string, requestedServices: RequestedSessionService[]): Promise<void> {
    if (!Array.isArray(requestedServices) || requestedServices.length === 0) {
      return;
    }

    const session = await AgentSession.query().findOne({ uuid: sessionId });
    if (!session) {
      throw new Error('Session not found');
    }

    const remoteRuntime = await resolveRemoteRuntimeForSession(session);
    if (remoteRuntime) {
      // Remote backends cannot run dev-mode service attachment (capability floor).
      assertBackendCapabilities(remoteRuntime.provider.backendId, ['environmentSessions', 'developWorkspaces']);
    }

    if (session.status !== 'active') {
      throw new Error('Only active sessions can connect services');
    }

    if (session.buildKind !== BuildKind.ENVIRONMENT) {
      throw new Error('Connecting services after startup is only supported for environment sessions');
    }

    if (!session.buildUuid) {
      throw new Error('Session build context is missing');
    }

    if (!session.namespace || !session.podName || !session.pvcName) {
      throw new Error('Session runtime is not ready for service attachment');
    }

    const namespace = session.namespace;
    const podName = session.podName;
    const pvcName = session.pvcName;

    const workspaceRepos = session.workspaceRepos || [];
    if (workspaceRepos.length !== 1) {
      throw new Error('Connecting services after startup is only supported for single-repo sessions');
    }

    const primaryWorkspaceRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0];
    if (!primaryWorkspaceRepo?.repo || !primaryWorkspaceRepo.branch) {
      throw new Error('Session workspace repository metadata is missing');
    }

    const candidates = await loadAgentSessionServiceCandidates(session.buildUuid);
    const resolvedCandidates = resolveRequestedAgentSessionServices(candidates, requestedServices);
    const attachedDeployIds = new Set<number>([
      ...(session.selectedServices || []).map((service) => service.deployId),
      ...Object.keys(session.devModeSnapshots || {})
        .map((deployId) => Number(deployId))
        .filter((deployId) => Number.isInteger(deployId)),
    ]);
    const attachableCandidates = resolvedCandidates.filter((candidate) => !attachedDeployIds.has(candidate.deployId));

    if (attachableCandidates.length === 0) {
      return;
    }

    const incompatibleCandidates = attachableCandidates.filter(
      (candidate) =>
        workspaceRepoKey(candidate.repo) !== workspaceRepoKey(primaryWorkspaceRepo.repo) ||
        candidate.branch !== primaryWorkspaceRepo.branch
    );
    if (incompatibleCandidates.length > 0) {
      const supportedTarget = `${primaryWorkspaceRepo.repo}:${primaryWorkspaceRepo.branch}`;
      const requestedTargets = incompatibleCandidates.map(
        (candidate) => `${candidate.name} (${candidate.repo}:${candidate.branch})`
      );
      throw new Error(
        `Only services from ${supportedTarget} can be connected after the session starts. Requested: ${requestedTargets.join(
          ', '
        )}`
      );
    }

    const forwardedEnvServices = attachableCandidates
      .filter((candidate) => (candidate.devConfig.forwardEnvVarsToAgent || []).length > 0)
      .map((candidate) => candidate.name);
    if (forwardedEnvServices.length > 0) {
      throw new Error(
        `Services that forward env vars to the agent must be selected when the session starts: ${forwardedEnvServices.join(
          ', '
        )}`
      );
    }

    const candidateServices = attachableCandidates.map(
      ({ name, deployId, devConfig, baseDeploy, repo, branch, revision }) => ({
        name,
        deployId,
        devConfig,
        resourceName: baseDeploy.uuid || undefined,
        repo,
        branch,
        revision: revision || null,
      })
    );
    const templatedServices = await resolveTemplatedDevConfigEnvs(
      session.buildUuid || undefined,
      namespace,
      candidateServices
    );
    const { services: resolvedServices, selectedServices } = applyWorkspaceReposToServices(
      templatedServices,
      workspaceRepos
    );
    const skillPlan = resolveAgentSessionSkillPlan({
      basePlan: session.skillPlan || EMPTY_AGENT_SESSION_SKILL_PLAN,
      services: resolvedServices || [],
    });
    const installCommand = buildCombinedInstallCommand(resolvedServices);

    logger().info(
      `Session: services attaching sessionId=${sessionId} namespace=${namespace} services=${
        (resolvedServices || []).map((service) => service.name).join(',') || 'none'
      }`
    );

    if (installCommand) {
      await runCommandInSessionWorkspace(namespace, podName, installCommand);
    }

    if ((skillPlan.skills || []).length > 0) {
      await runCommandInSessionWorkspace(
        namespace,
        podName,
        generateSkillBootstrapCommand(skillPlan, { useGitHubToken: true })
      );
    }

    const keepAttachedServicesOnSessionNode = await resolveSessionAttachmentPlacementPolicy(session);
    const agentNodeName = keepAttachedServicesOnSessionNode ? await resolveAgentPodNodeName(namespace, podName) : null;

    if (keepAttachedServicesOnSessionNode && !agentNodeName) {
      throw new Error(`Session workspace pod ${podName} did not report a scheduled node`);
    }

    const enabledDevModeDeployIds: number[] = [];
    const persistedDevModeDeployIds: number[] = [];
    const addedSnapshots: SessionSnapshotMap = {};

    try {
      const enabledServices = await enableServicesInDevModeParallel({
        namespace,
        pvcName,
        services: resolvedServices || [],
        requiredNodeName: keepAttachedServicesOnSessionNode ? agentNodeName || undefined : undefined,
      }).catch((error) => {
        if (error instanceof DevModeBatchEnableError) {
          enabledDevModeDeployIds.push(...error.successfulServices.map((service) => service.deployId));
          Object.assign(addedSnapshots, buildSnapshotMapFromEnabledServices(error.successfulServices));
        }

        throw error;
      });

      enabledDevModeDeployIds.push(...enabledServices.map((service) => service.deployId));
      Object.assign(addedSnapshots, buildSnapshotMapFromEnabledServices(enabledServices));

      for (const service of enabledServices) {
        await Deploy.query().findById(service.deployId).patch({
          devMode: true,
          devModeSessionId: session.id,
        });
        persistedDevModeDeployIds.push(service.deployId);
      }

      await AgentSession.query()
        .findById(session.id)
        .patch({
          selectedServices: mergeSelectedServices(session.selectedServices, selectedServices),
          devModeSnapshots: {
            ...(session.devModeSnapshots || {}),
            ...addedSnapshots,
          },
          skillPlan,
        } as unknown as Partial<AgentSession>);

      const serviceNames = resolvedServices?.map((service) => service.name) || [];

      logger().info(
        {
          sessionId,
          namespace,
          services: serviceNames,
        },
        `Session: services attached sessionId=${sessionId} namespace=${namespace} services=${
          serviceNames.join(',') || 'none'
        }`
      );
    } catch (error) {
      if (enabledDevModeDeployIds.length > 0) {
        const deploysToRevert = await Deploy.query()
          .whereIn('id', enabledDevModeDeployIds)
          .withGraphFetched(DEV_MODE_REDEPLOY_GRAPH)
          .catch(() => [] as Deploy[]);

        for (const deployId of persistedDevModeDeployIds) {
          await Deploy.query()
            .findById(deployId)
            .patch({ devMode: false, devModeSessionId: null })
            .catch(() => {});
        }

        if (deploysToRevert.length > 0) {
          await restoreDevModeDeploys(namespace, addedSnapshots, deploysToRevert).catch(() => {});
        }
      }

      throw error;
    }
  }

  static async getSession(sessionId: string) {
    const session = await AgentSession.query().findOne({ uuid: sessionId });
    if (!session) {
      return null;
    }

    const [enrichedSession] = await AgentSessionService.enrichSessions([session]);
    return enrichedSession || null;
  }

  static async getSessionAppendSystemPrompt(
    sessionId: string,
    repoFullName?: string,
    configuredPrompt?: string,
    runtimeToolMetadata?: readonly AgentRuntimeToolMetadata[]
  ): Promise<string | undefined> {
    const [session, effectiveConfig, approvalPolicy] = await Promise.all([
      AgentSession.query()
        .findOne({ uuid: sessionId })
        .select('id', 'namespace', 'buildUuid', 'skillPlan', 'sessionKind', 'workspaceStatus', 'podName'),
      AgentSessionConfigService.getInstance().getEffectiveConfig(repoFullName),
      AgentPolicyService.getEffectivePolicy(repoFullName),
    ]);
    const resolvedConfiguredPrompt =
      configuredPrompt !== undefined ? configuredPrompt : effectiveConfig?.appendSystemPrompt;

    if (!session) {
      return resolvedConfiguredPrompt;
    }

    if (!session.namespace && !session.buildUuid) {
      return resolvedConfiguredPrompt;
    }

    try {
      const context = await resolveAgentSessionPromptContext({
        sessionDbId: session.id,
        namespace: session.namespace || null,
        buildUuid: session.buildUuid,
      });
      const hasReadyWorkspace =
        session.workspaceStatus === AgentWorkspaceStatus.READY &&
        Boolean(session.namespace) &&
        Boolean(session.podName);
      const toolLines = hasReadyWorkspace
        ? buildWorkspaceCorePromptLines({
            approvalPolicy,
            toolRules: effectiveConfig.toolRules,
            runtimeToolMetadata,
          })
        : [];

      return combineAgentSessionAppendSystemPrompt(
        resolvedConfiguredPrompt,
        buildAgentSessionDynamicSystemPrompt({
          ...context,
          // Fall back to build.namespace so build-context chats still emit the namespace line.
          namespace: context.namespace || context.build?.namespace || null,
          toolLines,
        })
      );
    } catch (error) {
      // Disclose missing grounding so the model gathers state via tools instead of assuming a clean baseline.
      logger().warn({ error, sessionId }, `Session: prompt context resolution failed sessionId=${sessionId}`);
      return combineAgentSessionAppendSystemPrompt(
        resolvedConfiguredPrompt,
        'Initial Lifecycle snapshot: UNAVAILABLE (context lookup failed) — gather build/deploy/k8s state via tools and note in your answer that baseline context was unavailable.'
      );
    }
  }

  static async touchActivity(sessionId: string): Promise<void> {
    const session = await AgentSession.query().findOne({ uuid: sessionId }).select('id');
    if (!session) {
      return;
    }

    await AgentSession.query().findById(session.id).patch({ lastActivity: new Date().toISOString() });
  }
}
