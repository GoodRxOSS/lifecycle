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

import AgentSession from 'server/models/AgentSession';
import AgentSource from 'server/models/AgentSource';
import { SESSION_WORKSPACE_ROOT } from 'server/lib/agentSession/workspace';
import { AgentSessionKind } from 'shared/constants';
import type { Transaction } from 'objection';
import type { ResolvedAgentSessionWorkspaceStorageIntent } from 'server/lib/agentSession/runtimeConfig';
import type { AgentBuildContextChatMetadata } from './ChatSessionService';

function deriveAdapter(session: AgentSession): string {
  if (session.sessionKind === 'chat') {
    return 'blank_workspace';
  }

  return session.buildKind === 'sandbox' ? 'lifecycle_fork' : 'lifecycle_environment';
}

function deriveStatus(session: AgentSession): AgentSource['status'] {
  if (session.status === 'ended') {
    return 'cleaned_up';
  }

  if (session.status === 'error') {
    return 'failed';
  }

  return 'ready';
}

function toTimestampString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return typeof value === 'string' ? value : null;
}

function buildContextSourceMetadata(session: AgentSession, buildContext?: AgentBuildContextChatMetadata) {
  return buildContext
    ? {
        buildUuid: buildContext.buildUuid,
        buildKind: buildContext.buildKind,
        sessionKind: session.sessionKind,
        namespace: buildContext.namespace,
        baseBuildUuid: buildContext.baseBuildUuid,
        revision: buildContext.revision,
        pullRequest: buildContext.pullRequest,
        selectedDeployUuid: buildContext.selectedDeployUuid || null,
        selectedDeploy: buildContext.selectedDeploy || null,
        contextFreshAt: buildContext.contextFreshAt,
      }
    : {
        buildUuid: session.buildUuid,
        buildKind: session.buildKind,
        sessionKind: session.sessionKind,
      };
}

export default class AgentSourceService {
  static async getSessionSource(sessionId: number, options: { trx?: Transaction } = {}): Promise<AgentSource | null> {
    return (await AgentSource.query(options.trx).findOne({ sessionId })) || null;
  }

  static async createSessionSource(
    session: AgentSession,
    options: {
      trx?: Transaction;
      workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
      buildContext?: AgentBuildContextChatMetadata;
      defaultProvider?: string | null;
    } = {}
  ): Promise<AgentSource> {
    const status = deriveStatus(session);
    const workspaceRepos = session.workspaceRepos ?? [];
    const primaryRepo = workspaceRepos.find((repo) => repo.primary) ?? workspaceRepos[0] ?? null;
    const workspaceLayout =
      session.sessionKind === AgentSessionKind.CHAT
        ? {
            repos: [],
            primaryPath: SESSION_WORKSPACE_ROOT,
          }
        : {
            repos: workspaceRepos,
            primaryPath: primaryRepo?.mountPath || SESSION_WORKSPACE_ROOT,
          };
    const metadata = buildContextSourceMetadata(session, options.buildContext);

    return AgentSource.query(options.trx).insertAndFetch({
      sessionId: session.id,
      adapter: deriveAdapter(session),
      status,
      input: {
        ...metadata,
        defaults: {
          provider: options.defaultProvider || null,
          model: session.defaultModel || session.model || null,
        },
        ...(options.workspaceStorage?.requestedSize
          ? {
              workspace: {
                storageSize: options.workspaceStorage.requestedSize,
              },
            }
          : {}),
      },
      preparedSource: {
        kind: 'workspace_snapshot',
        workspaceLayout,
        artifactRefs: [],
        metadata,
      },
      sandboxRequirements: {
        filesystem: 'persistent',
        suspendMode: session.sessionKind === AgentSessionKind.CHAT ? 'filesystem' : 'none',
        editorAccess: true,
        previewPorts: true,
      },
      error: status === 'failed' ? { message: 'Source failed' } : null,
      preparedAt: status === 'cleaned_up' ? null : toTimestampString(session.updatedAt) || new Date().toISOString(),
      cleanedUpAt:
        status === 'cleaned_up'
          ? toTimestampString(session.endedAt) || toTimestampString(session.updatedAt) || new Date().toISOString()
          : null,
    } as Partial<AgentSource>);
  }

  static async updateSessionBuildContext(
    session: AgentSession,
    buildContext: AgentBuildContextChatMetadata,
    options: { trx?: Transaction } = {}
  ): Promise<AgentSource | null> {
    const existing = await this.getSessionSource(session.id, options);
    if (!existing) {
      return null;
    }

    const metadata = buildContextSourceMetadata(session, buildContext);
    const input = existing.input && typeof existing.input === 'object' ? existing.input : {};
    const preparedSource =
      existing.preparedSource && typeof existing.preparedSource === 'object' ? existing.preparedSource : {};

    return AgentSource.query(options.trx).patchAndFetchById(existing.id, {
      input: {
        ...input,
        ...metadata,
      },
      preparedSource: {
        ...preparedSource,
        metadata,
      },
      preparedAt: toTimestampString(session.updatedAt) || new Date().toISOString(),
    } as Partial<AgentSource>);
  }

  static async recordSessionState(
    session: AgentSession,
    options: { trx?: Transaction } = {}
  ): Promise<AgentSource | null> {
    const existing = await this.getSessionSource(session.id, options);
    if (!existing) {
      return null;
    }

    const status = deriveStatus(session);
    const patch: Partial<AgentSource> = {};

    if (existing.status !== status) {
      patch.status = status;
    }

    if (status === 'failed' && !existing.error) {
      patch.error = { message: 'Source failed' };
    }

    if (status === 'cleaned_up' && !existing.cleanedUpAt) {
      patch.cleanedUpAt =
        toTimestampString(session.endedAt) || toTimestampString(session.updatedAt) || new Date().toISOString();
    }

    if (Object.keys(patch).length === 0) {
      return existing;
    }

    return AgentSource.query(options.trx).patchAndFetchById(existing.id, patch);
  }
}
