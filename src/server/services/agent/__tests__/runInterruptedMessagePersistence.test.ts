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

const mockRebuild = jest.fn();
const mockUpsert = jest.fn();
const mockThreadFindById = jest.fn();

jest.mock('../LifecycleAiSdkHarness', () => ({
  __esModule: true,
  rebuildAssistantMessageFromEvents: (...args: unknown[]) => mockRebuild(...args),
}));

jest.mock('../MessageStore', () => ({
  __esModule: true,
  default: {
    upsertCanonicalUiMessagesForThread: (...args: unknown[]) => mockUpsert(...args),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: () => ({ findById: mockThreadFindById }),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

import { persistInterruptedRunAssistantMessage, settleInterruptedToolParts } from '../runInterruptedMessagePersistence';
import type { AgentUIMessage } from '../types';

describe('settleInterruptedToolParts', () => {
  const buildMessage = (parts: Array<Record<string, unknown>>): AgentUIMessage =>
    ({ id: 'assistant-1', role: 'assistant', parts } as unknown as AgentUIMessage);

  it('settles an approved-but-unsettled tool call with a may-have-executed warning (PS-7)', () => {
    const message = buildMessage([
      {
        type: 'dynamic-tool',
        toolName: 'mcp__lifecycle__update_file',
        toolCallId: 'call-1',
        state: 'approval-responded',
        input: { file_path: 'lifecycle.yaml' },
        approval: { id: 'approval-1', approved: true },
      },
    ]);

    const settled = settleInterruptedToolParts(message);
    const part = settled.parts[0] as unknown as Record<string, unknown>;

    expect(part.state).toBe('output-error');
    expect(part.errorText).toContain('may have already executed');
  });

  it('settles an unanswered approval as did-not-execute', () => {
    const message = buildMessage([
      {
        type: 'tool-mcp__workspace_core__write_file',
        toolCallId: 'call-1',
        state: 'approval-requested',
        input: {},
        approval: { id: 'approval-1' },
      },
    ]);

    const part = settleInterruptedToolParts(message).parts[0] as unknown as Record<string, unknown>;
    expect(part.state).toBe('output-error');
    expect(part.errorText).toContain('did not execute');
  });

  it('settles in-flight tool calls and leaves settled parts and text untouched', () => {
    const message = buildMessage([
      { type: 'text', text: 'partial answer' },
      { type: 'dynamic-tool', toolName: 'exec', toolCallId: 'call-1', state: 'input-available', input: {} },
      {
        type: 'dynamic-tool',
        toolName: 'exec',
        toolCallId: 'call-0',
        state: 'output-available',
        input: {},
        output: 'done',
      },
    ]);

    const settled = settleInterruptedToolParts(message);
    expect(settled.parts[0]).toEqual({ type: 'text', text: 'partial answer' });
    expect((settled.parts[1] as unknown as Record<string, unknown>).state).toBe('output-error');
    expect((settled.parts[2] as unknown as Record<string, unknown>).state).toBe('output-available');
  });
});

describe('persistInterruptedRunAssistantMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadFindById.mockResolvedValue({ id: 7 });
    mockUpsert.mockResolvedValue(undefined);
  });

  it('persists the rebuilt partial message against the run', async () => {
    mockRebuild.mockResolvedValue({
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial' }],
    });

    await persistInterruptedRunAssistantMessage({ id: 31, uuid: 'run-1', threadId: 7 } as never);

    expect(mockRebuild).toHaveBeenCalledWith('run-1');
    expect(mockUpsert).toHaveBeenCalledWith({ id: 7 }, [expect.objectContaining({ id: 'assistant-1' })], { runId: 31 });
  });

  it('no-ops when the run never streamed a message', async () => {
    mockRebuild.mockResolvedValue(null);

    await persistInterruptedRunAssistantMessage({ id: 31, uuid: 'run-1', threadId: 7 } as never);

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('never throws: persistence failures degrade to a warning', async () => {
    mockRebuild.mockRejectedValue(new Error('replay failed'));

    await expect(
      persistInterruptedRunAssistantMessage({ id: 31, uuid: 'run-1', threadId: 7 } as never)
    ).resolves.toBeUndefined();
  });
});
