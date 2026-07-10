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

import type { ToolSet } from 'ai';
import type { AgentUIMessage } from './types';

/**
 * Durable system-role rows (agent switches, runtime-controls updates, environment updates) exist for
 * the transcript AND for the model, but ai's standardizePrompt rejects role:'system' inside messages.
 * Project them to user-role conversation-event notes for model input; the stored row stays system.
 */
export function projectSystemEventMessagesForAgentInput(messages: AgentUIMessage[]): AgentUIMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    if (message.role !== 'system') {
      return message;
    }

    changed = true;
    return {
      ...message,
      role: 'user' as const,
      parts: message.parts.map((part) =>
        part.type === 'text' ? { ...part, text: `[Conversation event] ${part.text}` } : part
      ),
    };
  });

  return changed ? projected : messages;
}

export function isToolMessagePart(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'));
}

/**
 * The contract seam between persisted run history and the SDK's fail-closed input validation: every
 * persisted tool-part shape, replayed against whatever ToolSet this run resolved, must come out of
 * here in a form safeValidateUIMessages accepts — validation failure kills the resume with a
 * user-facing terminal error. Covered by agentInputNormalization.contract.test.ts, which runs the
 * REAL validator over the full shape matrix; extend the matrix there when adding a repair here.
 */
export function normalizeUnavailableToolPartsForAgentInput(
  messages: AgentUIMessage[],
  tools: ToolSet
): AgentUIMessage[] {
  const availableToolNames = new Set(Object.keys(tools));
  let messagesChanged = false;

  const normalizedMessages = messages.map((message) => {
    let messageChanged = false;
    const parts = message.parts.map((rawPart) => {
      if (!isToolMessagePart(rawPart)) {
        return rawPart;
      }

      const part = rawPart as Record<string, unknown>;
      const partType = typeof part.type === 'string' ? part.type : '';
      const staticToolName = partType.startsWith('tool-') ? partType.slice('tool-'.length) : null;
      let nextPart = part;
      let partChanged = false;

      if (staticToolName && !availableToolNames.has(staticToolName)) {
        nextPart = {
          ...nextPart,
          type: 'dynamic-tool',
          toolName: staticToolName,
        };
        partChanged = true;
      }

      if (
        (nextPart.state === 'output-available' ||
          nextPart.state === 'output-error' ||
          nextPart.state === 'output-denied') &&
        !Object.prototype.hasOwnProperty.call(nextPart, 'input')
      ) {
        nextPart = {
          ...nextPart,
          input: nextPart.rawInput,
        };
        partChanged = true;
      }

      // Server-side auto-approval (session "always allow") stamps only the approval id, never a client
      // approval-response, so a resolved part keeps `approval: { id }`. The SDK message schema requires
      // `approved` once the call resolved, so that shape fails re-validation and breaks resume. A resolved
      // call was necessarily approved (denials carry output-denied), so fill the missing decision.
      const approval =
        nextPart.approval && typeof nextPart.approval === 'object'
          ? (nextPart.approval as Record<string, unknown>)
          : null;
      if (
        approval &&
        typeof approval.approved !== 'boolean' &&
        (nextPart.state === 'output-available' ||
          nextPart.state === 'output-error' ||
          nextPart.state === 'output-denied')
      ) {
        nextPart = {
          ...nextPart,
          approval: { ...approval, approved: nextPart.state !== 'output-denied' },
        };
        partChanged = true;
      }

      if (!partChanged) {
        return rawPart;
      }

      messageChanged = true;
      return nextPart as AgentUIMessage['parts'][number];
    });

    if (!messageChanged) {
      return message;
    }

    messagesChanged = true;
    return {
      ...message,
      parts,
    };
  });

  return messagesChanged ? normalizedMessages : messages;
}
