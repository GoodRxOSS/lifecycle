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

import type AgentPrewarm from 'server/models/AgentPrewarm';
import type { AgentSessionSkillRef } from 'server/models/yaml/YamlService';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { normalizeKubernetesLabelValue } from 'server/lib/kubernetes/utils';
import {
  resolveAgentSessionRuntimeConfig,
  resolveAgentSessionWorkspaceStorageIntent,
  type AgentSessionRuntimeConfig,
  type ResolvedAgentSessionWorkspaceStorageIntent,
} from 'server/lib/agentSession/runtimeConfig';
import {
  resolveAgentSessionServicePlan,
  type AgentSessionServiceInput,
  type ResolvedAgentSessionService,
} from 'server/lib/agentSession/servicePlan';
import { resolveAgentSessionSkillPlan, type AgentSessionSkillPlan } from 'server/lib/agentSession/skillPlan';
import { planForwardedAgentEnv, type ForwardedAgentEnvPlan } from 'server/lib/agentSession/forwardedEnv';
import type { AgentSessionSelectedService, AgentSessionWorkspaceRepo } from 'server/lib/agentSession/workspace';
import AgentProviderRegistry from 'server/services/agent/ProviderRegistry';
import type { AgentResolvedModelSelection } from 'server/services/agent/types';
import AgentPrewarmService from 'server/services/agentPrewarm';
import { McpConfigService } from 'server/services/agentRuntime/mcp/config';
import { serializeSessionWorkspaceGatewayServers } from 'server/services/agentRuntime/mcp/sessionPod';
import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';

export type WorkspaceRuntimePlanKind = 'environment' | 'sandbox' | 'chat';

export type WorkspaceRuntimeResolvedService = ResolvedAgentSessionService<AgentSessionServiceInput>;

export interface WorkspaceRuntimeServicePlan {
  readonly workspaceRepos: AgentSessionWorkspaceRepo[];
  readonly services: WorkspaceRuntimeResolvedService[] | undefined;
  readonly selectedServices: AgentSessionSelectedService[];
}

export interface WorkspaceRuntimeProviderPlan {
  readonly selection: AgentResolvedModelSelection;
  readonly apiKey: string;
  readonly credentialEnv: Record<string, string>;
}

export interface WorkspaceRuntimeStartupMcpPlan {
  readonly servers: ResolvedMcpServer[];
  readonly serializedConfig: string;
}

export interface WorkspaceRuntimeCredentialsPlan {
  readonly hasGitHubToken: boolean;
  readonly githubToken: string | null;
}

export interface WorkspaceRuntimePrewarmSnapshot {
  readonly uuid: string;
  readonly pvcName: string;
}

export interface WorkspaceRuntimePrewarmPlan {
  readonly compatiblePrewarm: WorkspaceRuntimePrewarmSnapshot | null;
  readonly pvcName: string;
  readonly skipWorkspaceBootstrap: boolean;
  readonly ownsPvc: boolean;
}

export interface WorkspaceRuntimePlan {
  readonly version: 1;
  readonly kind: WorkspaceRuntimePlanKind;
  readonly sessionUuid: string;
  readonly namespace: string;
  readonly podName: string;
  readonly apiKeySecretName: string;
  readonly runtimeConfig: AgentSessionRuntimeConfig;
  readonly workspaceStorage: ResolvedAgentSessionWorkspaceStorageIntent;
  readonly servicePlan: WorkspaceRuntimeServicePlan;
  readonly skillPlan: AgentSessionSkillPlan;
  readonly provider: WorkspaceRuntimeProviderPlan;
  readonly startupMcp: WorkspaceRuntimeStartupMcpPlan;
  readonly forwardedEnv: ForwardedAgentEnvPlan;
  readonly credentials: WorkspaceRuntimeCredentialsPlan;
  readonly prewarm: WorkspaceRuntimePrewarmPlan;
}

export interface WorkspaceRuntimePlanMetadata {
  readonly version: 1;
  readonly pvcName: string;
  readonly ownsPvc: boolean;
  readonly skipWorkspaceBootstrap: boolean;
  readonly compatiblePrewarmUuid: string | null;
}

export interface ResolveWorkspaceRuntimePlanOptions {
  readonly kind: WorkspaceRuntimePlanKind;
  readonly sessionUuid: string;
  readonly namespace: string;
  readonly userId: string;
  readonly userIdentity?: RequestUserIdentity | null;
  readonly githubToken?: string | null;
  readonly buildUuid?: string | null;
  readonly repoUrl?: string | null;
  readonly branch?: string | null;
  readonly revision?: string | null;
  readonly workspaceRepos?: AgentSessionWorkspaceRepo[] | null;
  readonly services?: ReadonlyArray<AgentSessionServiceInput>;
  readonly environmentSkillRefs?: ReadonlyArray<AgentSessionSkillRef> | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly workspaceStorageSize?: string | null;
}

function buildWorkspacePodName(sessionUuid: string, buildUuid?: string | null): string {
  const identifier = buildUuid ?? sessionUuid.slice(0, 8);
  return normalizeKubernetesLabelValue(`agent-${identifier}`.toLowerCase()).replace(/[_.]/g, '-');
}

function buildApiKeySecretName(sessionUuid: string): string {
  return `agent-secret-${sessionUuid.slice(0, 8)}`;
}

function buildNewPvcName(sessionUuid: string): string {
  return `agent-pvc-${sessionUuid.slice(0, 8)}`;
}

function toPrewarmSnapshot(prewarm: AgentPrewarm | null): WorkspaceRuntimePrewarmSnapshot | null {
  return prewarm
    ? {
        uuid: prewarm.uuid,
        pvcName: prewarm.pvcName,
      }
    : null;
}

async function resolveCompatiblePrewarm(params: {
  buildUuid?: string | null;
  workspaceStorage: ResolvedAgentSessionWorkspaceStorageIntent;
  requestedServices: string[];
  revision?: string | null;
  workspaceRepos: AgentSessionWorkspaceRepo[];
  selectedServices: AgentSessionSelectedService[];
}): Promise<WorkspaceRuntimePrewarmSnapshot | null> {
  if (!params.buildUuid || params.workspaceStorage.requestedSize) {
    return null;
  }

  const prewarm = await new AgentPrewarmService().getCompatibleReadyPrewarm({
    buildUuid: params.buildUuid,
    requestedServices: params.requestedServices,
    revision: params.revision || undefined,
    workspaceRepos: params.workspaceRepos,
    requestedServiceRefs: params.selectedServices,
  });

  return toPrewarmSnapshot(prewarm);
}

export async function resolveWorkspaceRuntimePlan(
  opts: ResolveWorkspaceRuntimePlanOptions
): Promise<WorkspaceRuntimePlan> {
  const runtimeConfig = await resolveAgentSessionRuntimeConfig();
  const workspaceStorage = resolveAgentSessionWorkspaceStorageIntent({
    requestedSize: opts.workspaceStorageSize || null,
    storage: runtimeConfig.workspaceStorage,
  });
  const servicePlan =
    opts.kind === 'chat' && !opts.repoUrl && !opts.workspaceRepos?.length && !opts.services?.length
      ? {
          workspaceRepos: [],
          services: undefined,
          selectedServices: [],
        }
      : resolveAgentSessionServicePlan(
          {
            repoUrl: opts.repoUrl,
            branch: opts.branch,
            revision: opts.revision,
            workspaceRepos: opts.workspaceRepos,
          },
          opts.services
        );
  const skillPlan = resolveAgentSessionSkillPlan({
    environmentSkillRefs: opts.environmentSkillRefs,
    services: servicePlan.services || [],
  });
  const primaryWorkspaceRepo = servicePlan.workspaceRepos.find((repo) => repo.primary) || servicePlan.workspaceRepos[0];
  const providerUserIdentity = {
    userId: opts.userId,
    githubUsername: opts.userIdentity?.githubUsername || null,
  };
  const requestedProvider = opts.provider?.trim() || undefined;
  const requestedModelId = opts.model?.trim() || undefined;
  const selection = await AgentProviderRegistry.resolveSelection({
    repoFullName: primaryWorkspaceRepo?.repo,
    requestedProvider,
    requestedModelId,
  });
  const requestedServices = (servicePlan.services || []).map((service) => service.name);
  const [apiKey, credentialEnv, startupMcpServers, compatiblePrewarm, forwardedEnv] = await Promise.all([
    AgentProviderRegistry.getRequiredProviderApiKey({
      provider: selection.provider,
      userIdentity: providerUserIdentity,
      repoFullName: primaryWorkspaceRepo?.repo,
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
    resolveCompatiblePrewarm({
      buildUuid: opts.buildUuid,
      workspaceStorage,
      requestedServices,
      revision: primaryWorkspaceRepo?.revision || opts.revision,
      workspaceRepos: servicePlan.workspaceRepos,
      selectedServices: servicePlan.selectedServices,
    }),
    planForwardedAgentEnv(servicePlan.services, opts.sessionUuid),
  ]);
  const pvcName = compatiblePrewarm?.pvcName || buildNewPvcName(opts.sessionUuid);

  return {
    version: 1,
    kind: opts.kind,
    sessionUuid: opts.sessionUuid,
    namespace: opts.namespace,
    podName: buildWorkspacePodName(opts.sessionUuid, opts.buildUuid),
    apiKeySecretName: buildApiKeySecretName(opts.sessionUuid),
    runtimeConfig,
    workspaceStorage,
    servicePlan,
    skillPlan,
    provider: {
      selection,
      apiKey,
      credentialEnv,
    },
    startupMcp: {
      servers: startupMcpServers,
      serializedConfig: serializeSessionWorkspaceGatewayServers(startupMcpServers),
    },
    forwardedEnv,
    credentials: {
      hasGitHubToken: Boolean(opts.githubToken),
      githubToken: opts.githubToken || null,
    },
    prewarm: {
      compatiblePrewarm,
      pvcName,
      skipWorkspaceBootstrap: Boolean(compatiblePrewarm),
      ownsPvc: !compatiblePrewarm,
    },
  };
}

export function toWorkspaceRuntimePlanMetadata(plan: WorkspaceRuntimePlan): WorkspaceRuntimePlanMetadata {
  return {
    version: 1,
    pvcName: plan.prewarm.pvcName,
    ownsPvc: plan.prewarm.ownsPvc,
    skipWorkspaceBootstrap: plan.prewarm.skipWorkspaceBootstrap,
    compatiblePrewarmUuid: plan.prewarm.compatiblePrewarm?.uuid || null,
  };
}
