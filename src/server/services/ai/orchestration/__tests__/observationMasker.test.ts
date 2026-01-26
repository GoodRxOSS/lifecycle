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

jest.mock('../../prompts/tokenCounter', () => ({
  countTokens: (text: string) => text.length,
}));

import { ConversationMessage } from '../../types/message';
import { ToolResult } from '../../types/tool';
import { maskObservations } from '../observationMasker';

function buildToolResultMessage(toolName: string, agentContent: string, success: boolean = true): ConversationMessage {
  const result: ToolResult = { success, agentContent };
  return {
    role: 'user',
    parts: [
      {
        type: 'tool_result',
        toolCallId: `call_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        result,
      },
    ],
  };
}

function buildToolCallMessage(toolName: string, args: Record<string, unknown>): ConversationMessage {
  return {
    role: 'assistant',
    parts: [
      {
        type: 'tool_call',
        toolCallId: `call_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        arguments: args,
      },
    ],
  };
}

function buildTextMessage(role: 'user' | 'assistant', content: string): ConversationMessage {
  return { role, parts: [{ type: 'text', content }] };
}

describe('maskObservations', () => {
  it('should not mask when under token threshold', () => {
    const messages: ConversationMessage[] = [
      buildTextMessage('user', 'hello'),
      buildToolCallMessage('get_k8s_resources', { kind: 'pods' }),
      buildToolResultMessage('get_k8s_resources', 'pod-1 Running'),
    ];

    const result = maskObservations(messages, { tokenThreshold: 999999 });

    expect(result.masked).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('should mask old tool results with placeholder', () => {
    const messages: ConversationMessage[] = [
      buildTextMessage('user', 'check pods'),
      buildToolCallMessage('get_k8s_resources', { kind: 'pods' }),
      buildToolResultMessage('get_k8s_resources', 'pod-1 Running\npod-2 Running\npod-3 CrashLoopBackOff'),
      buildTextMessage('assistant', 'I see pod-3 is crashing'),
      buildTextMessage('user', 'check logs'),
      buildToolCallMessage('get_pod_logs', { pod: 'pod-3' }),
      buildToolResultMessage('get_pod_logs', 'Error: OOMKilled'),
    ];

    const result = maskObservations(messages, { tokenThreshold: 1, recencyWindow: 1 });

    expect(result.masked).toBe(true);
    const oldToolResult = result.messages[2];
    expect(oldToolResult.parts[0].type).toBe('tool_result');
    const oldPart = oldToolResult.parts[0] as any;
    expect(oldPart.result.agentContent).toBe('[Tool output omitted for brevity]');

    const recentToolResult = result.messages[6];
    expect(recentToolResult.parts[0].type).toBe('tool_result');
    const recentPart = recentToolResult.parts[0] as any;
    expect(recentPart.result.agentContent).toBe('Error: OOMKilled');
  });

  it('should protect recent turn-pairs from masking', () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(buildToolCallMessage(`tool_${i}`, { i }));
      messages.push(buildToolResultMessage(`tool_${i}`, `result-content-for-tool-${i}`));
    }

    const result = maskObservations(messages, { tokenThreshold: 1, recencyWindow: 2 });

    expect(result.masked).toBe(true);

    const lastToolResultMsg = result.messages[23];
    const lastPart = lastToolResultMsg.parts[0] as any;
    expect(lastPart.result.agentContent).toBe('result-content-for-tool-11');

    const secondLastToolResultMsg = result.messages[21];
    const secondLastPart = secondLastToolResultMsg.parts[0] as any;
    expect(secondLastPart.result.agentContent).toBe('result-content-for-tool-10');

    const oldToolResultMsg = result.messages[1];
    const oldPart = oldToolResultMsg.parts[0] as any;
    expect(oldPart.result.agentContent).toBe('[Tool output omitted for brevity]');
  });

  it('should never mask error results', () => {
    const messages: ConversationMessage[] = [
      buildToolCallMessage('query_database', { sql: 'SELECT 1' }),
      buildToolResultMessage('query_database', 'Connection refused: ECONNREFUSED', false),
      buildToolCallMessage('get_k8s_resources', { kind: 'pods' }),
      buildToolResultMessage('get_k8s_resources', 'pod-1 Running'),
      buildToolCallMessage('get_pod_logs', { pod: 'pod-1' }),
      buildToolResultMessage('get_pod_logs', 'latest log line'),
    ];

    const result = maskObservations(messages, { tokenThreshold: 1, recencyWindow: 1 });

    expect(result.masked).toBe(true);

    const errorResult = result.messages[1];
    const errorPart = errorResult.parts[0] as any;
    expect(errorPart.result.agentContent).toBe('Connection refused: ECONNREFUSED');
    expect(errorPart.result.success).toBe(false);

    const oldSuccessResult = result.messages[3];
    const oldSuccessPart = oldSuccessResult.parts[0] as any;
    expect(oldSuccessPart.result.agentContent).toBe('[Tool output omitted for brevity]');
  });

  it('should not mutate the original messages array', () => {
    const messages: ConversationMessage[] = [
      buildToolCallMessage('get_k8s_resources', { kind: 'pods' }),
      buildToolResultMessage('get_k8s_resources', 'pod-1 Running'),
      buildToolCallMessage('get_pod_logs', { pod: 'pod-1' }),
      buildToolResultMessage('get_pod_logs', 'latest log line'),
    ];

    const snapshot = JSON.parse(JSON.stringify(messages));

    maskObservations(messages, { tokenThreshold: 1, recencyWindow: 1 });

    expect(JSON.stringify(messages)).toBe(JSON.stringify(snapshot));
  });

  it('should return accurate stats', () => {
    const messages: ConversationMessage[] = [
      buildToolCallMessage('get_k8s_resources', { kind: 'pods' }),
      buildToolResultMessage('get_k8s_resources', 'a]long-result-that-will-be-masked-away'),
      buildToolCallMessage('get_pod_logs', { pod: 'pod-1' }),
      buildToolResultMessage('get_pod_logs', 'recent log'),
    ];

    const result = maskObservations(messages, { tokenThreshold: 1, recencyWindow: 1 });

    expect(result.masked).toBe(true);
    expect(result.stats.maskedParts).toBe(1);
    expect(result.stats.totalTokensBefore).toBeGreaterThan(0);
    expect(result.stats.totalTokensAfter).toBeGreaterThan(0);
    expect(result.stats.totalTokensAfter).toBeLessThan(result.stats.totalTokensBefore);
    expect(result.stats.savedTokens).toBe(result.stats.totalTokensBefore - result.stats.totalTokensAfter);
  });

  it('does not mask when total tokens are just below threshold', () => {
    const content = 'x'.repeat(99);
    const messages: ConversationMessage[] = [
      buildToolCallMessage('tool_a', { q: 'a' }),
      buildToolResultMessage('tool_a', content),
      buildToolCallMessage('tool_b', { q: 'b' }),
      buildToolResultMessage('tool_b', content),
    ];

    const totalChars = messages.reduce((sum, m) => {
      return (
        sum +
        m.parts.reduce((ps, p) => {
          if (p.type === 'text') return ps + p.content.length;
          if (p.type === 'tool_call') return ps + JSON.stringify(p.arguments).length + p.name.length;
          if (p.type === 'tool_result') return ps + (p.result.agentContent || JSON.stringify(p.result)).length;
          return ps;
        }, 0)
      );
    }, 0);

    const result = maskObservations(messages, { tokenThreshold: totalChars + 1 });
    expect(result.masked).toBe(false);
    expect(result.stats.maskedParts).toBe(0);
  });

  it('masks oldest tool results when over threshold, preserving recent N', () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(buildToolCallMessage(`tool_${i}`, { i }));
      messages.push(buildToolResultMessage(`tool_${i}`, `result-for-tool-${i}-with-padding`));
    }

    const result = maskObservations(messages, { tokenThreshold: 1, recencyWindow: 3 });

    expect(result.masked).toBe(true);

    for (let i = 0; i < 3; i++) {
      const msg = result.messages[i * 2 + 1];
      const part = msg.parts[0] as any;
      expect(part.result.agentContent).toBe('[Tool output omitted for brevity]');
    }

    for (let i = 3; i < 6; i++) {
      const msg = result.messages[i * 2 + 1];
      const part = msg.parts[0] as any;
      expect(part.result.agentContent).toBe(`result-for-tool-${i}-with-padding`);
    }
  });

  it('never masks error results regardless of age', () => {
    const messages: ConversationMessage[] = [
      buildToolCallMessage('failing_tool', { x: 1 }),
      buildToolResultMessage('failing_tool', 'CRITICAL: connection timeout at db.host:5432', false),
      buildToolCallMessage('tool_2', { x: 2 }),
      buildToolResultMessage('tool_2', 'success result 2'),
      buildToolCallMessage('tool_3', { x: 3 }),
      buildToolResultMessage('tool_3', 'success result 3'),
      buildToolCallMessage('tool_4', { x: 4 }),
      buildToolResultMessage('tool_4', 'success result 4'),
      buildToolCallMessage('tool_5', { x: 5 }),
      buildToolResultMessage('tool_5', 'success result 5'),
    ];

    const result = maskObservations(messages, { tokenThreshold: 1, recencyWindow: 2 });

    expect(result.masked).toBe(true);

    const errorPart = result.messages[1].parts[0] as any;
    expect(errorPart.result.agentContent).toBe('CRITICAL: connection timeout at db.host:5432');
    expect(errorPart.result.success).toBe(false);

    const oldSuccessPart = result.messages[3].parts[0] as any;
    expect(oldSuccessPart.result.agentContent).toBe('[Tool output omitted for brevity]');
  });

  it('masks at exact threshold boundary (uses strict less-than)', () => {
    const content = 'a'.repeat(50);
    const messages: ConversationMessage[] = [
      buildToolCallMessage('tool_old', { q: 'old' }),
      buildToolResultMessage('tool_old', content),
      buildToolCallMessage('tool_new', { q: 'new' }),
      buildToolResultMessage('tool_new', content),
    ];

    const totalChars = messages.reduce((sum, m) => {
      return (
        sum +
        m.parts.reduce((ps, p) => {
          if (p.type === 'text') return ps + p.content.length;
          if (p.type === 'tool_call') return ps + JSON.stringify(p.arguments).length + p.name.length;
          if (p.type === 'tool_result') return ps + (p.result.agentContent || JSON.stringify(p.result)).length;
          return ps;
        }, 0)
      );
    }, 0);

    const atThreshold = maskObservations(messages, { tokenThreshold: totalChars, recencyWindow: 1 });
    expect(atThreshold.masked).toBe(true);

    const belowThreshold = maskObservations(messages, { tokenThreshold: totalChars + 1, recencyWindow: 1 });
    expect(belowThreshold.masked).toBe(false);
  });

  it('should preserve assistant reasoning text while masking tool results', () => {
    const messages: ConversationMessage[] = [
      buildTextMessage('user', 'What pods are running?'),
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'Let me check the pods for you.' },
          {
            type: 'tool_call',
            toolCallId: 'call_1',
            name: 'get_k8s_resources',
            arguments: { kind: 'pods' },
          },
        ],
      },
      buildToolResultMessage('get_k8s_resources', 'pod-1 Running\npod-2 CrashLoop'),
      buildTextMessage('assistant', 'I found 2 pods. Let me check the logs.'),
      buildToolCallMessage('get_pod_logs', { pod: 'pod-2' }),
      buildToolResultMessage('get_pod_logs', 'OOMKilled at 12:00'),
      buildTextMessage('assistant', 'Pod-2 is OOMKilled.'),
      buildTextMessage('user', 'fix it'),
    ];

    const result = maskObservations(messages, { tokenThreshold: 1, recencyWindow: 1 });

    expect(result.masked).toBe(true);

    const assistantWithReasoning = result.messages[1];
    const textPart = assistantWithReasoning.parts[0] as any;
    expect(textPart.type).toBe('text');
    expect(textPart.content).toBe('Let me check the pods for you.');

    const oldToolResult = result.messages[2];
    const toolResultPart = oldToolResult.parts[0] as any;
    expect(toolResultPart.result.agentContent).toBe('[Tool output omitted for brevity]');

    const preservedReasoning = result.messages[3];
    expect(preservedReasoning.parts[0].type).toBe('text');
    expect((preservedReasoning.parts[0] as any).content).toBe('I found 2 pods. Let me check the logs.');
  });
});
