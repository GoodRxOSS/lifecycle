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
import AgentRun from 'server/models/AgentRun';
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
import { createOrUpdateChatPreview } from 'server/lib/agentSession/chatPreviewFactory';
import { DevModeManager } from 'server/lib/agentSession/devModeManager';
import type { DevModeResourceSnapshot } from 'server/lib/agentSession/devModeManager';
import { createOrUpdateNamespace, deleteNamespace } from 'server/lib/kubernetes';
import { buildAgentNetworkPolicy } from 'server/lib/kubernetes/networkPolicyFactory';
import { DevConfig } from 'server/models/yaml/YamlService';
import RedisClient from 'server/lib/redisClient';
import { extractContextForQueue, getLogger } from 'server/lib/logger';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus, BuildKind, FeatureFlags } from 'shared/constants';
import type { RequestUserIdentity } from 'server/lib/get-user';
import {
  DEFAULT_AGENT_SESSION_REDIS_TTL_SECONDS,
  DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE,
  DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE,
  resolveAgentSessionRuntimeConfig,
  resolveAgentSessionWorkspaceStorageIntent,
  resolveKeepAttachedServicesOnSessionNode,
  type ResolvedAgentSessionReadinessConfig,
  type ResolvedAgentSessionResources,
  type ResolvedAgentSessionWorkspaceStorageIntent,
} from 'server/lib/agentSession/runtimeConfig';
import { cleanupForwardedAgentEnvSecrets, resolveForwardedAgentEnv } from 'server/lib/agentSession/forwardedEnv';
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
  resolveAgentSessionServicePlan,
  workspaceRepoKey,
} from 'server/lib/agentSession/servicePlan';
import {
  buildAgentSessionDynamicSystemPrompt,
  combineAgentSessionAppendSystemPrompt,
  resolveAgentSessionPromptContext,
} from 'server/lib/agentSession/systemPrompt';
import {
  AgentSessionStartupFailureStage,
  PublicAgentSessionStartupFailure,
  buildAgentSessionStartupFailure,
  clearAgentSessionStartupFailure,
  getAgentSessionStartupFailure,
  setAgentSessionStartupFailure,
  toPublicAgentSessionStartupFailure,
} from 'server/lib/agentSession/startupFailureState';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import { McpConfigService } from 'server/services/ai/mcp/config';
import GlobalConfigService from './globalConfig';
import {
  SESSION_POD_MCP_CONFIG_SECRET_KEY,
  serializeSessionWorkspaceGatewayServers,
} from 'server/services/ai/mcp/sessionPod';
import AgentPrewarmService from './agentPrewarm';
import AgentSessionConfigService from './agentSessionConfig';
import AgentChatSessionService from './agent/ChatSessionService';
import AgentPolicyService from './agent/PolicyService';
import AgentProviderRegistry from './agent/ProviderRegistry';
import AgentSandboxService from './agent/SandboxService';
import AgentSourceService from './agent/SourceService';
import { buildSessionWorkspacePromptLines } from './agent/sandboxToolCatalog';
import {
  loadAgentSessionServiceCandidates,
  resolveRequestedAgentSessionServices,
  type RequestedAgentSessionServiceRef,
} from './agentSessionCandidates';
import { normalizeKubernetesLabelValue } from 'server/lib/kubernetes/utils';
import type { AgentSessionSkillRef } from 'server/models/yaml/YamlService';

const logger = () => getLogger();
const SESSION_REDIS_PREFIX = 'lifecycle:agent:session:';
const ACTIVE_ENVIRONMENT_SESSION_UNIQUE_INDEX = 'agent_sessions_active_environment_build_unique';
const DEV_MODE_REDEPLOY_GRAPH = '[deployable.[repository], repository, service, build.[pullRequest.[repository]]]';
const SESSION_DEPLOY_GRAPH = '[deployable, repository, service]';
const AGENT_RUN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

export class ActiveAgentRunSuspensionError extends Error {
  constructor() {
    super('Cannot suspend a chat runtime while an agent run is active');
    this.name = 'ActiveAgentRunSuspensionError';
  }
}
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

function canSessionAcceptMessages(
  session: Pick<AgentSession, 'sessionKind' | 'chatStatus' | 'workspaceStatus'>
): boolean {
  if (session.chatStatus !== AgentChatStatus.READY) {
    return false;
  }

  if (session.sessionKind === AgentSessionKind.CHAT) {
    return true;
  }

  return session.workspaceStatus === AgentWorkspaceStatus.READY;
}

function getSessionMessageBlockReason(
  session: Pick<AgentSession, 'sessionKind' | 'status' | 'chatStatus' | 'workspaceStatus'>
): string {
  if (canSessionAcceptMessages(session)) {
    return '';
  }

  if (
    session.sessionKind !== AgentSessionKind.CHAT &&
    (session.workspaceStatus === AgentWorkspaceStatus.PROVISIONING || session.status === 'starting')
  ) {
    return 'Wait for the session to finish starting before sending a message.';
  }

  return 'This session is no longer available for new messages.';
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

export function buildChatSessionNamespace(sessionUuid: string): string {
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
  sessions: T[]
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

  const redis = RedisClient.getInstance().getRedis();
  const failures = await Promise.all(
    errorSessions.map(async (session) => {
      const failure = await getAgentSessionStartupFailure(redis, session.uuid).catch(() => null);
      return [session.uuid, failure ? toPublicAgentSessionStartupFailure(failure) : null] as const;
    })
  );
  const failureBySessionId = new Map(failures);

  return sessions.map((session) => ({
    ...session,
    startupFailure: failureBySessionId.get(session.uuid) ?? null,
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
  services: Array<Pick<SessionService, 'name' | 'deployId' | 'resourceName' | 'devConfig'>>;
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

async function resolveCompatiblePrewarm(
  buildUuid: string | undefined,
  requestedServices: string[],
  revision?: string,
  workspaceRepos?: AgentSessionWorkspaceRepo[],
  requestedServiceRefs?: AgentSessionSelectedService[]
) {
  if (!buildUuid) {
    return null;
  }

  return new AgentPrewarmService().getCompatibleReadyPrewarm({
    buildUuid,
    requestedServices,
    revision,
    workspaceRepos,
    requestedServiceRefs,
  });
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
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
  redisTtlSeconds?: number;
}

export interface CreateChatSessionOptions {
  userId: string;
  userIdentity?: RequestUserIdentity;
  model?: string;
}

export interface CreateChatRuntimeOptions {
  sessionId: string;
  userId: string;
  userIdentity?: RequestUserIdentity;
  githubToken?: string | null;
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
    });

    await setAgentSessionStartupFailure(redis, failure).catch(() => {});
    await redis.del(`${SESSION_REDIS_PREFIX}${sessionId}`).catch(() => {});

    const session = await AgentSession.query()
      .findOne({ uuid: sessionId })
      .catch(() => null);
    if (session && (session.status === 'starting' || session.status === 'active')) {
      await AgentSession.query()
        .findById(session.id)
        .patch({
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          endedAt: new Date().toISOString(),
        } as unknown as Partial<AgentSession>)
        .catch(() => {});
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

    return attachStartupFailures(enrichedSessions);
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
      throw new Error('Workspace runtime is already provisioning');
    }

    if (
      session.workspaceStatus === AgentWorkspaceStatus.READY &&
      session.namespace &&
      session.podName &&
      session.pvcName
    ) {
      return session;
    }

    const runtimeConfig = await resolveAgentSessionRuntimeConfig();
    const source = await AgentSourceService.getSessionSource(session.id).catch(() => null);
    const workspaceStorage = resolveAgentSessionWorkspaceStorageIntent({
      requestedSize: getRequestedWorkspaceStorageSize(source?.input),
      storage: runtimeConfig.workspaceStorage,
    });
    const namespace = buildChatSessionNamespace(session.uuid);
    const podName = buildAgentSessionPodName(session.uuid);
    const pvcName = `agent-pvc-${session.uuid.slice(0, 8)}`;
    const apiKeySecretName = `agent-secret-${session.uuid.slice(0, 8)}`;
    const redis = RedisClient.getInstance().getRedis();

    if (session.namespace && session.namespace !== namespace) {
      await deleteNamespace(session.namespace).catch(() => {});
    }

    await createOrUpdateNamespace({
      name: namespace,
      buildUUID: session.uuid,
      staticEnv: false,
      ttl: true,
      author: opts.userIdentity?.githubUsername || session.ownerGithubUsername || null,
    });

    const provisioningPatch = {
      namespace,
      podName,
      pvcName,
      status: 'active',
      chatStatus: AgentChatStatus.READY,
      workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
      workspaceRepos: [],
      selectedServices: [],
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      skillPlan: session.skillPlan || EMPTY_AGENT_SESSION_SKILL_PLAN,
    } as unknown as Partial<AgentSession>;
    await AgentSession.query().findById(session.id).patch(provisioningPatch);
    const provisioningSession = {
      ...session,
      ...provisioningPatch,
    } as AgentSession;
    await AgentSandboxService.recordSessionSandboxState(provisioningSession, { workspaceStorage });

    try {
      const sessionPodMcpConfigJson = serializeSessionWorkspaceGatewayServers([]);
      const [, , agentServiceAccountName, useGvisor] = await Promise.all([
        createAgentPvc(namespace, pvcName, workspaceStorage.storageSize, undefined, workspaceStorage.accessMode),
        createAgentApiKeySecret(
          namespace,
          apiKeySecretName,
          {},
          opts.githubToken,
          undefined,
          {},
          {
            [SESSION_POD_MCP_CONFIG_SECRET_KEY]: sessionPodMcpConfigJson,
          }
        ),
        ensureAgentSessionServiceAccount(namespace),
        isGvisorAvailable(),
        createSessionWorkspaceService(namespace, podName),
        ensureAgentNetworkPolicy(namespace),
      ]);

      await createSessionWorkspacePod({
        podName,
        namespace,
        pvcName,
        workspaceImage: runtimeConfig.workspaceImage,
        workspaceEditorImage: runtimeConfig.workspaceEditorImage,
        workspaceGatewayImage: runtimeConfig.workspaceGatewayImage,
        apiKeySecretName,
        hasGitHubToken: Boolean(opts.githubToken),
        workspacePath: SESSION_WORKSPACE_ROOT,
        workspaceRepos: [],
        skillPlan: session.skillPlan || EMPTY_AGENT_SESSION_SKILL_PLAN,
        forwardedAgentEnv: {},
        forwardedAgentSecretRefs: [],
        useGvisor,
        userIdentity: opts.userIdentity,
        nodeSelector: runtimeConfig.nodeSelector,
        readiness: runtimeConfig.readiness,
        serviceAccountName: agentServiceAccountName,
        resources: runtimeConfig.resources,
      });

      await Promise.all([
        redis.setex(
          `${SESSION_REDIS_PREFIX}${session.uuid}`,
          runtimeConfig.cleanup.redisTtlSeconds,
          JSON.stringify({ podName, namespace, status: 'active' })
        ),
        AgentSession.query()
          .findById(session.id)
          .patch({
            status: 'active',
            chatStatus: AgentChatStatus.READY,
            workspaceStatus: AgentWorkspaceStatus.READY,
            namespace,
            podName,
            pvcName,
          } as unknown as Partial<AgentSession>),
      ]);

      logger().info(`Session: runtime ready sessionId=${session.uuid} namespace=${namespace} podName=${podName}`);

      const readySession = await AgentSession.query().findOne({ uuid: session.uuid });
      if (!readySession) {
        throw new Error('Session not found after runtime provisioning');
      }

      await AgentSandboxService.recordSessionSandboxState(readySession, { workspaceStorage });
      return readySession;
    } catch (error) {
      logger().warn(
        { error, sessionId: session.uuid, namespace },
        `Session: runtime provision failed sessionId=${session.uuid}`
      );

      await Promise.all([
        deleteAgentRuntimeResources(namespace, podName, apiKeySecretName).catch(() => {}),
        deleteAgentPvc(namespace, pvcName).catch(() => {}),
        deleteNamespace(namespace).catch(() => {}),
        redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {}),
      ]);

      await AgentSandboxService.recordSessionSandboxState(
        {
          ...session,
          namespace,
          podName,
          pvcName,
          status: 'active',
          workspaceStatus: AgentWorkspaceStatus.FAILED,
        } as AgentSession,
        { workspaceStorage }
      ).catch(() => {});

      await AgentSession.query()
        .findById(session.id)
        .patch({
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          namespace: null,
          podName: null,
          pvcName: null,
          workspaceRepos: [],
          selectedServices: [],
          devModeSnapshots: {},
        } as unknown as Partial<AgentSession>);

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
    serviceName: string;
    ingressName: string;
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

    const publication = await createOrUpdateChatPreview({
      sessionUuid: session.uuid,
      namespace: session.namespace,
      podName: session.podName,
      port,
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

    const activeRun = await AgentRun.query()
      .where({ sessionId: session.id })
      .whereNotIn('status', AGENT_RUN_TERMINAL_STATUSES)
      .first();
    if (activeRun) {
      throw new ActiveAgentRunSuspensionError();
    }

    if (session.workspaceStatus !== AgentWorkspaceStatus.READY || !session.namespace || !session.pvcName) {
      throw new Error('Workspace runtime is not ready');
    }

    const redis = RedisClient.getInstance().getRedis();
    const apiKeySecretName = `agent-secret-${session.uuid.slice(0, 8)}`;
    if (session.podName) {
      await deleteAgentRuntimeResources(session.namespace, session.podName, apiKeySecretName);
    }

    await Promise.all([
      redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`).catch(() => {}),
      clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {}),
    ]);

    const suspendedSession = await AgentSession.query().patchAndFetchById(session.id, {
      status: 'active',
      chatStatus: AgentChatStatus.READY,
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      podName: null,
    } as unknown as Partial<AgentSession>);
    await AgentSandboxService.recordSessionSandboxState(suspendedSession);

    logger().info(`Session: runtime suspended sessionId=${session.uuid} namespace=${session.namespace}`);
    return suspendedSession;
  }

  static async resumeChatRuntime(opts: CreateChatRuntimeOptions): Promise<AgentSession> {
    return this.provisionChatRuntime(opts);
  }

  static async createSession(opts: CreateSessionOptions) {
    const sessionStartedAt = Date.now();
    const sessionUuid = uuid();
    const buildKind = opts.buildKind || BuildKind.ENVIRONMENT;
    const sessionKind = resolveSessionKindFromBuildKind(buildKind);
    const podName = buildAgentSessionPodName(sessionUuid, opts.buildUuid);
    const apiKeySecretName = `agent-secret-${sessionUuid.slice(0, 8)}`;
    const requestedModelId = opts.model?.trim() || undefined;
    const devModeSnapshots: SessionSnapshotMap = {};
    const enabledDevModeDeployIds: number[] = [];
    const persistedDevModeDeployIds: number[] = [];
    let pendingEnabledServicesPromise: Promise<DevModeEnabledService[]> | null = null;
    let pendingWorkspacePodReadyPromise: Promise<k8s.V1Pod> | null = null;
    let failureStage: AgentSessionStartupFailureStage = 'create_session';
    let sessionPersisted = false;
    let session: AgentSession | null = null;
    let resolvedModelId = requestedModelId || 'unresolved-model';
    const workspaceStorage = opts.workspaceStorage ?? {
      requestedSize: null,
      storageSize: DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE,
      accessMode: DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE,
    };
    const redisTtlSeconds = opts.redisTtlSeconds ?? DEFAULT_AGENT_SESSION_REDIS_TTL_SECONDS;
    const redis = RedisClient.getInstance().getRedis();
    const templatedServices = await resolveTemplatedDevConfigEnvs(opts.buildUuid, opts.namespace, opts.services);
    const {
      workspaceRepos,
      services: resolvedServices,
      selectedServices,
    } = resolveAgentSessionServicePlan(
      {
        repoUrl: opts.repoUrl,
        branch: opts.branch,
        revision: opts.revision,
        workspaceRepos: opts.workspaceRepos,
      },
      templatedServices
    );
    const skillPlan = resolveAgentSessionSkillPlan({
      environmentSkillRefs: opts.environmentSkillRefs,
      services: resolvedServices || [],
    });
    const primaryWorkspaceRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0];
    const providerUserIdentity = {
      userId: opts.userId,
      githubUsername: opts.userIdentity?.githubUsername || null,
    };
    const preflightStartedAt = Date.now();
    const selection = await AgentProviderRegistry.resolveSelection({
      repoFullName: primaryWorkspaceRepo?.repo,
      requestedModelId,
    });
    resolvedModelId = selection.modelId;
    const resolvedServiceNames = (resolvedServices || []).map((service) => service.name);
    const [, providerApiKeys, sessionPodServers, resolvedCompatiblePrewarm, forwardedAgentEnv] = await Promise.all([
      AgentProviderRegistry.getRequiredStoredApiKey({
        provider: selection.provider,
        userIdentity: providerUserIdentity,
      }),
      AgentProviderRegistry.resolveCredentialEnvMap({
        repoFullName: primaryWorkspaceRepo?.repo,
        userIdentity: providerUserIdentity,
      }),
      primaryWorkspaceRepo?.repo
        ? new McpConfigService().resolveSessionPodServersForRepo(
            primaryWorkspaceRepo.repo,
            undefined,
            opts.userIdentity || null
          )
        : Promise.resolve([]),
      resolveCompatiblePrewarm(
        opts.buildUuid,
        resolvedServiceNames,
        primaryWorkspaceRepo?.revision || opts.revision,
        workspaceRepos,
        selectedServices
      ),
      resolveForwardedAgentEnv(resolvedServices, opts.namespace, sessionUuid, opts.buildUuid),
    ]);
    const compatiblePrewarm = workspaceStorage.requestedSize ? null : resolvedCompatiblePrewarm;
    const sessionPodMcpConfigJson = serializeSessionWorkspaceGatewayServers(sessionPodServers);
    const pvcName = compatiblePrewarm?.pvcName || `agent-pvc-${sessionUuid.slice(0, 8)}`;
    const forwardedPlainAgentEnv = Object.fromEntries(
      Object.entries(forwardedAgentEnv.env).filter(
        ([envKey]) => !forwardedAgentEnv.secretRefs.some((secretRef) => secretRef.envKey === envKey)
      )
    );
    const preflightMs = elapsedMs(preflightStartedAt);

    logger().info(
      `Session: starting sessionId=${sessionUuid} buildKind=${buildKind} namespace=${opts.namespace} buildUuid=${
        opts.buildUuid || 'none'
      } services=${resolvedServiceNames.join(',') || 'none'} prewarm=${
        compatiblePrewarm ? 'reused' : 'new'
      } preflightMs=${preflightMs}`
    );

    try {
      const keepAttachedServicesOnSessionNode = opts.keepAttachedServicesOnSessionNode !== false;

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
          pvcName,
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

        await AgentSourceService.createSessionSource(createdSession, { trx, workspaceStorage });
        await AgentSandboxService.recordSessionSandboxState(createdSession, { trx, workspaceStorage });
        return createdSession;
      });
      sessionPersisted = true;

      const combinedInstallCommand = buildCombinedInstallCommand(resolvedServices);
      const infraSetupStartedAt = Date.now();
      const [, , agentServiceAccountName, useGvisor] = await Promise.all([
        compatiblePrewarm
          ? Promise.resolve(null)
          : createAgentPvc(
              opts.namespace,
              pvcName,
              workspaceStorage.storageSize,
              opts.buildUuid,
              workspaceStorage.accessMode
            ),
        createAgentApiKeySecret(
          opts.namespace,
          apiKeySecretName,
          providerApiKeys,
          opts.githubToken,
          opts.buildUuid,
          forwardedPlainAgentEnv,
          {
            [SESSION_POD_MCP_CONFIG_SECRET_KEY]: sessionPodMcpConfigJson,
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
      const workspacePodOptions = {
        podName,
        namespace: opts.namespace,
        pvcName,
        workspaceImage: opts.workspaceImage,
        workspaceEditorImage: opts.workspaceEditorImage,
        workspaceGatewayImage: opts.workspaceGatewayImage,
        apiKeySecretName,
        hasGitHubToken: Boolean(opts.githubToken),
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
        nodeSelector: opts.nodeSelector,
        readiness: opts.readiness,
        skipWorkspaceBootstrap: Boolean(compatiblePrewarm),
        serviceAccountName: agentServiceAccountName,
        resources: opts.resources,
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
      const shouldOverlapPrewarmServiceAttach = Boolean(compatiblePrewarm && servicesToEnable.length > 0);

      if (shouldOverlapPrewarmServiceAttach) {
        logger().info(
          `Session: overlap start sessionId=${sessionUuid} namespace=${opts.namespace} podName=${podName} sameNode=${
            keepAttachedServicesOnSessionNode ? 'true' : 'false'
          } services=${resolvedServiceNames.join(',')}`
        );

        await createSessionWorkspacePodWithoutWaiting(workspacePodOptions);
        pendingWorkspacePodReadyPromise = waitForSessionWorkspacePodReady(
          opts.namespace,
          podName,
          opts.readiness
        ).catch((error) => {
          throw new AgentSessionStageError('connect_runtime', error);
        });

        if (keepAttachedServicesOnSessionNode) {
          const scheduledPod = await waitForSessionWorkspacePodScheduled(opts.namespace, podName, opts.readiness).catch(
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
      await Promise.all([
        redis.setex(
          `${SESSION_REDIS_PREFIX}${sessionUuid}`,
          redisTtlSeconds,
          JSON.stringify({ podName, namespace: opts.namespace, status: 'active' })
        ),
        AgentSession.query()
          .findById(session.id)
          .patch({
            status: 'active',
            chatStatus: AgentChatStatus.READY,
            workspaceStatus: AgentWorkspaceStatus.READY,
          } as unknown as Partial<AgentSession>),
      ]);
      const finalizeMs = elapsedMs(finalizeStartedAt);

      session = {
        ...session,
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
      } as AgentSession;
      await AgentSandboxService.recordSessionSandboxState(session, { workspaceStorage });

      await clearAgentSessionStartupFailure(redis, sessionUuid).catch(() => {});

      logger().info(
        `Session: ready sessionId=${sessionUuid} namespace=${opts.namespace} podName=${podName} services=${
          resolvedServiceNames.join(',') || 'none'
        } prewarm=${compatiblePrewarm ? 'reused' : 'new'} durationMs=${elapsedMs(
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
      const endedAt = new Date().toISOString();

      if (sessionPersisted) {
        const failedPatch = {
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          endedAt,
        } as unknown as Partial<AgentSession>;
        const patched = await AgentSession.query()
          .findById(session!.id)
          .patch(failedPatch)
          .then(
            () => true,
            () => false
          );
        if (patched) {
          const failedSession = {
            ...session!,
            ...failedPatch,
          } as AgentSession;
          await Promise.all([
            AgentSourceService.recordSessionState(failedSession).catch(() => {}),
            AgentSandboxService.recordSessionSandboxState(failedSession, { workspaceStorage }).catch(() => {}),
          ]);
        }
      } else {
        const failedSession = await AgentSession.query()
          .insertAndFetch({
            uuid: sessionUuid,
            userId: opts.userId,
            ownerGithubUsername: opts.userIdentity?.githubUsername || null,
            podName,
            namespace: opts.namespace,
            pvcName,
            model: resolvedModelId,
            defaultModel: resolvedModelId,
            defaultHarness: 'lifecycle_ai_sdk',
            status: 'error',
            buildUuid: opts.buildUuid || null,
            buildKind,
            sessionKind,
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt,
            devModeSnapshots: {},
            forwardedAgentSecretProviders: forwardedAgentEnv.secretProviders,
            workspaceRepos,
            selectedServices,
          } as unknown as Partial<AgentSession>)
          .catch(() => null);
        if (failedSession) {
          await Promise.all([
            AgentSourceService.createSessionSource(failedSession, { workspaceStorage }).catch(() => {}),
            AgentSandboxService.recordSessionSandboxState(failedSession, { workspaceStorage }).catch(() => {}),
          ]);
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

      await Promise.all([
        deleteAgentRuntimeResources(opts.namespace, podName, apiKeySecretName).catch(() => {}),
        cleanupForwardedAgentEnvSecrets(opts.namespace, sessionUuid, forwardedAgentEnv.secretProviders).catch(() => {}),
        compatiblePrewarm ? Promise.resolve() : deleteAgentPvc(opts.namespace, pvcName).catch(() => {}),
      ]);

      if (sessionPersisted && Object.keys(devModeSnapshots).length > 0) {
        await AgentSession.query()
          .findById(session!.id)
          .patch({
            devModeSnapshots: {},
          } as unknown as Partial<AgentSession>)
          .catch(() => {});
      }

      throw startupError;
    }
  }

  static async endSession(sessionId: string): Promise<void> {
    const session = await AgentSession.query().findOne({ uuid: sessionId });
    if (!session || (session.status !== 'active' && session.status !== 'starting' && session.status !== 'error')) {
      throw new Error('Session not found or already ended');
    }

    const apiKeySecretName = `agent-secret-${session.uuid.slice(0, 8)}`;
    const redis = RedisClient.getInstance().getRedis();
    const markSessionEnded = async (extraPatch: Partial<AgentSession> = {}) => {
      const endedPatch = {
        status: 'ended',
        chatStatus: AgentChatStatus.ENDED,
        workspaceStatus: AgentWorkspaceStatus.ENDED,
        endedAt: new Date().toISOString(),
        ...extraPatch,
      } as unknown as Partial<AgentSession>;
      await AgentSession.query().findById(session.id).patch(endedPatch);
      const endedSession = {
        ...session,
        ...endedPatch,
      } as AgentSession;

      await Promise.all([
        AgentSourceService.recordSessionState(endedSession).catch(() => {}),
        AgentSandboxService.recordSessionSandboxState(endedSession).catch(() => {}),
      ]);
    };

    logger().info(`Session: ending sessionId=${sessionId} status=${session.status} namespace=${session.namespace}`);

    if (session.sessionKind === AgentSessionKind.CHAT && session.namespace) {
      await Promise.all([
        deleteNamespace(session.namespace).catch(() => {}),
        clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {}),
      ]);

      await markSessionEnded({
        devModeSnapshots: {},
      });

      await redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`);

      logger().info(`Session: ended sessionId=${sessionId} namespace=${session.namespace}`);
      return;
    }

    if (!session.namespace || !session.podName || !session.pvcName) {
      await markSessionEnded({
        devModeSnapshots: {},
      });

      await Promise.all([
        redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`),
        clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {}),
      ]);

      logger().info(`Session: ended sessionId=${sessionId} namespace=none`);
      return;
    }

    const build = session.buildUuid
      ? await Build.query()
          .findOne({ uuid: session.buildUuid })
          .withGraphFetched('[deploys.[service, build], pullRequest.[repository]]')
      : null;

    if (build?.kind === BuildKind.SANDBOX) {
      await markSessionEnded();

      await Promise.all([
        redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`),
        clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {}),
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

      logger().info(`Sandbox: ending sessionId=${sessionId} buildUuid=${build.uuid} cleanup=queued`);
      return;
    }

    const devModeDeploys = await Deploy.query()
      .where({ devModeSessionId: session.id, devMode: true })
      .withGraphFetched(DEV_MODE_REDEPLOY_GRAPH);
    for (const deploy of devModeDeploys) {
      await Deploy.query().findById(deploy.id).patch({ devMode: false, devModeSessionId: null });
    }

    const reusablePrewarm = await resolveSessionPrewarmByPvc(session.buildUuid, session.pvcName);

    await Promise.all([
      deleteAgentRuntimeResources(session.namespace, session.podName, apiKeySecretName),
      cleanupForwardedAgentEnvSecrets(session.namespace, session.uuid, session.forwardedAgentSecretProviders),
      clearAgentSessionStartupFailure(redis, session.uuid).catch(() => {}),
    ]);
    await cleanupDevModePatches(session.namespace, session.devModeSnapshots, devModeDeploys);
    if (!reusablePrewarm) {
      await deleteAgentPvc(session.namespace, session.pvcName);
    }
    triggerDevModeDeployRestore(session.namespace, session.devModeSnapshots, devModeDeploys);

    await markSessionEnded({
      devModeSnapshots: {},
    });

    await redis.del(`${SESSION_REDIS_PREFIX}${session.uuid}`);

    logger().info(`Session: ended sessionId=${sessionId} namespace=${session.namespace}`);
  }

  static async attachServices(sessionId: string, requestedServices: RequestedSessionService[]): Promise<void> {
    if (!Array.isArray(requestedServices) || requestedServices.length === 0) {
      return;
    }

    const session = await AgentSession.query().findOne({ uuid: sessionId });
    if (!session) {
      throw new Error('Session not found');
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
    configuredPrompt?: string
  ): Promise<string | undefined> {
    const [session, effectiveConfig, approvalPolicy] = await Promise.all([
      AgentSession.query()
        .findOne({ uuid: sessionId })
        .select('id', 'namespace', 'buildUuid', 'skillPlan', 'sessionKind'),
      AgentSessionConfigService.getInstance().getEffectiveConfig(repoFullName),
      AgentPolicyService.getEffectivePolicy(repoFullName),
    ]);
    const resolvedConfiguredPrompt =
      configuredPrompt !== undefined ? configuredPrompt : effectiveConfig?.appendSystemPrompt;

    if (!session) {
      return resolvedConfiguredPrompt;
    }

    if (!session.namespace) {
      return resolvedConfiguredPrompt;
    }

    try {
      const context = await resolveAgentSessionPromptContext({
        sessionDbId: session.id,
        namespace: session.namespace,
        buildUuid: session.buildUuid,
      });
      const toolLines = session.namespace
        ? buildSessionWorkspacePromptLines({
            approvalPolicy,
            toolRules: effectiveConfig.toolRules,
            includeSkills: Boolean(session.skillPlan?.skills?.length),
          })
        : [];

      return combineAgentSessionAppendSystemPrompt(
        resolvedConfiguredPrompt,
        buildAgentSessionDynamicSystemPrompt({
          ...context,
          toolLines,
        })
      );
    } catch (error) {
      logger().warn({ error, sessionId }, `Session: prompt context resolution failed sessionId=${sessionId}`);
      return resolvedConfiguredPrompt;
    }
  }

  static async getActiveSessions(userId: string) {
    return AgentSession.query()
      .where({ userId })
      .whereIn('status', ['starting', 'active'])
      .orderBy('updatedAt', 'desc')
      .orderBy('createdAt', 'desc');
  }

  static async getSessions(userId: string, options?: { includeEnded?: boolean }) {
    const query = AgentSession.query().where({ userId });

    if (!options?.includeEnded) {
      query.whereIn('status', ['starting', 'active']);
    }

    const sessions = await query.orderBy('updatedAt', 'desc').orderBy('createdAt', 'desc');
    return AgentSessionService.enrichSessions(sessions);
  }

  static async touchActivity(sessionId: string): Promise<void> {
    const session = await AgentSession.query().findOne({ uuid: sessionId }).select('id');
    if (!session) {
      return;
    }

    await AgentSession.query().findById(session.id).patch({ lastActivity: new Date().toISOString() });
  }
}
