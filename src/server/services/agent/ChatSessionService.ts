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

import { v4 as uuid } from 'uuid';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import { EMPTY_AGENT_SESSION_SKILL_PLAN } from 'server/lib/agentSession/skillPlan';
import {
  SESSION_WORKSPACE_ROOT,
  normalizeSessionWorkspaceRepo,
  type AgentSessionSelectedService,
  type AgentSessionWorkspaceRepo,
} from 'server/lib/agentSession/workspace';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus, BuildKind } from 'shared/constants';
import AgentProviderRegistry from './ProviderRegistry';
import AgentSourceService from './SourceService';
import AgentThreadRuntimeControlsService, {
  type AgentThreadRuntimeControlChoiceInput,
  type ValidatedEntryRuntimeControlChoices,
} from './ThreadRuntimeControlsService';
import type { ResolvedAgentSessionWorkspaceStorageIntent } from 'server/lib/agentSession/runtimeConfig';

export interface AgentBuildContextChatMetadata {
  buildUuid: string;
  buildKind: BuildKind | null;
  namespace: string | null;
  baseBuildUuid: string | null;
  revision: string | null;
  pullRequest: {
    fullName: string | null;
    branchName: string | null;
    pullRequestNumber: number | null;
  } | null;
  selectedDeployUuid?: string | null;
  selectedDeploy?: AgentBuildContextSelectedDeployMetadata | null;
  contextFreshAt: string;
}

export interface AgentBuildContextSelectedDeployMetadata {
  selectedDeployUuid: string;
  deployId: number;
  deployableName: string | null;
  deployableType: string | null;
  repositoryFullName: string | null;
  branchName: string | null;
  serviceSha: string | null;
  dockerfilePath: string | null;
  initDockerfilePath: string | null;
  deployStatus: string | null;
  deployStatusMessage: string | null;
  dockerImage: string | null;
  buildPipelineId: string | null;
  deployPipelineId: string | null;
  source: string | null;
  helm: {
    chartName: string | null;
    chartRepoUrl: string | null;
    valueFiles: string[];
  } | null;
}

export interface CreateChatSessionOptions {
  userId: string;
  userIdentity?: RequestUserIdentity;
  provider?: string;
  model?: string;
  runtimeControlChoices?: AgentThreadRuntimeControlChoiceInput;
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
  buildContext?: AgentBuildContextChatMetadata;
}

function buildContextWorkspaceRepos(buildContext?: AgentBuildContextChatMetadata): AgentSessionWorkspaceRepo[] {
  const { repo, branch } = resolveBuildContextWorkspaceRepoAndBranch(buildContext);
  if (!repo || !branch) {
    return [];
  }

  return [
    normalizeSessionWorkspaceRepo(
      {
        repo,
        repoUrl: `https://github.com/${repo}.git`,
        branch,
        revision: resolveBuildContextWorkspaceRevision(buildContext, repo),
      },
      true
    ),
  ];
}

function resolveBuildContextWorkspaceRepoAndBranch(buildContext?: AgentBuildContextChatMetadata): {
  repo: string | null;
  branch: string | null;
} {
  const pullRequestRepo = buildContext?.pullRequest?.fullName?.trim() || null;
  const pullRequestBranch = buildContext?.pullRequest?.branchName?.trim() || null;
  const selectedRepo = buildContext?.selectedDeploy?.repositoryFullName?.trim() || null;
  const selectedBranch = buildContext?.selectedDeploy?.branchName?.trim() || null;

  if (selectedRepo && selectedRepo !== pullRequestRepo) {
    return {
      repo: selectedRepo,
      branch: selectedBranch,
    };
  }

  return {
    repo: pullRequestRepo || selectedRepo,
    branch: pullRequestBranch || selectedBranch,
  };
}

function readFullCommitSha(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value.trim()) ? value.trim() : null;
}

function resolveBuildContextWorkspaceRevision(
  buildContext: AgentBuildContextChatMetadata | undefined,
  repo: string
): string | null {
  const pullRequestRepo = buildContext?.pullRequest?.fullName?.trim() || null;
  const selectedDeployRepo = buildContext?.selectedDeploy?.repositoryFullName?.trim() || null;

  if (pullRequestRepo === repo) {
    return readFullCommitSha(buildContext?.revision);
  }

  if (selectedDeployRepo === repo) {
    return readFullCommitSha(buildContext?.selectedDeploy?.serviceSha);
  }

  return readFullCommitSha(buildContext?.revision);
}

function resolveBuildContextSelectedServiceRevision(
  buildContext: AgentBuildContextChatMetadata | undefined,
  repo: string
): string | null {
  const pullRequestRepo = buildContext?.pullRequest?.fullName?.trim() || null;
  return (
    readFullCommitSha(buildContext?.selectedDeploy?.serviceSha) ||
    (pullRequestRepo === repo ? readFullCommitSha(buildContext?.revision) : null)
  );
}

function buildContextSelectedServices(buildContext?: AgentBuildContextChatMetadata): AgentSessionSelectedService[] {
  const selectedDeploy = buildContext?.selectedDeploy;
  const repo = selectedDeploy?.repositoryFullName?.trim() || buildContext?.pullRequest?.fullName?.trim();
  const branch = selectedDeploy?.branchName?.trim() || buildContext?.pullRequest?.branchName?.trim();
  const name = selectedDeploy?.deployableName?.trim() || selectedDeploy?.selectedDeployUuid?.trim();
  if (!selectedDeploy || !name || !repo || !branch) {
    return [];
  }

  return [
    {
      name,
      deployId: selectedDeploy.deployId,
      deployUuid: selectedDeploy.selectedDeployUuid,
      repo,
      branch,
      revision: resolveBuildContextSelectedServiceRevision(buildContext, repo),
      deployableType: selectedDeploy.deployableType,
      dockerfilePath: selectedDeploy.dockerfilePath,
      initDockerfilePath: selectedDeploy.initDockerfilePath,
      deployStatus: selectedDeploy.deployStatus,
      deployStatusMessage: selectedDeploy.deployStatusMessage,
      dockerImage: selectedDeploy.dockerImage,
      buildPipelineId: selectedDeploy.buildPipelineId,
      deployPipelineId: selectedDeploy.deployPipelineId,
      chartName: selectedDeploy.helm?.chartName || null,
      chartRepoUrl: selectedDeploy.helm?.chartRepoUrl || null,
      chartValueFiles: selectedDeploy.helm?.valueFiles || [],
      source: selectedDeploy.source,
      workspacePath: SESSION_WORKSPACE_ROOT,
      workDir: null,
    },
  ];
}

export default class AgentChatSessionService {
  static async createChatSession(opts: CreateChatSessionOptions): Promise<AgentSession> {
    const sessionUuid = uuid();
    const requestedProvider = opts.provider?.trim() || undefined;
    const requestedModelId = opts.model?.trim() || undefined;
    const providerUserIdentity = {
      userId: opts.userId,
      githubUsername: opts.userIdentity?.githubUsername || null,
    };
    const workspaceRepos = buildContextWorkspaceRepos(opts.buildContext);
    const selectedServices = buildContextSelectedServices(opts.buildContext);
    const primaryWorkspaceRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0];
    const selection = await AgentProviderRegistry.resolveSelection({
      repoFullName: primaryWorkspaceRepo?.repo,
      requestedProvider,
      requestedModelId,
    });
    await AgentProviderRegistry.getRequiredProviderApiKey({
      provider: selection.provider,
      userIdentity: providerUserIdentity,
      repoFullName: primaryWorkspaceRepo?.repo,
    });
    let validatedRuntimeControlChoices: ValidatedEntryRuntimeControlChoices | null = null;
    if (opts.runtimeControlChoices) {
      if (!opts.userIdentity) {
        throw new Error('userIdentity is required when runtimeControlChoices are provided.');
      }

      validatedRuntimeControlChoices = await AgentThreadRuntimeControlsService.validateEntryChoices({
        userIdentity: opts.userIdentity,
        agentId: opts.runtimeControlChoices.agentId,
        source: {
          adapter: 'blank_workspace',
          input: opts.buildContext?.buildUuid ? { buildUuid: opts.buildContext.buildUuid } : {},
        },
        defaults: {
          provider: requestedProvider || null,
          model: requestedModelId || null,
        },
        runtimeControlChoices: opts.runtimeControlChoices,
      });
    }

    const finalizedSession = await AgentSession.transaction(async (trx) => {
      const session = await AgentSession.query(trx).insertAndFetch({
        uuid: sessionUuid,
        defaultThreadId: null,
        defaultModel: selection.modelId,
        defaultHarness: 'lifecycle_ai_sdk',
        buildUuid: opts.buildContext?.buildUuid ?? null,
        buildKind: null,
        sessionKind: AgentSessionKind.CHAT,
        userId: opts.userId,
        ownerGithubUsername: opts.userIdentity?.githubUsername || null,
        podName: null,
        namespace: null,
        pvcName: null,
        model: selection.modelId,
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.NONE,
        keepAttachedServicesOnSessionNode: null,
        devModeSnapshots: {},
        forwardedAgentSecretProviders: [],
        workspaceRepos,
        selectedServices,
        skillPlan: EMPTY_AGENT_SESSION_SKILL_PLAN,
      } as unknown as Partial<AgentSession>);

      const defaultThread = await AgentThread.query(trx).insertAndFetch({
        sessionId: session.id,
        title: 'Default thread',
        isDefault: true,
        metadata: {
          sessionUuid: session.uuid,
          ...(validatedRuntimeControlChoices?.selectedAgentMetadataPatch || {}),
          ...(validatedRuntimeControlChoices?.runtimeControlChoices
            ? {
                runtimeControlChoices: validatedRuntimeControlChoices.runtimeControlChoices,
              }
            : {}),
        },
      } as Partial<AgentThread>);

      await AgentSourceService.createSessionSource(session, {
        trx,
        workspaceStorage: opts.workspaceStorage,
        buildContext: opts.buildContext,
        defaultProvider: selection.provider,
      });

      return AgentSession.query(trx).patchAndFetchById(session.id, {
        defaultThreadId: defaultThread.id,
      } as Partial<AgentSession>);
    });

    getLogger().info(`Session: created chat sessionId=${sessionUuid} workspaceStatus=none`);
    return finalizedSession;
  }

  static async updateBuildContextChatSession(
    session: AgentSession,
    buildContext: AgentBuildContextChatMetadata
  ): Promise<AgentSession> {
    const workspaceRepos = buildContextWorkspaceRepos(buildContext);
    const selectedServices = buildContextSelectedServices(buildContext);
    const updatedSession = await AgentSession.query().patchAndFetchById(session.id, {
      workspaceRepos,
      selectedServices,
    } as unknown as Partial<AgentSession>);

    await AgentSourceService.updateSessionBuildContext(updatedSession, buildContext);

    return updatedSession;
  }
}
