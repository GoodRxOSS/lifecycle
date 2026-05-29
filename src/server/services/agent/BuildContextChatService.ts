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

import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { AgentChatStatus, AgentSessionKind } from 'shared/constants';
import { NotFoundError, BadRequestError } from 'server/lib/appError';
import AgentChatSessionService, {
  type AgentBuildContextChatMetadata,
  type AgentBuildContextSelectedDeployMetadata,
} from './ChatSessionService';
import AgentThreadService from './ThreadService';

const ACTIVE_BUILD_CONTEXT_CHAT_UNIQUE_CONSTRAINT = 'agent_sessions_active_build_context_chat_unique';

export class BuildContextChatBuildNotFoundError extends NotFoundError {
  readonly buildUuid: string;
  constructor(buildUuid: string) {
    super(`Build not found: ${buildUuid}`, 'build_not_found', { buildUuid });
    this.name = 'BuildContextChatBuildNotFoundError';
    this.buildUuid = buildUuid;
  }
}

export class BuildContextChatSelectedDeployError extends BadRequestError {
  readonly buildUuid: string;
  readonly selectedDeployUuid: string;
  constructor(buildUuid: string, selectedDeployUuid: string) {
    super(
      `Selected deploy ${selectedDeployUuid} does not belong to build ${buildUuid}`,
      'build_selected_deploy_invalid',
      { buildUuid, selectedDeployUuid }
    );
    this.name = 'BuildContextChatSelectedDeployError';
    this.buildUuid = buildUuid;
    this.selectedDeployUuid = selectedDeployUuid;
  }
}

interface LaunchBuildContextChatOptions {
  buildUuid: string;
  selectedDeployUuid?: string;
  userId: string;
  userIdentity?: RequestUserIdentity;
  model?: string;
}

interface LaunchBuildContextChatResult {
  session: AgentSession;
  thread: AgentThread;
  created: boolean;
  reused: boolean;
  buildContext: AgentBuildContextChatMetadata;
}

function isUniqueConstraintError(error: unknown, constraintName: string): boolean {
  const knexError = error as { code?: string; constraint?: string };
  return knexError?.code === '23505' && knexError?.constraint === constraintName;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
}

function readFullCommitSha(value: unknown): string | null {
  const normalized = readString(value);
  return normalized && /^[0-9a-f]{40}$/i.test(normalized) ? normalized : null;
}

function buildSelectedDeployMetadata(deploy: Deploy): AgentBuildContextSelectedDeployMetadata {
  const deployable = deploy.deployable;
  const helm = deployable?.helm;
  const chart = helm?.chart;

  return {
    selectedDeployUuid: deploy.uuid,
    deployId: deploy.id,
    deployableName: readString(deployable?.name) || readString(deploy.service?.name) || deploy.uuid,
    deployableType: readString(deployable?.type),
    repositoryFullName: readString(deploy.repository?.fullName),
    branchName: readString(deploy.branchName) || readString(deployable?.branchName),
    serviceSha: readString(deploy.sha),
    dockerfilePath: readString(deployable?.dockerfilePath),
    initDockerfilePath: readString(deployable?.initDockerfilePath),
    deployStatus: readString(deploy.status),
    deployStatusMessage: readString(deploy.statusMessage),
    dockerImage: readString(deploy.dockerImage),
    buildPipelineId: readString(deploy.buildPipelineId),
    deployPipelineId: readString(deploy.deployPipelineId),
    source: readString(deployable?.source),
    helm: helm
      ? {
          chartName: readString(chart?.name),
          chartRepoUrl: readString(chart?.repoUrl),
          valueFiles: readStringArray(chart?.valueFiles),
        }
      : null,
  };
}

async function resolveSelectedDeploy(build: Build, selectedDeployUuid?: string): Promise<Deploy | null> {
  if (!selectedDeployUuid) {
    return null;
  }

  const selectedDeploy = await Deploy.query()
    .findOne({ uuid: selectedDeployUuid })
    .withGraphFetched('[deployable, repository, service]');
  if (!selectedDeploy || selectedDeploy.buildId !== build.id) {
    throw new BuildContextChatSelectedDeployError(build.uuid, selectedDeployUuid);
  }

  return selectedDeploy;
}

function buildLaunchMetadata(
  build: Build,
  buildUuid: string,
  selectedDeploy: Deploy | null
): AgentBuildContextChatMetadata {
  const pullRequest = build.pullRequest
    ? {
        fullName: build.pullRequest.fullName || null,
        branchName: build.pullRequest.branchName || null,
        pullRequestNumber: build.pullRequest.pullRequestNumber || null,
      }
    : null;

  return {
    buildUuid,
    buildKind: build.kind || null,
    namespace: build.namespace || null,
    baseBuildUuid: build.baseBuild?.uuid || null,
    revision: readFullCommitSha(build.pullRequest?.latestCommit) || readFullCommitSha(build.sha),
    pullRequest,
    selectedDeployUuid: selectedDeploy?.uuid || null,
    selectedDeploy: selectedDeploy ? buildSelectedDeployMetadata(selectedDeploy) : null,
    contextFreshAt: new Date().toISOString(),
  };
}

async function findReusableBuildContextChat(buildUuid: string, userId: string): Promise<AgentSession | undefined> {
  return AgentSession.query()
    .where({
      userId,
      buildUuid,
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      chatStatus: AgentChatStatus.READY,
    })
    .orderBy('updatedAt', 'desc')
    .orderBy('createdAt', 'desc')
    .first();
}

export default class BuildContextChatService {
  static async launchBuildContextChat(opts: LaunchBuildContextChatOptions): Promise<LaunchBuildContextChatResult> {
    const build = await Build.query().findOne({ uuid: opts.buildUuid }).withGraphFetched('[pullRequest, baseBuild]');
    if (!build) {
      throw new BuildContextChatBuildNotFoundError(opts.buildUuid);
    }

    const selectedDeploy = await resolveSelectedDeploy(build, opts.selectedDeployUuid);
    const buildContext = buildLaunchMetadata(build, opts.buildUuid, selectedDeploy);
    const existingSession = await findReusableBuildContextChat(opts.buildUuid, opts.userId);

    if (existingSession) {
      const thread = await AgentThreadService.getDefaultThreadForSession(existingSession.uuid, opts.userId);
      const session = await AgentChatSessionService.updateBuildContextChatSession(existingSession, buildContext);
      const reused = true;

      getLogger().info(
        `Session: launched build-context chat buildUuid=${opts.buildUuid} sessionId=${existingSession.uuid} reused=${reused}`
      );

      return {
        session,
        thread,
        created: false,
        reused,
        buildContext,
      };
    }

    let session: AgentSession;
    try {
      session = await AgentChatSessionService.createChatSession({
        userId: opts.userId,
        userIdentity: opts.userIdentity,
        model: opts.model,
        buildContext,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error, ACTIVE_BUILD_CONTEXT_CHAT_UNIQUE_CONSTRAINT)) {
        throw error;
      }

      const racedSession = await findReusableBuildContextChat(opts.buildUuid, opts.userId);
      if (!racedSession) {
        throw error;
      }

      const thread = await AgentThreadService.getDefaultThreadForSession(racedSession.uuid, opts.userId);
      const session = await AgentChatSessionService.updateBuildContextChatSession(racedSession, buildContext);

      getLogger().info(
        `Session: launched build-context chat buildUuid=${opts.buildUuid} sessionId=${racedSession.uuid} reused=true`
      );

      return {
        session,
        thread,
        created: false,
        reused: true,
        buildContext,
      };
    }

    const thread = await AgentThreadService.getDefaultThreadForSession(session.uuid, opts.userId);
    const reused = false;

    getLogger().info(
      `Session: launched build-context chat buildUuid=${opts.buildUuid} sessionId=${session.uuid} reused=${reused}`
    );

    return {
      session,
      thread,
      created: true,
      reused,
      buildContext,
    };
  }
}
