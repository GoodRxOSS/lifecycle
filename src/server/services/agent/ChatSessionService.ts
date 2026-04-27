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
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';
import AgentProviderRegistry from './ProviderRegistry';
import AgentSourceService from './SourceService';
import type { ResolvedAgentSessionWorkspaceStorageIntent } from 'server/lib/agentSession/runtimeConfig';

export interface CreateChatSessionOptions {
  userId: string;
  userIdentity?: RequestUserIdentity;
  model?: string;
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
}

export default class AgentChatSessionService {
  static async createChatSession(opts: CreateChatSessionOptions): Promise<AgentSession> {
    const sessionUuid = uuid();
    const requestedModelId = opts.model?.trim() || undefined;
    const providerUserIdentity = {
      userId: opts.userId,
      githubUsername: opts.userIdentity?.githubUsername || null,
    };
    const selection = await AgentProviderRegistry.resolveSelection({
      requestedModelId,
    });
    await AgentProviderRegistry.getRequiredStoredApiKey({
      provider: selection.provider,
      userIdentity: providerUserIdentity,
    });

    const finalizedSession = await AgentSession.transaction(async (trx) => {
      const session = await AgentSession.query(trx).insertAndFetch({
        uuid: sessionUuid,
        defaultThreadId: null,
        defaultModel: selection.modelId,
        defaultHarness: 'lifecycle_ai_sdk',
        buildUuid: null,
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
        workspaceRepos: [],
        selectedServices: [],
        skillPlan: EMPTY_AGENT_SESSION_SKILL_PLAN,
      } as unknown as Partial<AgentSession>);

      const defaultThread = await AgentThread.query(trx).insertAndFetch({
        sessionId: session.id,
        title: 'Default thread',
        isDefault: true,
        metadata: {
          sessionUuid: session.uuid,
        },
      } as Partial<AgentThread>);

      await AgentSourceService.createSessionSource(session, { trx, workspaceStorage: opts.workspaceStorage });

      return AgentSession.query(trx).patchAndFetchById(session.id, {
        defaultThreadId: defaultThread.id,
      } as Partial<AgentSession>);
    });

    getLogger().info(`Session: created chat sessionId=${sessionUuid} workspaceStatus=none`);
    return finalizedSession;
  }
}
