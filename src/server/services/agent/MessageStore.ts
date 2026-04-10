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

import type { PartialModelObject } from 'objection';
import AgentMessage from 'server/models/AgentMessage';
import AgentRun from 'server/models/AgentRun';
import type { AgentUIMessage } from './types';
import AgentThreadService from './ThreadService';

function toAgentUiMessage(message: AgentMessage): AgentUIMessage {
  return message.uiMessage as unknown as AgentUIMessage;
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function getUiMessageId(value: Pick<AgentUIMessage, 'id'> | AgentMessage): string | null {
  if ('uiMessage' in value) {
    const messageId = (value.uiMessage as { id?: unknown } | null | undefined)?.id;
    return typeof messageId === 'string' && messageId.trim() ? messageId : null;
  }

  return typeof value.id === 'string' && value.id.trim() ? value.id : null;
}

export default class AgentMessageStore {
  static async listMessages(threadUuid: string, userId: string): Promise<AgentUIMessage[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    const rows = await AgentMessage.query().where({ threadId: thread.id }).orderBy('createdAt', 'asc');
    return rows.map(toAgentUiMessage);
  }

  static async listRunMessages(runUuid: string, userId: string): Promise<AgentUIMessage[]> {
    const rows = await AgentMessage.query()
      .alias('message')
      .joinRelated('run.thread.session')
      .where('run.uuid', runUuid)
      .where('run:thread:session.userId', userId)
      .select('message.*')
      .orderBy('message.createdAt', 'asc');

    return rows.map(toAgentUiMessage);
  }

  static async syncMessages(
    threadUuid: string,
    userId: string,
    messages: AgentUIMessage[],
    runUuid?: string
  ): Promise<AgentUIMessage[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    const run = runUuid ? await AgentRun.query().findOne({ uuid: runUuid, threadId: thread.id }) : null;
    const runId = run?.id ?? null;
    const existing = await AgentMessage.query().where({ threadId: thread.id });
    const existingByMessageId = new Map(
      existing.map((message) => [getUiMessageId(message), message]).filter(([messageId]) => !!messageId) as Array<
        [string, AgentMessage]
      >
    );

    for (const message of messages) {
      const uiMessageId = getUiMessageId(message);
      if (!uiMessageId) {
        continue;
      }

      const row = existingByMessageId.get(uiMessageId);
      const metadata = toJsonRecord(message.metadata || {});
      const patch: PartialModelObject<AgentMessage> = {
        role: message.role,
        uiMessage: toJsonRecord(message),
        metadata,
        runId: message.role === 'assistant' && runId ? runId : row?.runId ?? null,
      };

      if (!row) {
        const inserted = await AgentMessage.query().insert({
          threadId: thread.id,
          ...patch,
        });
        existingByMessageId.set(uiMessageId, inserted);
        continue;
      }

      await AgentMessage.query().patchAndFetchById(row.id, patch);
    }

    const reloaded = await AgentMessage.query().where({ threadId: thread.id }).orderBy('createdAt', 'asc');
    return reloaded.map(toAgentUiMessage);
  }
}
