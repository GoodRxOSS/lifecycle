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

import { pruneStaleToolOutputsForModelInput, resolveModelContextWindowTokens } from './contextPruning';
import type { AgentUIMessage } from './types';

function assistantWithTool(id: string, output: unknown, state = 'output-available'): AgentUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'mcp__lifecycle__get_pod_logs',
        toolCallId: `${id}-call`,
        state,
        input: { pod_name: 'web-1' },
        output,
      } as never,
      { type: 'text', text: `analysis ${id}` } as never,
    ],
  } as AgentUIMessage;
}

function user(id: string): AgentUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: `question ${id}` }] } as AgentUIMessage;
}

const BIG_OUTPUT = 'x'.repeat(10_000);

describe('resolveModelContextWindowTokens', () => {
  it('maps known model families and falls back conservatively', () => {
    expect(resolveModelContextWindowTokens('gemini-2.5-pro')).toBe(1_000_000);
    expect(resolveModelContextWindowTokens('claude-sonnet-4-5')).toBe(200_000);
    expect(resolveModelContextWindowTokens('gpt-5.2')).toBe(400_000);
    expect(resolveModelContextWindowTokens('o4-mini')).toBe(200_000);
    expect(resolveModelContextWindowTokens('some-custom-model')).toBe(200_000);
    expect(resolveModelContextWindowTokens(null)).toBe(200_000);
  });
});

describe('pruneStaleToolOutputsForModelInput', () => {
  it('leaves short conversations untouched', () => {
    const messages = [user('u1'), assistantWithTool('a1', BIG_OUTPUT)];
    expect(pruneStaleToolOutputsForModelInput(messages, { contextWindowTokens: 200_000 })).toBe(messages);
  });

  it('elides old successful outputs, keeps errors, and keeps the recent turns whole', () => {
    const messages = [
      user('u1'),
      assistantWithTool('a1', BIG_OUTPUT),
      user('u2'),
      assistantWithTool('a2', BIG_OUTPUT, 'output-error'),
      user('u3'),
      assistantWithTool('a3', BIG_OUTPUT),
      user('u4'),
      assistantWithTool('a4', BIG_OUTPUT),
      user('u5'),
      assistantWithTool('a5', BIG_OUTPUT),
    ];
    // Tiny window forces the trigger; keep-last-3 assistant turns protects a3..a5.
    const pruned = pruneStaleToolOutputsForModelInput(messages, { contextWindowTokens: 10_000 });

    const outputOf = (id: string) => {
      const message = pruned.find((entry) => entry.id === id)!;
      const part = message.parts.find((entry) => (entry as { type?: string }).type === 'dynamic-tool') as {
        output?: unknown;
        input?: unknown;
      };
      return part;
    };

    expect(String(outputOf('a1').output)).toContain('elided');
    expect(String(outputOf('a1').output)).toContain('get_pod_logs');
    // The call input survives so the model can re-issue the call.
    expect(outputOf('a1').input).toEqual({ pod_name: 'web-1' });
    // Errors carry decisions — never elided.
    expect(outputOf('a2').output).toBe(BIG_OUTPUT);
    // Recent turns stay whole.
    expect(outputOf('a3').output).toBe(BIG_OUTPUT);
    expect(outputOf('a4').output).toBe(BIG_OUTPUT);
    expect(outputOf('a5').output).toBe(BIG_OUTPUT);
    // Non-tool parts and originals untouched.
    expect((messages[1].parts[0] as { output?: unknown }).output).toBe(BIG_OUTPUT);
  });
});
