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

import { isToolMessagePart } from './agentInputNormalization';
import type { AgentUIMessage } from './types';

// Effective context is well below advertised limits (long-context recall degrades from ~32k tokens),
// so pruning starts at half the window rather than at the hard ceiling.
const PRUNE_TRIGGER_RATIO = 0.5;
const KEEP_RECENT_ASSISTANT_TURNS = 3;
const MIN_PRUNABLE_OUTPUT_CHARS = 2_000;
const APPROX_CHARS_PER_TOKEN = 4;

const MODEL_CONTEXT_WINDOW_PATTERNS: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /gemini-[23]/i, tokens: 1_000_000 },
  { pattern: /claude/i, tokens: 200_000 },
  { pattern: /gpt-5/i, tokens: 400_000 },
  { pattern: /^o[0-9]/i, tokens: 200_000 },
];
const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;

export function resolveModelContextWindowTokens(modelId: string | null | undefined): number {
  if (!modelId) {
    return DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
  }

  const match = MODEL_CONTEXT_WINDOW_PATTERNS.find(({ pattern }) => pattern.test(modelId));
  return match?.tokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
}

function estimateTokens(value: unknown): number {
  try {
    return Math.ceil((JSON.stringify(value) ?? '').length / APPROX_CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

function toolNameOfPart(part: Record<string, unknown>): string {
  if (typeof part.toolName === 'string' && part.toolName) {
    return part.toolName;
  }
  const type = typeof part.type === 'string' ? part.type : '';
  return type.startsWith('tool-') ? type.slice('tool-'.length) : 'tool';
}

/**
 * Model-input-only pruning of stale tool outputs. Old successful outputs are the bulk of a long
 * debug thread and mostly dead weight; errors and denials stay (they carry decisions), the last
 * few assistant turns stay whole, and the part's input stays so the model can re-issue the call.
 * Durable rows are untouched — the UI keeps everything. Deterministic for a given message list;
 * when active it trades one cross-run cache write for context quality (within-run caching is
 * unaffected because pruning happens once at run bootstrap).
 */
export function pruneStaleToolOutputsForModelInput(
  messages: AgentUIMessage[],
  { contextWindowTokens }: { contextWindowTokens: number }
): AgentUIMessage[] {
  if (estimateTokens(messages) < contextWindowTokens * PRUNE_TRIGGER_RATIO) {
    return messages;
  }

  let assistantSeen = 0;
  let cutoff = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      assistantSeen += 1;
      if (assistantSeen >= KEEP_RECENT_ASSISTANT_TURNS) {
        cutoff = index;
        break;
      }
    }
  }
  if (cutoff <= 0) {
    return messages;
  }

  let changed = false;
  const pruned = messages.map((message, index) => {
    if (index >= cutoff || message.role !== 'assistant') {
      return message;
    }

    let messageChanged = false;
    const parts = message.parts.map((rawPart) => {
      if (!isToolMessagePart(rawPart)) {
        return rawPart;
      }

      const part = rawPart as Record<string, unknown>;
      if (part.state !== 'output-available' || !('output' in part)) {
        return rawPart;
      }

      const outputSize = (() => {
        try {
          return (JSON.stringify(part.output) ?? '').length;
        } catch {
          return 0;
        }
      })();
      if (outputSize < MIN_PRUNABLE_OUTPUT_CHARS) {
        return rawPart;
      }

      messageChanged = true;
      return {
        ...part,
        output: `[elided ~${Math.round(outputSize / 1000)}k chars from an earlier successful ${toolNameOfPart(
          part
        )} call — call the tool again if the details are needed]`,
      } as AgentUIMessage['parts'][number];
    });

    if (!messageChanged) {
      return message;
    }

    changed = true;
    return { ...message, parts };
  });

  return changed ? pruned : messages;
}
