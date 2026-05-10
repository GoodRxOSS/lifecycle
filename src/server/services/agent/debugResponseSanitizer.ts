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

import type { AgentUIMessage } from './types';

const OBSERVE_ACTION_LINE_RE = /^\s*(?:[-*]|\d+\.)?\s*(?:\*\*)?Observe(?:\*\*)?\s*:\s*.*$/gim;
const CONTINUE_MONITORING_LINE_RE = /^\s*I will continue to monitor[^\n]*(?:\n|$)/gim;

export function sanitizeDebugRepairAssistantText(text: string): string {
  return text
    .replace(CONTINUE_MONITORING_LINE_RE, '')
    .replace(OBSERVE_ACTION_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function assistantRunHasText(messages: AgentUIMessage[], runId: string, text: string): boolean {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return true;
  }

  return messages.some((message) => {
    if (message.role !== 'assistant' || message.metadata?.runId !== runId) {
      return false;
    }

    return message.parts.some((part) => {
      return part.type === 'text' && typeof part.text === 'string' && part.text.includes(normalizedText);
    });
  });
}

export function sanitizeDebugRepairAssistantMessages(messages: AgentUIMessage[], runId: string): AgentUIMessage[] {
  const lastUserMessageIndex = messages.reduce((lastIndex, message, index) => {
    return message.role === 'user' ? index : lastIndex;
  }, -1);
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    const isCurrentRunAssistant = message.metadata?.runId === runId || index > lastUserMessageIndex;
    if (message.role !== 'assistant' || !isCurrentRunAssistant) {
      return message;
    }

    let messageChanged = false;
    const nextParts = message.parts.map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') {
        return part;
      }

      const sanitizedText = sanitizeDebugRepairAssistantText(part.text);
      if (sanitizedText === part.text) {
        return part;
      }

      changed = true;
      messageChanged = true;
      return { ...part, text: sanitizedText };
    });

    return messageChanged ? { ...message, parts: nextParts } : message;
  });

  return changed ? nextMessages : messages;
}
