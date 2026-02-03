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

jest.mock('@google/genai', () => ({ GoogleGenAI: jest.fn().mockImplementation(() => ({})) }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) }));

import { GeminiProvider } from '../gemini';
import { ConversationMessage } from '../../types/message';

describe('GeminiProvider.formatHistory', () => {
  let provider: GeminiProvider;

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
    provider = new GeminiProvider('test-model', 'test-key');
  });

  it('formats text messages with assistant mapped to model', () => {
    const result = provider.formatHistory([TEXT_USER, TEXT_ASSISTANT]);
    expect(result).toEqual([
      { role: 'user', parts: [{ text: 'What is wrong?' }] },
      { role: 'model', parts: [{ text: 'Let me check.' }] },
    ]);
  });

  it('skips system messages', () => {
    const result = provider.formatHistory([SYSTEM, TEXT_USER]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'What is wrong?' }] });
  });

  it('maps tool_call to functionCall', () => {
    const result = provider.formatHistory([TOOL_CALL]);
    expect(result).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'getK8sResources', args: { namespace: 'default' } } }] },
    ]);
  });

  it('maps tool_result to functionResponse with JSON.parse', () => {
    const result = provider.formatHistory([TOOL_RESULT]);
    expect(result).toEqual([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'getK8sResources', response: { pods: [] } } }],
      },
    ]);
  });

  it('wraps non-JSON agentContent in content key', () => {
    const msg: ConversationMessage = {
      role: 'user',
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          name: 'getK8sResources',
          result: { success: true, agentContent: 'plain text' },
        },
      ],
    };
    const result = provider.formatHistory([msg]);
    expect(result).toEqual([
      { role: 'user', parts: [{ functionResponse: { name: 'getK8sResources', response: { content: 'plain text' } } }] },
    ]);
  });

  it('maps error tool_result with error message', () => {
    const msg: ConversationMessage = {
      role: 'user',
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          name: 'getK8sResources',
          result: {
            success: false,
            error: { message: 'not found', code: 'NOT_FOUND', recoverable: false },
          },
        },
      ],
    };
    const result = provider.formatHistory([msg]);
    expect(result).toEqual([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'getK8sResources', response: { error: 'not found', success: false } } }],
      },
    ]);
  });

  it('formats full conversation skipping system', () => {
    const result = provider.formatHistory([SYSTEM, TEXT_USER, TOOL_CALL, TOOL_RESULT, TEXT_ASSISTANT]);
    expect(result).toHaveLength(4);
  });
});
