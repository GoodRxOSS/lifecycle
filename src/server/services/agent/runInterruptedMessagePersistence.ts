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

import { getLogger } from 'server/lib/logger';
import AgentThread from 'server/models/AgentThread';
import type AgentRun from 'server/models/AgentRun';
import { rebuildAssistantMessageFromEvents } from './LifecycleAiSdkHarness';
import AgentMessageStore from './MessageStore';
import type { AgentUIMessage } from './types';

const INTERRUPTED_PENDING_APPROVAL_ERROR =
  'The run ended before this approval was answered; the action did not execute.';
const INTERRUPTED_APPROVED_ERROR =
  'The run ended before this approved action reported a result; it may have already executed — verify before re-applying.';
const INTERRUPTED_TOOL_ERROR = 'The run ended before this tool call completed.';

function isToolPart(part: Record<string, unknown>): boolean {
  return typeof part.type === 'string' && (part.type === 'dynamic-tool' || part.type.startsWith('tool-'));
}

/** Unsettled tool states are not persisted; settle them as output-error so an approved write is never silently re-applied. */
export function settleInterruptedToolParts(message: AgentUIMessage): AgentUIMessage {
  return {
    ...message,
    parts: message.parts.map((rawPart) => {
      const part = rawPart as unknown as Record<string, unknown>;
      if (!isToolPart(part)) {
        return rawPart;
      }

      if (part.state === 'approval-requested' || part.state === 'approval-responded') {
        const approval =
          part.approval && typeof part.approval === 'object' ? (part.approval as Record<string, unknown>) : null;
        const approved = part.state === 'approval-responded' && approval?.approved === true;
        return {
          ...part,
          state: 'output-error',
          errorText: approved ? INTERRUPTED_APPROVED_ERROR : INTERRUPTED_PENDING_APPROVAL_ERROR,
        } as AgentUIMessage['parts'][number];
      }

      if (part.state === 'input-streaming' || part.state === 'input-available') {
        return {
          ...part,
          state: 'output-error',
          errorText: INTERRUPTED_TOOL_ERROR,
        } as AgentUIMessage['parts'][number];
      }

      return rawPart;
    }),
  };
}

/** Best-effort: keep an interrupted run's partial output; events stop replaying once the thread moves on. */
export async function persistInterruptedRunAssistantMessage(
  run: Pick<AgentRun, 'id' | 'uuid' | 'threadId'>
): Promise<void> {
  try {
    const message = await rebuildAssistantMessageFromEvents(run.uuid);
    if (!message) {
      return;
    }

    const thread = await AgentThread.query().findById(run.threadId);
    if (!thread) {
      return;
    }

    await AgentMessageStore.upsertCanonicalUiMessagesForThread(thread, [settleInterruptedToolParts(message)], {
      runId: run.id,
    });
  } catch (error) {
    getLogger().warn(
      { error, runId: run.uuid },
      `AgentExec: interrupted-run message persistence failed runId=${run.uuid}`
    );
  }
}
