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

export default class AgentSourceService {
  static async getSessionSource(sessionId: number, options: { trx?: Transaction } = {}): Promise<AgentSource | null> {
    return AgentSource.query(options.trx).findOne({ sessionId });
  }

  static async createSessionSource(
    session: AgentSession,
    options: { trx?: Transaction; workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent } = {}
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

    return AgentSource.query(options.trx).insertAndFetch({
      sessionId: session.id,
      adapter: deriveAdapter(session),
      status,
      input: {
        buildUuid: session.buildUuid,
        buildKind: session.buildKind,
        sessionKind: session.sessionKind,
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
        metadata: {
          buildUuid: session.buildUuid,
          buildKind: session.buildKind,
          sessionKind: session.sessionKind,
        },
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
