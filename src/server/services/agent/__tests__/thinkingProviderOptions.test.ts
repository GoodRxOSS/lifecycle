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

import { resolveAgentInstructions, resolveThinkingProviderOptions } from '../thinkingProviderOptions';

describe('resolveThinkingProviderOptions', () => {
  it('asks Gemini 3+ for thought summaries via thinkingLevel', () => {
    for (const provider of ['gemini', 'google']) {
      expect(resolveThinkingProviderOptions(provider, 'gemini-3.5-flash')).toEqual({
        google: {
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
        },
      });
    }
  });

  it('asks legacy Gemini 2.x for thought summaries via thinkingBudget', () => {
    expect(resolveThinkingProviderOptions('gemini', 'gemini-2.5-flash')).toEqual({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
      },
    });
  });

  it('uses adaptive thinking for Claude 4.6+ and the Claude 5 family', () => {
    for (const modelId of ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-x']) {
      expect(resolveThinkingProviderOptions('anthropic', modelId)).toEqual({
        anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
      });
    }
  });

  it('keeps the bounded budget for Claude models without adaptive thinking', () => {
    for (const modelId of ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022']) {
      expect(resolveThinkingProviderOptions('anthropic', modelId)).toEqual({
        anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
      });
    }
  });

  it('returns no options for providers without tool-callable reasoning', () => {
    expect(resolveThinkingProviderOptions('openai', 'gpt-x')).toBeUndefined();
    expect(resolveThinkingProviderOptions('unknown', 'x')).toBeUndefined();
  });
});

describe('resolveAgentInstructions', () => {
  it('adds a system-prompt cache breakpoint for anthropic runs', () => {
    expect(resolveAgentInstructions('anthropic', 'System prompt')).toEqual({
      role: 'system',
      content: 'System prompt',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('passes the plain prompt through for other providers and empty prompts', () => {
    expect(resolveAgentInstructions('openai', 'System prompt')).toBe('System prompt');
    expect(resolveAgentInstructions('anthropic', undefined)).toBeUndefined();
  });
});
