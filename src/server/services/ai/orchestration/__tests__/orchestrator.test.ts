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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockExecute = jest.fn();
const mockCreateProviderPolicy = jest.fn(() => ({ execute: mockExecute }));

jest.mock('../../resilience', () => ({
  createProviderPolicy: (...args: unknown[]) => mockCreateProviderPolicy(...args),
}));

jest.mock('../../errors', () => ({
  RetryBudget: jest.requireActual('../../errors/retryBudget').RetryBudget,
  ErrorCategory: jest.requireActual('../../errors/classification').ErrorCategory,
  createClassifiedError: jest.requireActual('../../errors/providerErrors').createClassifiedError,
}));

import { ToolOrchestrator } from '../orchestrator';
import { LLMProvider, StreamChunk, CompletionOptions } from '../../types/provider';
import { ConversationMessage } from '../../types/message';
import { Tool, ToolSafetyLevel } from '../../types/tool';
import { StreamCallbacks } from '../../types/stream';
import { ToolRegistry } from '../../tools/registry';
import { ToolSafetyManager } from '../safety';
import { RetryBudget } from '../../errors/retryBudget';

function createMockCallbacks(): StreamCallbacks {
  return {
    onTextChunk: jest.fn(),
    onThinking: jest.fn(),
    onToolCall: jest.fn(),
    onToolResult: jest.fn(),
    onError: jest.fn(),
    onActivity: jest.fn(),
  };
}

function createMockProvider(chunkSets: StreamChunk[][]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'test-provider',
    streamCompletion(_messages: ConversationMessage[], _options: CompletionOptions, _signal?: AbortSignal) {
      const chunks = chunkSets[callIndex] || [];
      callIndex++;
      let i = 0;
      return {
        next() {
          if (i < chunks.length) {
            const chunk = chunks[i];
            i++;
            if ((chunk as any)._throw) {
              return Promise.reject(new Error((chunk as any)._throw));
            }
            return Promise.resolve({ value: chunk, done: false });
          }
          return Promise.resolve({ value: undefined as any, done: true });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      } as any;
    },
    supportsTools: () => true,
    getModelInfo: () => ({ model: 'test', maxTokens: 4096 }),
    formatToolDefinition: (tool: Tool) => tool,
    parseToolCall: () => [],
    estimateTokens: () => 0,
    formatHistory: (messages: ConversationMessage[]) => messages.map((m) => ({ role: m.role, content: '' })),
  };
}

function createErrorProvider(error: Error): LLMProvider {
  return {
    name: 'test-provider',
    streamCompletion() {
      return {
        next() {
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      } as any;
    },
    supportsTools: () => true,
    getModelInfo: () => ({ model: 'test', maxTokens: 4096 }),
    formatToolDefinition: (tool: Tool) => tool,
    parseToolCall: () => [],
    estimateTokens: () => 0,
    formatHistory: (messages: ConversationMessage[]) => messages.map((m) => ({ role: m.role, content: '' })),
  };
}

function createPartialErrorProvider(textChunks: StreamChunk[], error: Error): LLMProvider {
  return {
    name: 'test-provider',
    streamCompletion() {
      let i = 0;
      return {
        next() {
          if (i < textChunks.length) {
            const chunk = textChunks[i];
            i++;
            return Promise.resolve({ value: chunk, done: false });
          }
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      } as any;
    },
    supportsTools: () => true,
    getModelInfo: () => ({ model: 'test', maxTokens: 4096 }),
    formatToolDefinition: (tool: Tool) => tool,
    parseToolCall: () => [],
    estimateTokens: () => 0,
    formatHistory: (messages: ConversationMessage[]) => messages.map((m) => ({ role: m.role, content: '' })),
  };
}

function createMockToolRegistry(): ToolRegistry {
  const registry = {
    get: jest.fn().mockReturnValue({
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
      safetyLevel: ToolSafetyLevel.SAFE,
      category: 'k8s' as const,
      execute: jest.fn().mockResolvedValue({ success: true, agentContent: 'result' }),
    }),
    getAll: jest.fn().mockReturnValue([]),
    register: jest.fn(),
    registerMultiple: jest.fn(),
    unregister: jest.fn(),
    getByCategory: jest.fn().mockReturnValue([]),
    getFiltered: jest.fn().mockReturnValue([]),
    execute: jest.fn(),
  } as unknown as ToolRegistry;
  return registry;
}

function createMockSafetyManager(): ToolSafetyManager {
  return {
    safeExecute: jest.fn().mockResolvedValue({ success: true, agentContent: 'result' }),
  } as unknown as ToolSafetyManager;
}

beforeEach(() => {
  mockExecute.mockReset();
  mockCreateProviderPolicy.mockReset();
  mockCreateProviderPolicy.mockReturnValue({ execute: mockExecute });
  mockExecute.mockImplementation(async (fn: Function) => fn());
});

describe('ToolOrchestrator', () => {
  let orchestrator: ToolOrchestrator;
  let registry: ToolRegistry;
  let safetyManager: ToolSafetyManager;

  beforeEach(() => {
    registry = createMockToolRegistry();
    safetyManager = createMockSafetyManager();
    orchestrator = new ToolOrchestrator(registry, safetyManager);
  });

  it('returns successful response when provider streams text without errors', async () => {
    const provider = createMockProvider([
      [
        { type: 'text', content: 'Hello ' },
        { type: 'text', content: 'world' },
      ],
    ]);
    const callbacks = createMockCallbacks();
    const controller = new AbortController();

    const result = await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

    expect(result.success).toBe(true);
    expect(result.response).toBe('Hello world');
    expect(callbacks.onTextChunk).toHaveBeenCalledWith('Hello ');
    expect(callbacks.onTextChunk).toHaveBeenCalledWith('world');
  });

  it('preserves partial results when stream error occurs after text accumulation', async () => {
    const partialChunks: StreamChunk[] = [
      { type: 'text', content: 'Partial ' },
      { type: 'text', content: 'response' },
    ];
    const provider = createPartialErrorProvider(partialChunks, new Error('stream died'));
    const callbacks = createMockCallbacks();
    const controller = new AbortController();

    const result = await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

    expect(result.success).toBe(true);
    expect(result.response).toContain('Partial response');
    expect(result.error).toContain('Stream interrupted');
  });

  it('returns failure when stream error occurs with no accumulated content', async () => {
    const provider = createErrorProvider(new Error('total failure'));
    const callbacks = createMockCallbacks();
    const controller = new AbortController();

    const result = await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

    expect(result.success).toBe(false);
    expect(result.error).toBe('total failure');
  });

  it('passes RetryBudget to createProviderPolicy', async () => {
    const provider = createMockProvider([[{ type: 'text', content: 'ok' }]]);
    const callbacks = createMockCallbacks();
    const controller = new AbortController();

    await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

    expect(mockCreateProviderPolicy).toHaveBeenCalledWith('test-provider', expect.any(RetryBudget));
  });

  it('wraps stream consumption in policy.execute', async () => {
    const provider = createMockProvider([[{ type: 'text', content: 'ok' }]]);
    const callbacks = createMockCallbacks();
    const controller = new AbortController();

    await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

    expect(mockExecute).toHaveBeenCalled();
    expect(typeof mockExecute.mock.calls[0][0]).toBe('function');
  });

  it('handles tool calls correctly after successful stream', async () => {
    const provider = createMockProvider([
      [
        {
          type: 'tool_call',
          toolCalls: [{ name: 'test_tool', arguments: { query: 'pods' } }],
        },
      ],
      [{ type: 'text', content: 'Done with tools' }],
    ]);
    const callbacks = createMockCallbacks();
    const controller = new AbortController();

    const result = await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

    expect(result.success).toBe(true);
    expect(result.response).toBe('Done with tools');
    expect(safetyManager.safeExecute).toHaveBeenCalled();
    expect(callbacks.onToolCall).toHaveBeenCalledWith('test_tool', { query: 'pods' }, expect.any(String));
  });

  it('respects abort signal', async () => {
    const provider = createMockProvider([[{ type: 'text', content: 'should not appear' }]]);
    const callbacks = createMockCallbacks();
    const controller = new AbortController();
    controller.abort();

    const result = await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error).toContain('cancelled');
  });

  describe('parallel tool execution', () => {
    it('executes multiple tool calls in parallel', async () => {
      const delayedSafeExecute = jest
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ success: true, agentContent: 'result' }), 100))
        );
      (safetyManager.safeExecute as jest.Mock) = delayedSafeExecute;
      safetyManager.safeExecute = delayedSafeExecute;

      const provider = createMockProvider([
        [
          {
            type: 'tool_call',
            toolCalls: [
              { name: 'test_tool', arguments: { q: '1' } },
              { name: 'test_tool', arguments: { q: '2' } },
              { name: 'test_tool', arguments: { q: '3' } },
            ],
          },
        ],
        [{ type: 'text', content: 'Done' }],
      ]);
      const callbacks = createMockCallbacks();
      const controller = new AbortController();

      const before = Date.now();
      const result = await orchestrator.executeToolLoop(
        provider,
        'system prompt',
        [],
        [],
        callbacks,
        controller.signal
      );
      const elapsed = Date.now() - before;

      expect(result.success).toBe(true);
      expect(delayedSafeExecute).toHaveBeenCalledTimes(3);
      expect(elapsed).toBeLessThan(200);
      expect(callbacks.onToolResult).toHaveBeenCalledTimes(3);
    });

    it('handles partial failure in parallel execution', async () => {
      let callCount = 0;
      const mixedSafeExecute = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.resolve({
            success: false,
            error: { message: 'tool 2 failed', code: 'FAIL', recoverable: true },
          });
        }
        return Promise.resolve({ success: true, agentContent: 'ok' });
      });
      safetyManager.safeExecute = mixedSafeExecute;

      const provider = createMockProvider([
        [
          {
            type: 'tool_call',
            toolCalls: [
              { name: 'test_tool', arguments: { q: '1' } },
              { name: 'test_tool', arguments: { q: '2' } },
              { name: 'test_tool', arguments: { q: '3' } },
            ],
          },
        ],
        [{ type: 'text', content: 'Done' }],
      ]);
      const callbacks = createMockCallbacks();
      const controller = new AbortController();

      const result = await orchestrator.executeToolLoop(
        provider,
        'system prompt',
        [],
        [],
        callbacks,
        controller.signal
      );

      expect(result.success).toBe(true);
      expect(callbacks.onToolResult).toHaveBeenCalledTimes(3);
      expect(callbacks.onToolCall).toHaveBeenCalledTimes(3);

      const secondResult = (callbacks.onToolResult as jest.Mock).mock.calls[1][0];
      expect(secondResult.success).toBe(false);
    });

    it('preserves abort behavior during parallel execution', async () => {
      const controller = new AbortController();
      const abortSafeExecute = jest.fn().mockImplementation(() => {
        controller.abort();
        return Promise.resolve({ success: true, agentContent: 'first done' });
      });
      safetyManager.safeExecute = abortSafeExecute;

      const provider = createMockProvider([
        [
          {
            type: 'tool_call',
            toolCalls: [
              { name: 'test_tool', arguments: { q: '1' } },
              { name: 'test_tool', arguments: { q: '2' } },
            ],
          },
        ],
        [{ type: 'text', content: 'Done' }],
      ]);
      const callbacks = createMockCallbacks();

      await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

      expect(callbacks.onToolResult).toHaveBeenCalled();
    });

    it('assigns llmThinkTime to first tool by index', async () => {
      let callIdx = 0;
      const orderedSafeExecute = jest.fn().mockImplementation(() => {
        callIdx++;
        const delay = callIdx === 1 ? 80 : 10;
        return new Promise((resolve) =>
          setTimeout(() => resolve({ success: true, agentContent: `result-${callIdx}` }), delay)
        );
      });
      safetyManager.safeExecute = orderedSafeExecute;

      const provider = createMockProvider([
        [
          {
            type: 'tool_call',
            toolCalls: [
              { name: 'test_tool', arguments: { q: 'slow' } },
              { name: 'test_tool', arguments: { q: 'fast' } },
            ],
          },
        ],
        [{ type: 'text', content: 'Done' }],
      ]);
      const callbacks = createMockCallbacks();
      const controller = new AbortController();

      await orchestrator.executeToolLoop(provider, 'system prompt', [], [], callbacks, controller.signal);

      const firstToolCall = (callbacks.onToolResult as jest.Mock).mock.calls.find(
        (call: any[]) => call[1] === 'test_tool' && call[2].q === 'slow'
      );
      const secondToolCall = (callbacks.onToolResult as jest.Mock).mock.calls.find(
        (call: any[]) => call[1] === 'test_tool' && call[2].q === 'fast'
      );

      expect(firstToolCall).toBeDefined();
      expect(secondToolCall).toBeDefined();
      expect(firstToolCall![4]).toBeGreaterThanOrEqual(firstToolCall![3]);
      expect(secondToolCall![4]).toEqual(secondToolCall![3]);
    });
  });
});
