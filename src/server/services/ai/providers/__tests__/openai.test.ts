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

jest.mock('openai', () => jest.fn().mockImplementation(() => ({})));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) }));

import { OpenAIProvider } from '../openai';
import { ConversationMessage } from '../../types/message';

describe('OpenAIProvider.formatHistory', () => {
  let provider: OpenAIProvider;

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
    provider = new OpenAIProvider('test-model', 'test-key');
  });

  it('formats text messages', () => {
    const result = provider.formatHistory([TEXT_USER, TEXT_ASSISTANT]);
    expect(result).toEqual([
      { role: 'user', content: 'What is wrong?' },
      { role: 'assistant', content: 'Let me check.' },
    ]);
  });

  it('includes system messages', () => {
    const result = provider.formatHistory([SYSTEM, TEXT_USER]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'system', content: 'You are a helper.' });
  });

  it('formats tool_call with JSON.stringify arguments', () => {
    const result = provider.formatHistory([TOOL_CALL]);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'getK8sResources', arguments: '{"namespace":"default"}' },
          },
        ],
      },
    ]);
  });

  it('emits separate tool messages per tool_result part', () => {
    const msg: ConversationMessage = {
      role: 'user',
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          name: 'getK8sResources',
          result: { success: true, agentContent: '{"pods": []}' },
        },
        {
          type: 'tool_result',
          toolCallId: 'call-2',
          name: 'queryDatabase',
          result: { success: true, agentContent: '{"rows": []}' },
        },
      ],
    };
    const result = provider.formatHistory([msg]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"pods": []}' });
    expect(result[1]).toEqual({ role: 'tool', tool_call_id: 'call-2', content: '{"rows": []}' });
  });

  it('formats full conversation including system', () => {
    const result = provider.formatHistory([SYSTEM, TEXT_USER, TOOL_CALL, TOOL_RESULT, TEXT_ASSISTANT]);
    expect(result).toHaveLength(5);
  });
});
