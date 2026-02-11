/**
 * Copyright 2025 GoodRx, Inc.
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

import { ConversationMessage, MessagePart, ToolResultPart } from '../types/message';
import { countTokens } from '../prompts/tokenCounter';

export interface MaskingOptions {
  recencyWindow: number;
  tokenThreshold: number;
}

export interface MaskingStats {
  totalTokensBefore: number;
  totalTokensAfter: number;
  maskedParts: number;
  savedTokens: number;
}

export interface MaskingResult {
  messages: ConversationMessage[];
  masked: boolean;
  stats: MaskingStats;
}

// Validated against eval scenarios and provider limits (anthropic=180K, openai=110K, gemini=900K).
// System prompt uses ~8K tokens. With 10 tool calls averaging ~3K tokens each, conversations
// reach ~38-50K tokens by step 7-8. Threshold of 40000 activates masking before the conversation
// consumes more than ~36% of the smallest context window (openai 110K), leaving headroom for
// continued reasoning. recencyWindow=3 preserves the immediate investigation context (current
// tool result plus the two preceding results that inform the agent's next action).
const DEFAULT_OPTIONS: MaskingOptions = {
  recencyWindow: 3,
  tokenThreshold: 25000,
};

function estimatePartTokens(part: MessagePart): number {
  switch (part.type) {
    case 'text':
      return countTokens(part.content);
    case 'tool_call':
      return countTokens(JSON.stringify(part.arguments)) + countTokens(part.name);
    case 'tool_result':
      return countTokens(part.result.agentContent || JSON.stringify(part.result));
  }
}

function estimateConversationTokens(messages: ConversationMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      total += estimatePartTokens(part);
    }
  }
  return total;
}

function hasToolResultPart(msg: ConversationMessage): boolean {
  return msg.parts.some((p) => p.type === 'tool_result');
}

function findProtectedBoundary(messages: ConversationMessage[], windowSize: number): number {
  let toolResultCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasToolResultPart(messages[i])) {
      toolResultCount++;
      if (toolResultCount >= windowSize) {
        return i;
      }
    }
  }
  return 0;
}

function buildPlaceholder(part: ToolResultPart): string {
  return `[${part.name} output omitted — re-call tool if needed]`;
}

function maskToolResultsInMessage(msg: ConversationMessage): ConversationMessage {
  const newParts = msg.parts.map((part): MessagePart => {
    if (part.type === 'tool_result' && part.result.success !== false) {
      return {
        ...part,
        result: {
          ...part.result,
          agentContent: buildPlaceholder(part),
        },
      } as ToolResultPart;
    }
    return part;
  });
  return { ...msg, parts: newParts };
}

export function maskObservations(messages: ConversationMessage[], options?: Partial<MaskingOptions>): MaskingResult {
  const opts: MaskingOptions = { ...DEFAULT_OPTIONS, ...options };

  const totalTokensBefore = estimateConversationTokens(messages);

  if (totalTokensBefore < opts.tokenThreshold) {
    return {
      messages,
      masked: false,
      stats: {
        totalTokensBefore,
        totalTokensAfter: totalTokensBefore,
        maskedParts: 0,
        savedTokens: 0,
      },
    };
  }

  const boundary = findProtectedBoundary(messages, opts.recencyWindow);

  let maskedParts = 0;
  const newMessages = messages.map((msg, index) => {
    if (index >= boundary) {
      return msg;
    }

    if (!hasToolResultPart(msg)) {
      return msg;
    }

    const masked = maskToolResultsInMessage(msg);
    for (let j = 0; j < msg.parts.length; j++) {
      const origPart = msg.parts[j];
      const newPart = masked.parts[j];
      if (
        origPart.type === 'tool_result' &&
        newPart.type === 'tool_result' &&
        origPart.result.agentContent !== newPart.result.agentContent
      ) {
        maskedParts++;
      }
    }
    return masked;
  });

  const totalTokensAfter = estimateConversationTokens(newMessages);

  return {
    messages: newMessages,
    masked: true,
    stats: {
      totalTokensBefore,
      totalTokensAfter,
      maskedParts,
      savedTokens: totalTokensBefore - totalTokensAfter,
    },
  };
}
