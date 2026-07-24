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

import type { ModelMessage, SystemModelMessage } from 'ai';

// Gemini 2.x takes a numeric budget (-1 = dynamic); 3+ takes a level ('medium' reliably surfaces thinking).
const GEMINI_DYNAMIC_THINKING_BUDGET = -1;
const GEMINI_3_THINKING_LEVEL = 'medium';
const ANTHROPIC_THINKING_BUDGET_TOKENS = 4_096;

function isLegacyGemini2(modelId: string): boolean {
  return /gemini-2\./i.test(modelId);
}

function isOpenAiReasoningModel(modelId: string): boolean {
  return /^(o[0-9]|gpt-5)/i.test(modelId);
}

// Claude ≤4.5 (and all Haiku) only take the fixed-budget config; 4.6+ and the Claude 5
// family take adaptive — Fable 5 rejects `type: 'enabled'` with a 400.
function isLegacyAnthropic(modelId: string): boolean {
  return /claude-3|haiku|(?:opus|sonnet)-4[.-](?:0|1|5|2025)/i.test(modelId);
}

// Provider-keyed reasoning options; undefined for providers that can't stream reasoning in the tool loop.
export function resolveThinkingProviderOptions(provider: string, modelId: string) {
  switch (provider) {
    case 'gemini':
    case 'google':
      return {
        google: {
          thinkingConfig: isLegacyGemini2(modelId)
            ? {
                includeThoughts: true,
                thinkingBudget: GEMINI_DYNAMIC_THINKING_BUDGET,
              }
            : {
                includeThoughts: true,
                thinkingLevel: GEMINI_3_THINKING_LEVEL,
              },
        },
      };
    case 'anthropic':
      return {
        anthropic: {
          thinking: isLegacyAnthropic(modelId)
            ? { type: 'enabled', budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS }
            : { type: 'adaptive', display: 'summarized' },
        },
      };
    case 'openai':
      // Summaries make reasoning streamable; the provider auto-includes encrypted reasoning
      // content for reasoning models so replayed tool turns keep their reasoning items.
      return isOpenAiReasoningModel(modelId) ? { openai: { reasoningSummary: 'auto' } } : undefined;
    default:
      return undefined;
  }
}

// Anthropic re-bills the full transcript every loop step; a system-prompt cache breakpoint turns within-run steps into cache reads.
export function resolveAgentInstructions(
  provider: string,
  systemPrompt: string | undefined
): string | SystemModelMessage | undefined {
  if (!systemPrompt || provider !== 'anthropic') {
    return systemPrompt;
  }

  return {
    role: 'system',
    content: systemPrompt,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };
}

type ProviderOptionsRecord = Record<string, Record<string, unknown>>;

function withAnthropicCacheControl(message: ModelMessage, enabled: boolean): ModelMessage {
  const providerOptions = (message.providerOptions ?? {}) as ProviderOptionsRecord;
  const anthropic = providerOptions.anthropic ?? {};
  const hasControl = 'cacheControl' in anthropic;
  if (enabled === hasControl) {
    return message;
  }

  if (enabled) {
    return {
      ...message,
      providerOptions: { ...providerOptions, anthropic: { ...anthropic, cacheControl: { type: 'ephemeral' } } },
    } as ModelMessage;
  }

  const { cacheControl: _cacheControl, ...rest } = anthropic;
  return { ...message, providerOptions: { ...providerOptions, anthropic: rest } } as ModelMessage;
}

/**
 * Rolling conversation cache breakpoint: the whole message prefix (tool calls and results included)
 * is re-read at cache price on every loop step instead of re-billed as fresh input. The breakpoint
 * sits on the last message and moves forward each step; earlier stamps are stripped because message
 * overrides carry forward across steps and Anthropic allows at most 4 cache_control blocks.
 */
export function applyAnthropicMessageCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  return messages.map((message, index) => withAnthropicCacheControl(message, index === messages.length - 1));
}
