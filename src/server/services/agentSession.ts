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
import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import Configuration from 'server/models/Configuration';
import Deploy from 'server/models/Deploy';
import { createAgentPvc, deleteAgentPvc } from 'server/lib/agentSession/pvcFactory';
import { createAgentApiKeySecret, deleteAgentApiKeySecret } from 'server/lib/agentSession/apiKeySecretFactory';
import { createAgentPod, deleteAgentPod } from 'server/lib/agentSession/podFactory';
import { createAgentEditorService, deleteAgentEditorService } from 'server/lib/agentSession/editorServiceFactory';
import { ensureAgentSessionServiceAccount } from 'server/lib/agentSession/serviceAccountFactory';
import { isGvisorAvailable } from 'server/lib/agentSession/gvisorCheck';
import { DevModeManager } from 'server/lib/agentSession/devModeManager';
import type { DevModeResourceSnapshot } from 'server/lib/agentSession/devModeManager';
import { buildAgentNetworkPolicy } from 'server/lib/kubernetes/networkPolicyFactory';
import UserApiKeyService from 'server/services/userApiKey';
import GlobalConfigService from 'server/services/globalConfig';
import { DevConfig } from 'server/models/yaml/YamlService';
import RedisClient from 'server/lib/redisClient';
import { extractContextForQueue, getLogger } from 'server/lib/logger';
import { BuildKind, FeatureFlags } from 'shared/constants';
import type { RequestUserIdentity } from 'server/lib/get-user';
import {
  type ResolvedAgentSessionReadinessConfig,
  type ResolvedAgentSessionResources,
  resolveAgentSessionClaudeConfig,
  renderAgentSessionClaudeAttribution,
} from 'server/lib/agentSession/runtimeConfig';
import { cleanupForwardedAgentEnvSecrets, resolveForwardedAgentEnv } from 'server/lib/agentSession/forwardedEnv';
import {
  AGENT_WORKSPACE_ROOT,
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
import AgentPrewarmService from './agentPrewarm';
import {
  loadAgentSessionServiceCandidates,
  resolveRequestedAgentSessionServices,
  type RequestedAgentSessionServiceRef,
} from './agentSessionCandidates';

const logger = () => getLogger();
const SESSION_REDIS_PREFIX = 'lifecycle:agent:session:';
const SESSION_REDIS_TTL = 7200;
const ACTIVE_ENVIRONMENT_SESSION_UNIQUE_INDEX = 'agent_sessions_active_environment_build_unique';
const DEV_MODE_REDEPLOY_GRAPH = '[deployable.[repository], repository, service, build.[pullRequest.[repository]]]';
const SESSION_DEPLOY_GRAPH = '[deployable, repository, service]';

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

async function resolveAgentPodNodeName(namespace: string, podName: string): Promise<string | null> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const response = await coreApi.readNamespacedPod(podName, namespace);

  return response.body.spec?.nodeName || null;
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

async function runCommandInAgentPod(
  namespace: string,
  podName: string,
  command: string,
  container = 'agent'
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
    deleteAgentEditorService(namespace, podName),
    deleteAgentPod(namespace, podName),
    deleteAgentApiKeySecret(namespace, apiKeySecretName),
  ]);
}

async function resolveCompatiblePrewarm(buildUuid: string | undefined, requestedServices: string[], revision?: string) {
  if (!buildUuid) {
    return null;
  }

  return new AgentPrewarmService().getCompatibleReadyPrewarm({
    buildUuid,
    requestedServices,
    revision,
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
  repoUrl?: string;
  branch?: string;
  revision?: string;
  workspaceRepos?: AgentSessionWorkspaceRepo[];
  prNumber?: number;
  namespace: string;
  agentImage: string;
  editorImage: string;
  nodeSelector?: Record<string, string>;
  readiness?: ResolvedAgentSessionReadinessConfig;
  resources?: ResolvedAgentSessionResources;
}

export default class AgentSessionService {
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

  static async createSession(opts: CreateSessionOptions) {
    const apiKey = await UserApiKeyService.getDecryptedKey(opts.userId, 'anthropic', opts.userIdentity?.githubUsername);
    if (!apiKey) {
      throw new Error('API_KEY_REQUIRED');
    }

    const sessionUuid = uuid();
    const buildKind = opts.buildKind || BuildKind.ENVIRONMENT;
    const podName = `agent-${sessionUuid.slice(0, 8)}`;
    const apiKeySecretName = `agent-secret-${sessionUuid.slice(0, 8)}`;
    const model = opts.model || 'claude-sonnet-4-6';
    const mutatedDeploys: number[] = [];
    const devModeSnapshots: SessionSnapshotMap = {};
    let failureStage: AgentSessionStartupFailureStage = 'create_session';
    let sessionPersisted = false;
    let session: AgentSession | null = null;
    const redis = RedisClient.getInstance().getRedis();
    const claudeConfig = await resolveAgentSessionClaudeConfig();
    const githubAppName = await GlobalConfigService.getInstance().getGithubAppName();
    const claudeCommitAttribution = renderAgentSessionClaudeAttribution(
      claudeConfig.attribution.commitTemplate,
      githubAppName
    );
    const claudePrAttribution = renderAgentSessionClaudeAttribution(claudeConfig.attribution.prTemplate, githubAppName);
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
    const primaryWorkspaceRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0];
    const resolvedServiceNames = (resolvedServices || []).map((service) => service.name);
    const compatiblePrewarm =
      workspaceRepos.length === 1
        ? await resolveCompatiblePrewarm(
            opts.buildUuid,
            resolvedServiceNames,
            primaryWorkspaceRepo?.revision || opts.revision
          )
        : null;
    const pvcName = compatiblePrewarm?.pvcName || `agent-pvc-${sessionUuid.slice(0, 8)}`;
    const forwardedAgentEnv = await resolveForwardedAgentEnv(
      resolvedServices,
      opts.namespace,
      sessionUuid,
      opts.buildUuid
    );
    const forwardedPlainAgentEnv = Object.fromEntries(
      Object.entries(forwardedAgentEnv.env).filter(
        ([envKey]) => !forwardedAgentEnv.secretRefs.some((secretRef) => secretRef.envKey === envKey)
      )
    );

    logger().info(
      `Session: starting sessionId=${sessionUuid} buildKind=${buildKind} namespace=${opts.namespace} buildUuid=${
        opts.buildUuid || 'none'
      } services=${resolvedServiceNames.join(',') || 'none'} prewarm=${compatiblePrewarm ? 'reused' : 'new'}`
    );

    try {
      session = await AgentSession.query().insertAndFetch({
        uuid: sessionUuid,
        buildUuid: opts.buildUuid || null,
        buildKind,
        userId: opts.userId,
        ownerGithubUsername: opts.userIdentity?.githubUsername || null,
        podName,
        namespace: opts.namespace,
        pvcName,
        model,
        status: 'starting',
        devModeSnapshots,
        forwardedAgentSecretProviders: forwardedAgentEnv.secretProviders,
        workspaceRepos,
        selectedServices,
      } as unknown as Partial<AgentSession>);
      sessionPersisted = true;

      const [, , agentServiceAccountName] = await Promise.all([
        compatiblePrewarm ? Promise.resolve(null) : createAgentPvc(opts.namespace, pvcName, '10Gi', opts.buildUuid),
        createAgentApiKeySecret(
          opts.namespace,
          apiKeySecretName,
          apiKey,
          opts.githubToken,
          opts.buildUuid,
          forwardedPlainAgentEnv
        ),
        ensureAgentSessionServiceAccount(opts.namespace),
      ]);

      const useGvisor = await isGvisorAvailable();
      const combinedInstallCommand = buildCombinedInstallCommand(resolvedServices);

      failureStage = 'connect_runtime';
      const agentPod = await createAgentPod({
        podName,
        namespace: opts.namespace,
        pvcName,
        image: opts.agentImage,
        editorImage: opts.editorImage,
        apiKeySecretName,
        hasGitHubToken: Boolean(opts.githubToken),
        model,
        repoUrl: primaryWorkspaceRepo?.repoUrl,
        branch: primaryWorkspaceRepo?.branch,
        revision: primaryWorkspaceRepo?.revision || undefined,
        workspacePath: AGENT_WORKSPACE_ROOT,
        workspaceRepos,
        installCommand: combinedInstallCommand,
        claudePermissions: claudeConfig.permissions,
        claudeCommitAttribution,
        claudePrAttribution,
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
      });
      const agentNodeName = agentPod.spec?.nodeName || null;

      if ((resolvedServices || []).length > 0 && !agentNodeName) {
        throw new Error(`Agent pod ${podName} did not report a scheduled node`);
      }

      const devModeManager = new DevModeManager();
      for (const svc of resolvedServices || []) {
        const resourceName = svc.resourceName || svc.name;
        const snapshot = await devModeManager.enableDevMode({
          namespace: opts.namespace,
          deploymentName: resourceName,
          serviceName: resourceName,
          pvcName,
          devConfig: svc.devConfig,
          requiredNodeName: agentNodeName || undefined,
        });
        mutatedDeploys.push(svc.deployId);
        devModeSnapshots[String(svc.deployId)] = snapshot;
        await AgentSession.query()
          .findById(session.id)
          .patch({
            devModeSnapshots,
          } as unknown as Partial<AgentSession>);
        await Deploy.query().findById(svc.deployId).patch({
          devMode: true,
          devModeSessionId: session.id,
        });
      }

      await createAgentEditorService(opts.namespace, podName, opts.buildUuid);

      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const netApi = kc.makeApiClient(k8s.NetworkingV1Api);
      const policy = buildAgentNetworkPolicy(opts.namespace);
      await netApi.createNamespacedNetworkPolicy(opts.namespace, policy).catch((err: any) => {
        if (err?.statusCode !== 409) throw err;
      });
      await redis.setex(
        `${SESSION_REDIS_PREFIX}${sessionUuid}`,
        SESSION_REDIS_TTL,
        JSON.stringify({ podName, namespace: opts.namespace, status: 'active' })
      );

      await AgentSession.query()
        .findById(session.id)
        .patch({
          status: 'active',
        } as unknown as Partial<AgentSession>);

      session = {
        ...session,
        status: 'active',
      } as AgentSession;

      await clearAgentSessionStartupFailure(redis, sessionUuid).catch(() => {});

      logger().info(
        `Session: ready sessionId=${sessionUuid} namespace=${opts.namespace} podName=${podName} services=${
          resolvedServiceNames.join(',') || 'none'
        } prewarm=${compatiblePrewarm ? 'reused' : 'new'}`
      );

      return session!;
    } catch (err) {
      const startupFailure = buildAgentSessionStartupFailure({
        sessionId: sessionUuid,
        error: err,
        stage: failureStage,
      });

      if (
        buildKind === BuildKind.ENVIRONMENT &&
        opts.buildUuid &&
        isUniqueConstraintError(err, ACTIVE_ENVIRONMENT_SESSION_UNIQUE_INDEX)
      ) {
        const activeSession = await AgentSessionService.getEnvironmentActiveSession(opts.buildUuid, opts.userId);
        if (activeSession) {
          throw new ActiveEnvironmentSessionError(activeSession);
        }
      }

      logger().error(
        { error: err, sessionId: sessionUuid, failureStage },
        `Session: startup failed sessionId=${sessionUuid} stage=${failureStage}`
      );

      await setAgentSessionStartupFailure(redis, startupFailure).catch(() => {});
      const endedAt = new Date().toISOString();

      if (sessionPersisted) {
        await AgentSession.query()
          .findById(session!.id)
          .patch({
            status: 'error',
            endedAt,
          } as unknown as Partial<AgentSession>)
          .catch(() => {});
      } else {
        await AgentSession.query()
          .insert({
            uuid: sessionUuid,
            userId: opts.userId,
            ownerGithubUsername: opts.userIdentity?.githubUsername || null,
            podName,
            namespace: opts.namespace,
            pvcName,
            model,
            status: 'error',
            buildUuid: opts.buildUuid || null,
            buildKind,
            endedAt,
            devModeSnapshots: {},
            forwardedAgentSecretProviders: forwardedAgentEnv.secretProviders,
            workspaceRepos,
            selectedServices,
          } as unknown as Partial<AgentSession>)
          .catch(() => {});
      }

      const revertPromise =
        mutatedDeploys.length > 0
          ? (async () => {
              const deploysToRevert = await Deploy.query()
                .whereIn('id', mutatedDeploys)
                .withGraphFetched(DEV_MODE_REDEPLOY_GRAPH)
                .catch(() => [] as Deploy[]);
              for (const deployId of mutatedDeploys) {
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

      throw err;
    }
  }

  static async endSession(sessionId: string): Promise<void> {
    const session = await AgentSession.query().findOne({ uuid: sessionId });
    if (!session || (session.status !== 'active' && session.status !== 'starting' && session.status !== 'error')) {
      throw new Error('Session not found or already ended');
    }

    const apiKeySecretName = `agent-secret-${session.uuid.slice(0, 8)}`;
    const redis = RedisClient.getInstance().getRedis();

    logger().info(`Session: ending sessionId=${sessionId} status=${session.status} namespace=${session.namespace}`);

    const build = session.buildUuid
      ? await Build.query()
          .findOne({ uuid: session.buildUuid })
          .withGraphFetched('[deploys.[service, build], pullRequest.[repository]]')
      : null;

    if (build?.kind === BuildKind.SANDBOX) {
      await AgentSession.query().findById(session.id).patch({
        status: 'ended',
        endedAt: new Date().toISOString(),
      });

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

    await AgentSession.query().findById(session.id).patch({
      status: 'ended',
      endedAt: new Date().toISOString(),
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
      session.namespace,
      candidateServices
    );
    const { services: resolvedServices, selectedServices } = applyWorkspaceReposToServices(
      templatedServices,
      workspaceRepos
    );
    const installCommand = buildCombinedInstallCommand(resolvedServices);

    logger().info(
      `Session: services attaching sessionId=${sessionId} namespace=${session.namespace} services=${
        (resolvedServices || []).map((service) => service.name).join(',') || 'none'
      }`
    );

    if (installCommand) {
      await runCommandInAgentPod(session.namespace, session.podName, installCommand);
    }

    const agentNodeName = await resolveAgentPodNodeName(session.namespace, session.podName);

    if (!agentNodeName) {
      throw new Error(`Agent pod ${session.podName} did not report a scheduled node`);
    }

    const devModeManager = new DevModeManager();
    const mutatedDeploys: number[] = [];
    const addedSnapshots: SessionSnapshotMap = {};

    try {
      for (const service of resolvedServices || []) {
        const resourceName = service.resourceName || service.name;
        const snapshot = await devModeManager.enableDevMode({
          namespace: session.namespace,
          deploymentName: resourceName,
          serviceName: resourceName,
          pvcName: session.pvcName,
          devConfig: service.devConfig,
          requiredNodeName: agentNodeName,
        });

        mutatedDeploys.push(service.deployId);
        addedSnapshots[String(service.deployId)] = snapshot;

        await Deploy.query().findById(service.deployId).patch({
          devMode: true,
          devModeSessionId: session.id,
        });
      }

      await AgentSession.query()
        .findById(session.id)
        .patch({
          selectedServices: mergeSelectedServices(session.selectedServices, selectedServices),
          devModeSnapshots: {
            ...(session.devModeSnapshots || {}),
            ...addedSnapshots,
          },
        } as unknown as Partial<AgentSession>);

      const serviceNames = resolvedServices?.map((service) => service.name) || [];

      logger().info(
        {
          sessionId,
          namespace: session.namespace,
          services: serviceNames,
        },
        `Session: services attached sessionId=${sessionId} namespace=${session.namespace} services=${
          serviceNames.join(',') || 'none'
        }`
      );
    } catch (error) {
      if (mutatedDeploys.length > 0) {
        const deploysToRevert = await Deploy.query()
          .whereIn('id', mutatedDeploys)
          .withGraphFetched(DEV_MODE_REDEPLOY_GRAPH)
          .catch(() => [] as Deploy[]);

        for (const deployId of mutatedDeploys) {
          await Deploy.query()
            .findById(deployId)
            .patch({ devMode: false, devModeSessionId: null })
            .catch(() => {});
        }

        if (deploysToRevert.length > 0) {
          await restoreDevModeDeploys(session.namespace, addedSnapshots, deploysToRevert).catch(() => {});
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

  static async getSessionAppendSystemPrompt(sessionId: string): Promise<string | undefined> {
    const [session, claudeConfig] = await Promise.all([
      AgentSession.query().findOne({ uuid: sessionId }).select('id', 'namespace', 'buildUuid'),
      resolveAgentSessionClaudeConfig(),
    ]);
    const configuredPrompt = claudeConfig.appendSystemPrompt;

    if (!session) {
      return configuredPrompt;
    }

    try {
      const context = await resolveAgentSessionPromptContext({
        sessionDbId: session.id,
        namespace: session.namespace,
        buildUuid: session.buildUuid,
      });

      return combineAgentSessionAppendSystemPrompt(configuredPrompt, buildAgentSessionDynamicSystemPrompt(context));
    } catch (error) {
      logger().warn({ error, sessionId }, `Session: prompt context resolution failed sessionId=${sessionId}`);
      return configuredPrompt;
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
