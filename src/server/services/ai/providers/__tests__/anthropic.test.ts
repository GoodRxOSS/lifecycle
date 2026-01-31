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

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }))
);
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) }));

import { AnthropicProvider } from '../anthropic';
import { ConversationMessage } from '../../types/message';

describe('AnthropicProvider.formatHistory', () => {
  let provider: AnthropicProvider;

  const TEXT_USER: ConversationMessage = { role: 'user', parts: [{ type: 'text', content: 'What is wrong?' }] };
  const TEXT_ASSISTANT: ConversationMessage = {
    role: 'assistant',
    parts: [{ type: 'text', content: 'Let me check.' }],
  };
  const SYSTEM: ConversationMessage = { role: 'system', parts: [{ type: 'text', content: 'You are a helper.' }] };
  const TOOL_CALL: ConversationMessage = {
    role: 'assistant',
    parts: [{ type: 'tool_call', toolCallId: 'call-1', name: 'getK8sResources', arguments: { namespace: 'default' } }],
  };
  const TOOL_RESULT: ConversationMessage = {
    role: 'user',
    parts: [
      {
        type: 'tool_result',
        toolCallId: 'call-1',
        name: 'getK8sResources',
        result: { success: true, agentContent: '{"pods": []}' },
      },
    ],
  };

  beforeEach(() => {
    provider = new AnthropicProvider('test-model', 'test-key');
  });

  it('formats text messages', () => {
    const result = provider.formatHistory([TEXT_USER, TEXT_ASSISTANT]);
    expect(result).toEqual([
      { role: 'user', content: 'What is wrong?' },
      { role: 'assistant', content: 'Let me check.' },
    ]);
  });

  it('skips system messages', () => {
    const result = provider.formatHistory([SYSTEM, TEXT_USER]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'What is wrong?' });
  });

  it('maps tool_call to tool_use', () => {
    const result = provider.formatHistory([TOOL_CALL]);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'getK8sResources', input: { namespace: 'default' } }],
      },
    ]);
  });

  it('maps tool_result with tool_use_id', () => {
    const result = provider.formatHistory([TOOL_RESULT]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"pods": []}' }],
      },
    ]);
  });

  it('formats full conversation skipping system', () => {
    const result = provider.formatHistory([SYSTEM, TEXT_USER, TOOL_CALL, TOOL_RESULT, TEXT_ASSISTANT]);
    expect(result).toHaveLength(4);
  });

  it('joins multi-part text with space', () => {
    const msg: ConversationMessage = {
      role: 'user',
      parts: [
        { type: 'text', content: 'hello' },
        { type: 'text', content: 'world' },
      ],
    };
    const result = provider.formatHistory([msg]);
    expect(result).toEqual([{ role: 'user', content: 'hello world' }]);
  });
});

describe('AnthropicProvider.streamCompletion cache_control', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'response' }] });
    provider = new AnthropicProvider('test-model', 'test-key');
  });

  it('sends system prompt as content block array with cache_control ephemeral', async () => {
    const messages: ConversationMessage[] = [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }];
    const iter = provider.streamCompletion(messages, { systemPrompt: 'You are helpful.' });
    await iter.next();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
      })
    );
  });

  it('sends system as undefined when no systemPrompt provided', async () => {
    const messages: ConversationMessage[] = [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }];
    const iter = provider.streamCompletion(messages, {});
    await iter.next();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: undefined,
      })
    );
  });
});
