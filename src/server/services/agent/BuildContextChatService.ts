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
import { AgentChatStatus, AgentSessionKind } from 'shared/constants';
import AgentChatSessionService, { type AgentBuildContextChatMetadata } from './ChatSessionService';
import AgentThreadService from './ThreadService';

const ACTIVE_BUILD_CONTEXT_CHAT_UNIQUE_CONSTRAINT = 'agent_sessions_active_build_context_chat_unique';

export class BuildContextChatBuildNotFoundError extends Error {
  constructor(readonly buildUuid: string) {
    super(`Build not found: ${buildUuid}`);
    this.name = 'BuildContextChatBuildNotFoundError';
  }
}

interface LaunchBuildContextChatOptions {
  buildUuid: string;
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

function buildLaunchMetadata(build: Build, buildUuid: string): AgentBuildContextChatMetadata {
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
    revision: build.sha || build.pullRequest?.latestCommit || null,
    pullRequest,
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

    const buildContext = buildLaunchMetadata(build, opts.buildUuid);
    const existingSession = await findReusableBuildContextChat(opts.buildUuid, opts.userId);

    if (existingSession) {
      const thread = await AgentThreadService.getDefaultThreadForSession(existingSession.uuid, opts.userId);
      const reused = true;

      getLogger().info(
        `Session: launched build-context chat buildUuid=${opts.buildUuid} sessionId=${existingSession.uuid} reused=${reused}`
      );

      return {
        session: existingSession,
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

      getLogger().info(
        `Session: launched build-context chat buildUuid=${opts.buildUuid} sessionId=${racedSession.uuid} reused=true`
      );

      return {
        session: racedSession,
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
