/**
 * Copyright 2026 GoodRx, Inc.
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
import { v4 as uuid } from 'uuid';
import BaseService from './_service';
import AgentPrewarm from 'server/models/AgentPrewarm';
import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import { createAgentPvc, deleteAgentPvc } from 'server/lib/agentSession/pvcFactory';
import { createAgentApiKeySecret, deleteAgentApiKeySecret } from 'server/lib/agentSession/apiKeySecretFactory';
import { ensureAgentSessionServiceAccount } from 'server/lib/agentSession/serviceAccountFactory';
import { cleanupForwardedAgentEnvSecrets, resolveForwardedAgentEnv } from 'server/lib/agentSession/forwardedEnv';
import {
  AGENT_WORKSPACE_ROOT,
  type AgentSessionSelectedService,
  type AgentSessionWorkspaceRepo,
} from 'server/lib/agentSession/workspace';
import {
  buildCombinedInstallCommand,
  resolveAgentSessionServicePlan,
  type ResolvedAgentSessionService,
} from 'server/lib/agentSession/servicePlan';
import { createAgentPrewarmJob, monitorAgentPrewarmJob } from 'server/lib/agentSession/prewarmJobFactory';
import {
  resolveAgentSessionRuntimeConfig,
  type AgentSessionRuntimeConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { extractContextForQueue, getLogger } from 'server/lib/logger';
import type { LifecycleConfig } from 'server/models/yaml';
import { fetchLifecycleConfig } from 'server/models/yaml';
import type { DevConfig } from 'server/models/yaml/YamlService';
import { BuildKind } from 'shared/constants';
import { QUEUE_NAMES } from 'shared/config';
import GlobalConfigService from './globalConfig';
import { resolveAgentSessionServiceCandidates, resolveRequestedAgentSessionServices } from './agentSessionCandidates';

const logger = () => getLogger();
const AGENT_PREWARM_ERROR_MESSAGE_MAX_LENGTH = 4000;

type PrewarmServiceInput = {
  name: string;
  deployId: number;
  devConfig: DevConfig;
  repo: string;
  branch: string;
  revision?: string | null;
};

type ResolvedPrewarmService = ResolvedAgentSessionService<PrewarmServiceInput>;

type ResolvedBuildPrewarmPlan = {
  buildUuid: string;
  namespace: string;
  repo: string;
  repoUrl: string;
  branch: string;
  revision?: string;
  configuredServiceNames: string[];
  services: ResolvedPrewarmService[];
  workspaceRepos: AgentSessionWorkspaceRepo[];
  serviceRefs: AgentSessionSelectedService[];
};

export interface AgentPrewarmQueueJob {
  buildUuid: string;
}

function normalizeServiceNames(serviceNames: Array<string | null | undefined>): string[] {
  return [...new Set(serviceNames.map((serviceName) => serviceName?.trim()).filter(Boolean) as string[])].sort(
    (left, right) => left.localeCompare(right)
  );
}

function hasExactServiceMatch(prewarmServices: string[], requestedServices: string[]): boolean {
  const normalizedPrewarm = normalizeServiceNames(prewarmServices);
  const normalizedRequested = normalizeServiceNames(requestedServices);
  return JSON.stringify(normalizedPrewarm) === JSON.stringify(normalizedRequested);
}

export function canReusePrewarm(prewarmServices: string[], requestedServices: string[]): boolean {
  const requested = normalizeServiceNames(requestedServices);
  if (requested.length === 0) {
    return true;
  }

  const available = new Set(normalizeServiceNames(prewarmServices));
  return requested.every((serviceName) => available.has(serviceName));
}

function truncateErrorMessage(message: string): string {
  if (message.length <= AGENT_PREWARM_ERROR_MESSAGE_MAX_LENGTH) {
    return message;
  }

  return `${message.slice(0, AGENT_PREWARM_ERROR_MESSAGE_MAX_LENGTH - 3)}...`;
}

export default class AgentPrewarmService extends BaseService {
  prewarmQueue = this.queueManager.registerQueue(QUEUE_NAMES.AGENT_SESSION_PREWARM, {
    connection: this.redis,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  static normalizeServiceNames(serviceNames: string[]): string[] {
    return normalizeServiceNames(serviceNames);
  }

  static canReusePrewarm(prewarmServices: string[], requestedServices: string[]): boolean {
    return canReusePrewarm(prewarmServices, requestedServices);
  }

  async getCompatibleReadyPrewarm(params: {
    buildUuid: string;
    requestedServices: string[];
    revision?: string;
  }): Promise<AgentPrewarm | null> {
    const prewarms = await AgentPrewarm.query()
      .where({
        buildUuid: params.buildUuid,
        status: 'ready',
      })
      .orderBy('updatedAt', 'desc');

    return (
      prewarms.find((prewarm) => {
        if (params.revision && prewarm.revision && prewarm.revision !== params.revision) {
          return false;
        }

        return canReusePrewarm(prewarm.services || [], params.requestedServices);
      }) || null
    );
  }

  async getReadyPrewarmByPvc(params: { buildUuid: string; pvcName: string }): Promise<AgentPrewarm | null> {
    const prewarms = await AgentPrewarm.query()
      .where({
        buildUuid: params.buildUuid,
        status: 'ready',
      })
      .orderBy('updatedAt', 'desc');
    const matchingPrewarm = prewarms.find((prewarm) => prewarm.pvcName === params.pvcName) || null;
    if (!matchingPrewarm) {
      return null;
    }

    return prewarms[0]?.uuid === matchingPrewarm.uuid ? matchingPrewarm : null;
  }

  async queueBuildPrewarm(buildUuid: string): Promise<boolean> {
    const plan = await this.resolveBuildPrewarmPlan(buildUuid);
    if (!plan) {
      return false;
    }

    const activePrewarms = await AgentPrewarm.query()
      .where({ buildUuid: plan.buildUuid })
      .whereIn('status', ['queued', 'running', 'ready'])
      .orderBy('updatedAt', 'desc');
    const matchingPrewarm = activePrewarms.find((prewarm) => {
      const sameRevision = !plan.revision || !prewarm.revision || prewarm.revision === plan.revision;
      return sameRevision && hasExactServiceMatch(prewarm.services || [], plan.configuredServiceNames);
    });

    if (matchingPrewarm) {
      return false;
    }

    await this.prewarmQueue.add(
      'prewarm',
      {
        buildUuid: plan.buildUuid,
        ...extractContextForQueue(),
      },
      {
        jobId: `agent-prewarm:${plan.buildUuid}:${plan.revision || 'head'}:${plan.configuredServiceNames.join(',')}`,
      }
    );

    logger().info(
      `Prewarm: queued buildUuid=${plan.buildUuid} services=${plan.configuredServiceNames.join(',')} revision=${
        plan.revision || 'head'
      }`
    );

    return true;
  }

  async prepareBuildPrewarm(buildUuid: string): Promise<AgentPrewarm | null> {
    const plan = await this.resolveBuildPrewarmPlan(buildUuid);
    if (!plan) {
      return null;
    }

    const existingPrewarm = await AgentPrewarm.query()
      .where({ buildUuid: plan.buildUuid })
      .whereIn('status', ['running', 'ready'])
      .orderBy('updatedAt', 'desc');
    const matchingPrewarm = existingPrewarm.find((prewarm) => {
      const sameRevision = !plan.revision || !prewarm.revision || prewarm.revision === plan.revision;
      return sameRevision && hasExactServiceMatch(prewarm.services || [], plan.configuredServiceNames);
    });
    if (matchingPrewarm) {
      return matchingPrewarm;
    }

    const prewarmUuid = uuid();
    const pvcName = `agent-prewarm-pvc-${prewarmUuid.slice(0, 8)}`;
    const jobName = `agent-prewarm-${prewarmUuid.slice(0, 8)}`;
    const secretName = `agent-prewarm-secret-${prewarmUuid.slice(0, 8)}`;
    const runtimeConfig = await resolveAgentSessionRuntimeConfig();
    const githubToken = await GlobalConfigService.getInstance()
      .getGithubClientToken()
      .catch((error) => {
        logger().warn(
          { error, buildUuid },
          `Prewarm: github token lookup failed source=lifecycle_app buildUuid=${buildUuid}`
        );
        return null;
      });
    const forwardedAgentEnv = await resolveForwardedAgentEnv(plan.services, plan.namespace, prewarmUuid, buildUuid);
    const forwardedPlainAgentEnv = Object.fromEntries(
      Object.entries(forwardedAgentEnv.env).filter(
        ([envKey]) => !forwardedAgentEnv.secretRefs.some((secretRef) => secretRef.envKey === envKey)
      )
    );
    const serviceAccountName = await ensureAgentSessionServiceAccount(plan.namespace);
    const installCommand = buildCombinedInstallCommand(plan.services);

    logger().info(
      `Prewarm: starting buildUuid=${plan.buildUuid} services=${plan.configuredServiceNames.join(',')} revision=${
        plan.revision || 'head'
      }`
    );

    let prewarm = await AgentPrewarm.query().insertAndFetch({
      uuid: prewarmUuid,
      buildUuid: plan.buildUuid,
      namespace: plan.namespace,
      repo: plan.repo,
      branch: plan.branch,
      revision: plan.revision || null,
      pvcName,
      jobName,
      status: 'running',
      services: plan.configuredServiceNames,
      workspaceRepos: plan.workspaceRepos,
      serviceRefs: plan.serviceRefs,
      errorMessage: null,
    } as unknown as Partial<AgentPrewarm>);

    try {
      await createAgentPvc(plan.namespace, pvcName, '10Gi', plan.buildUuid).catch((error: unknown) => {
        const httpError = error as k8s.HttpError;
        if (httpError?.statusCode === 409 || httpError?.response?.statusCode === 409) {
          return null;
        }
        throw error;
      });

      await createAgentApiKeySecret(
        plan.namespace,
        secretName,
        '',
        githubToken,
        plan.buildUuid,
        forwardedPlainAgentEnv
      );

      await createAgentPrewarmJob({
        jobName,
        namespace: plan.namespace,
        pvcName,
        image: runtimeConfig.image,
        apiKeySecretName: secretName,
        hasGitHubToken: Boolean(githubToken),
        repoUrl: plan.repoUrl,
        branch: plan.branch,
        revision: plan.revision,
        workspacePath: AGENT_WORKSPACE_ROOT,
        workspaceRepos: plan.workspaceRepos,
        installCommand,
        forwardedAgentEnv: forwardedAgentEnv.env,
        forwardedAgentSecretRefs: forwardedAgentEnv.secretRefs,
        forwardedAgentSecretServiceName: forwardedAgentEnv.secretServiceName,
        buildUuid: plan.buildUuid,
        nodeSelector: runtimeConfig.nodeSelector,
        serviceAccountName,
        resources: runtimeConfig.resources.agent as unknown as AgentSessionRuntimeConfig['resources']['agent'] &
          k8s.V1ResourceRequirements,
      });

      const result = await monitorAgentPrewarmJob(jobName, plan.namespace);
      if (!result.success) {
        const failureMessage = result.logs?.trim() || 'Agent prewarm job failed';
        throw new Error(failureMessage);
      }

      await AgentPrewarm.query()
        .findById(prewarm.id)
        .patch({
          status: 'ready',
          completedAt: new Date().toISOString(),
          errorMessage: null,
        } as unknown as Partial<AgentPrewarm>);

      prewarm = {
        ...prewarm,
        status: 'ready',
        completedAt: new Date().toISOString(),
        errorMessage: null,
      } as AgentPrewarm;

      logger().info(
        `Prewarm: ready buildUuid=${plan.buildUuid} prewarmUuid=${
          prewarm.uuid
        } services=${plan.configuredServiceNames.join(',')}`
      );

      await this.cleanupSupersededPrewarms(plan, prewarm);

      return prewarm;
    } catch (error) {
      const errorMessage = truncateErrorMessage(error instanceof Error ? error.message : String(error));
      await AgentPrewarm.query()
        .findById(prewarm.id)
        .patch({
          status: 'error',
          errorMessage,
        } as unknown as Partial<AgentPrewarm>)
        .catch(() => {});
      throw error;
    } finally {
      await deleteAgentApiKeySecret(plan.namespace, secretName).catch((error) => {
        logger().warn(
          { error, buildUuid, secretName },
          `Prewarm: secret cleanup failed buildUuid=${buildUuid} secretName=${secretName}`
        );
      });
      await cleanupForwardedAgentEnvSecrets(plan.namespace, prewarmUuid, forwardedAgentEnv.secretProviders).catch(
        (error) => {
          logger().warn(
            { error, buildUuid, prewarmUuid },
            `Prewarm: forwarded_env cleanup failed buildUuid=${buildUuid} prewarmUuid=${prewarmUuid}`
          );
        }
      );
    }
  }

  private async resolveBuildPrewarmPlan(buildUuid: string): Promise<ResolvedBuildPrewarmPlan | null> {
    const build = await Build.query()
      .findOne({ uuid: buildUuid })
      .withGraphFetched('[pullRequest, deploys.[deployable]]');
    if (
      !build ||
      build.kind !== BuildKind.ENVIRONMENT ||
      !build.pullRequest?.fullName ||
      !build.pullRequest?.branchName
    ) {
      return null;
    }

    const lifecycleConfig = await fetchLifecycleConfig(build.pullRequest.fullName, build.pullRequest.branchName);
    return this.resolvePrewarmPlanFromConfig(
      buildUuid,
      build.namespace,
      build.pullRequest.fullName,
      build.pullRequest.latestCommit || undefined,
      lifecycleConfig,
      build
    );
  }

  private resolvePrewarmPlanFromConfig(
    buildUuid: string,
    namespace: string,
    repositoryFullName: string,
    revision: string | undefined,
    lifecycleConfig: LifecycleConfig | null,
    build: Build
  ): ResolvedBuildPrewarmPlan | null {
    const configuredServiceNames = normalizeServiceNames(
      lifecycleConfig?.environment?.agentSession?.prewarm?.services || []
    );
    if (configuredServiceNames.length === 0) {
      return null;
    }

    const candidates = resolveAgentSessionServiceCandidates(build.deploys || [], lifecycleConfig as LifecycleConfig);
    const services = resolveRequestedAgentSessionServices(candidates, configuredServiceNames).map((service) => ({
      name: service.name,
      deployId: service.deployId,
      devConfig: service.devConfig,
      repo: service.repo || repositoryFullName,
      branch: service.branch || build.pullRequest?.branchName || null,
      revision: service.revision || revision || null,
    }));

    const {
      workspaceRepos,
      services: resolvedServices,
      selectedServices,
    } = resolveAgentSessionServicePlan({}, services);
    if (workspaceRepos.length !== 1) {
      return null;
    }

    const [workspaceRepo] = workspaceRepos;

    return {
      buildUuid,
      namespace,
      repo: workspaceRepo.repo,
      repoUrl: workspaceRepo.repoUrl,
      branch: workspaceRepo.branch,
      revision: workspaceRepo.revision || undefined,
      configuredServiceNames,
      services: resolvedServices || [],
      workspaceRepos,
      serviceRefs: selectedServices,
    };
  }

  private async cleanupSupersededPrewarms(
    plan: Pick<ResolvedBuildPrewarmPlan, 'buildUuid' | 'namespace'>,
    latestPrewarm: Pick<AgentPrewarm, 'id' | 'uuid' | 'pvcName'>
  ): Promise<void> {
    const prewarms = await AgentPrewarm.query()
      .where({ buildUuid: plan.buildUuid })
      .whereIn('status', ['ready', 'error'])
      .orderBy('updatedAt', 'desc');
    const supersededPrewarms = prewarms.filter((prewarm) => prewarm.id !== latestPrewarm.id);
    if (supersededPrewarms.length === 0) {
      return;
    }

    const activeSessions = await AgentSession.query()
      .where({ buildUuid: plan.buildUuid })
      .whereIn('status', ['starting', 'active']);
    const inUsePvcs = new Set(activeSessions.map((session) => session.pvcName).filter(Boolean));

    for (const prewarm of supersededPrewarms) {
      if (!prewarm.pvcName || inUsePvcs.has(prewarm.pvcName)) {
        continue;
      }

      await deleteAgentPvc(plan.namespace, prewarm.pvcName).catch((error) => {
        logger().warn(
          { error, buildUuid: plan.buildUuid, pvcName: prewarm.pvcName, prewarmUuid: prewarm.uuid },
          `Prewarm: pvc cleanup failed reason=superseded buildUuid=${plan.buildUuid} prewarmUuid=${prewarm.uuid} pvcName=${prewarm.pvcName}`
        );
      });

      await AgentPrewarm.query()
        .deleteById(prewarm.id)
        .catch((error) => {
          logger().warn(
            { error, buildUuid: plan.buildUuid, pvcName: prewarm.pvcName, prewarmUuid: prewarm.uuid },
            `Prewarm: record cleanup failed reason=superseded buildUuid=${plan.buildUuid} prewarmUuid=${prewarm.uuid} pvcName=${prewarm.pvcName}`
          );
        });
    }
  }
}
