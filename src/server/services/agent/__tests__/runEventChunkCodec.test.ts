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

import { toChunkEvents, chunkFromEvent } from '../runEventChunkCodec';
import type { AgentUiMessageChunk } from '../streamChunks';

describe('runEventChunkCodec approval round-trip', () => {
  it('persists isAutomatic and signature on approval requests and restores them on replay', () => {
    const chunk = {
      type: 'tool-approval-request',
      approvalId: 'approval-1',
      toolCallId: 'call-1',
      isAutomatic: true,
      signature: 'sig-1',
    } as unknown as AgentUiMessageChunk;

    const events = toChunkEvents(chunk);
    expect(events).toEqual([
      {
        eventType: 'approval.requested',
        payload: expect.objectContaining({
          approvalId: 'approval-1',
          toolCallId: 'call-1',
          isAutomatic: true,
          signature: 'sig-1',
        }),
      },
    ]);

    const replayed = chunkFromEvent({ eventType: 'approval.requested', payload: events[0].payload } as never);
    expect(replayed).toEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        isAutomatic: true,
        signature: 'sig-1',
      })
    );
  });

  it('persists in-stream auto-approval responses so replays do not show phantom pending approvals', () => {
    const chunk = {
      type: 'tool-approval-response',
      approvalId: 'approval-1',
      approved: true,
      isAutomatic: true,
    } as unknown as AgentUiMessageChunk;

    const events = toChunkEvents(chunk);
    expect(events).toEqual([
      {
        eventType: 'approval.responded',
        payload: expect.objectContaining({
          approvalId: 'approval-1',
          approved: true,
          isAutomatic: true,
        }),
      },
    ]);
  });

  it('replays approval.responded events (manual or automatic) as tool-approval-response chunks', () => {
    const replayed = chunkFromEvent({
      eventType: 'approval.responded',
      payload: { approvalId: 'approval-1', toolCallId: 'call-1', approved: false, reason: 'Not needed' },
    } as never);

    expect(replayed).toEqual(
      expect.objectContaining({
        type: 'tool-approval-response',
        approvalId: 'approval-1',
        approved: false,
        reason: 'Not needed',
      })
    );
  });

  it('drops malformed approval.responded events instead of emitting invalid chunks', () => {
    expect(chunkFromEvent({ eventType: 'approval.responded', payload: { approvalId: 'a' } } as never)).toBeNull();
    expect(chunkFromEvent({ eventType: 'approval.responded', payload: { approved: true } } as never)).toBeNull();
  });
});

// Mirrors chunk-from-event.parity.test.ts in lifecycle-ui — the two folds are declared byte-identical.
describe('runEventChunkCodec UI-parity fixtures', () => {
  it('parity: run.failed with token-budget details interpolates the budget', () => {
    expect(
      chunkFromEvent({
        eventType: 'run.failed',
        payload: {
          status: 'failed',
          error: {
            code: 'run_token_budget_exceeded',
            message: 'Run input token budget exceeded.',
            details: { maxRunInputTokens: 400000 },
          },
        },
      } as never)
    ).toEqual({
      type: 'error',
      errorText:
        'The agent used its 400,000-token input budget for this response. Send a follow-up to continue with a fresh budget.',
    });
  });

  it('parity: approval.requested keeps isAutomatic and signature', () => {
    expect(
      chunkFromEvent({
        eventType: 'approval.requested',
        payload: { approvalId: 'approval-1', toolCallId: 'tc-1', isAutomatic: true, signature: 'sig-1' },
      } as never)
    ).toEqual({
      type: 'tool-approval-request',
      approvalId: 'approval-1',
      toolCallId: 'tc-1',
      isAutomatic: true,
      signature: 'sig-1',
    });
  });

  it('parity: approval.responded folds as a tool-approval-response', () => {
    expect(
      chunkFromEvent({
        eventType: 'approval.responded',
        payload: { approvalId: 'approval-1', toolCallId: 'tc-1', approved: false, reason: 'Not needed' },
      } as never)
    ).toEqual({
      type: 'tool-approval-response',
      approvalId: 'approval-1',
      approved: false,
      reason: 'Not needed',
    });
  });

  it('parity: run.transitioned folds as a finish chunk with transition metadata', () => {
    expect(
      chunkFromEvent({
        eventType: 'run.transitioned',
        payload: {
          status: 'transitioned',
          transition: { label: 'Continuing in workspace', status: 'Setting up workspace' },
        },
      } as never)
    ).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: {
        transition: { label: 'Continuing in workspace', status: 'Setting up workspace' },
      },
    });
  });
});

describe('toChunkEvents canonical persistence mapping', () => {
  const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['message start', { type: 'start', messageId: 'message-1' }, 'message.created', { metadata: {} }],
    [
      'message metadata',
      { type: 'message-metadata', messageMetadata: { provider: 'openai' } },
      'message.metadata',
      { metadata: { provider: 'openai' } },
    ],
    [
      'text start',
      { type: 'text-start', id: 'text-1', providerMetadata: { provider: 'openai' } },
      'message.part.started',
      { partType: 'text', partId: 'text-1', providerMetadata: { provider: 'openai' } },
    ],
    [
      'text delta',
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      'message.delta',
      { partType: 'text', partId: 'text-1', delta: 'hello' },
    ],
    ['text end', { type: 'text-end', id: 'text-1' }, 'message.part.completed', { partType: 'text', partId: 'text-1' }],
    [
      'reasoning start',
      { type: 'reasoning-start', id: 'reasoning-1' },
      'message.part.started',
      { partType: 'reasoning', partId: 'reasoning-1' },
    ],
    [
      'reasoning delta',
      { type: 'reasoning-delta', id: 'reasoning-1', delta: 'thinking' },
      'message.delta',
      { partType: 'reasoning', partId: 'reasoning-1', delta: 'thinking' },
    ],
    [
      'reasoning end',
      { type: 'reasoning-end', id: 'reasoning-1' },
      'message.part.completed',
      { partType: 'reasoning', partId: 'reasoning-1' },
    ],
    [
      'tool input start',
      {
        type: 'tool-input-start',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        providerExecuted: true,
        providerMetadata: { id: 'provider-call' },
        dynamic: false,
        title: 'Read file',
      },
      'tool.call.input.started',
      { toolCallId: 'tool-1', toolName: 'read_file', providerExecuted: true, dynamic: false },
    ],
    [
      'tool input delta',
      { type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"path"' },
      'tool.call.input.delta',
      { toolCallId: 'tool-1', inputTextDelta: '{"path"' },
    ],
    [
      'tool input available',
      { type: 'tool-input-available', toolCallId: 'tool-1', toolName: 'read_file', input: { path: 'a' } },
      'tool.call.started',
      { toolCallId: 'tool-1', inputStatus: 'available', input: { path: 'a' }, errorText: null },
    ],
    [
      'tool input error',
      { type: 'tool-input-error', toolCallId: 'tool-2', toolName: 'write_file', errorText: 'invalid' },
      'tool.call.started',
      { toolCallId: 'tool-2', inputStatus: 'error', input: null, errorText: 'invalid' },
    ],
    [
      'tool output available',
      {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: { content: 'done' },
        preliminary: true,
      },
      'tool.call.completed',
      { toolCallId: 'tool-1', status: 'completed', output: { content: 'done' }, preliminary: true },
    ],
    [
      'tool output error',
      { type: 'tool-output-error', toolCallId: 'tool-2', errorText: 'failed', dynamic: true },
      'tool.call.completed',
      { toolCallId: 'tool-2', status: 'failed', output: null, errorText: 'failed', dynamic: true },
    ],
    [
      'tool output denied',
      { type: 'tool-output-denied', toolCallId: 'tool-3' },
      'tool.call.completed',
      { toolCallId: 'tool-3', status: 'denied', output: null, errorText: null },
    ],
    [
      'file change',
      { type: 'data-file-change', id: 'change-1', data: { path: 'README.md' }, transient: false },
      'tool.file_change',
      { id: 'change-1', data: { path: 'README.md' }, transient: false },
    ],
    [
      'URL source',
      {
        type: 'source-url',
        sourceId: 'source-1',
        url: 'https://example.test',
        title: 'Example',
      },
      'message.source',
      { sourceType: 'url', sourceId: 'source-1', url: 'https://example.test', title: 'Example' },
    ],
    [
      'document source',
      {
        type: 'source-document',
        sourceId: 'source-2',
        mediaType: 'text/plain',
        title: 'README',
        filename: 'README.md',
      },
      'message.source',
      { sourceType: 'document', sourceId: 'source-2', filename: 'README.md' },
    ],
    [
      'file',
      { type: 'file', url: 'https://example.test/file.txt', mediaType: 'text/plain' },
      'message.file',
      { url: 'https://example.test/file.txt', mediaType: 'text/plain' },
    ],
    ['step start', { type: 'start-step' }, 'run.step.started', {}],
    ['step finish', { type: 'finish-step' }, 'run.step.completed', {}],
    ['run finish', { type: 'finish', finishReason: 'stop' }, 'run.finished', { metadata: {} }],
    ['run abort', { type: 'abort', reason: 'cancelled' }, 'run.aborted', { reason: 'cancelled' }],
    ['run error', { type: 'error', errorText: 'failed' }, 'run.error', { errorText: 'failed' }],
  ];

  it.each(cases)('maps %s', (_label, chunk, eventType, payload) => {
    const result = toChunkEvents(chunk as unknown as AgentUiMessageChunk);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ eventType, payload: expect.objectContaining(payload) });
  });

  it('returns no canonical event for an unsupported UI chunk', () => {
    expect(toChunkEvents({ type: 'unsupported' } as unknown as AgentUiMessageChunk)).toEqual([]);
  });

  it('clones optional metadata instead of retaining mutable input references', () => {
    const providerMetadata = { nested: { id: 1 } };
    const result = toChunkEvents({
      type: 'text-start',
      id: 'text-1',
      providerMetadata,
    } as unknown as AgentUiMessageChunk);

    providerMetadata.nested.id = 2;
    expect(result[0].payload.providerMetadata).toEqual({ nested: { id: 1 } });
  });
});

describe('chunkFromEvent replay mapping', () => {
  function event(eventType: string, payload: unknown) {
    return chunkFromEvent({ eventType, payload } as never);
  }

  it.each([
    [
      'message created',
      'message.created',
      { messageId: 'message-1', metadata: { provider: 'openai' } },
      { type: 'start', messageId: 'message-1' },
    ],
    ['message metadata', 'message.metadata', {}, { type: 'message-metadata', messageMetadata: {} }],
    [
      'text start',
      'message.part.started',
      { partType: 'text', partId: 'text-1' },
      { type: 'text-start', id: 'text-1' },
    ],
    [
      'reasoning start',
      'message.part.started',
      { partType: 'reasoning', messageId: 'reasoning-1' },
      { type: 'reasoning-start', id: 'reasoning-1' },
    ],
    [
      'text delta',
      'message.delta',
      { partType: 'text', partId: 'text-1', delta: 'hello' },
      { type: 'text-delta', delta: 'hello' },
    ],
    [
      'reasoning delta with fallback',
      'message.delta',
      { partType: 'reasoning', partId: 'reasoning-1' },
      { type: 'reasoning-delta', delta: '' },
    ],
    ['text end', 'message.part.completed', { partType: 'text', partId: 'text-1' }, { type: 'text-end' }],
    [
      'reasoning end',
      'message.part.completed',
      { partType: 'reasoning', partId: 'reasoning-1' },
      { type: 'reasoning-end' },
    ],
    ['step start', 'run.step.started', {}, { type: 'start-step' }],
    ['step finish', 'run.step.completed', {}, { type: 'finish-step' }],
    [
      'run finish',
      'run.finished',
      { finishReason: 'stop', metadata: { usage: 1 } },
      { type: 'finish', finishReason: 'stop' },
    ],
    ['run abort', 'run.aborted', { reason: 'cancelled' }, { type: 'abort', reason: 'cancelled' }],
    ['run error', 'run.error', { errorText: 'failed' }, { type: 'error', errorText: 'failed' }],
  ])('replays %s', (_label, eventType, payload, expected) => {
    expect(event(eventType, payload)).toEqual(expect.objectContaining(expected));
  });

  it('replays tool input lifecycle with compact optional metadata', () => {
    expect(
      event('tool.call.input.started', {
        toolCallId: 'tool-1',
        toolName: 'read_file',
        providerExecuted: true,
        dynamic: false,
        title: 'Read file',
      })
    ).toEqual({
      type: 'tool-input-start',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      providerExecuted: true,
      dynamic: false,
      title: 'Read file',
    });
    expect(event('tool.call.input.delta', { toolCallId: 'tool-1' })).toEqual({
      type: 'tool-input-delta',
      toolCallId: 'tool-1',
      inputTextDelta: '',
    });
    expect(
      event('tool.call.started', {
        toolCallId: 'tool-1',
        toolName: 'read_file',
        inputStatus: 'available',
        input: { path: 'a' },
        providerExecuted: 'not-a-boolean',
      })
    ).toEqual({
      type: 'tool-input-available',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      input: { path: 'a' },
    });
    expect(
      event('tool.call.started', {
        toolCallId: 'tool-2',
        toolName: 'write_file',
        inputStatus: 'error',
      })
    ).toEqual({
      type: 'tool-input-error',
      toolCallId: 'tool-2',
      toolName: 'write_file',
      errorText: 'Tool input failed.',
    });
  });

  it('replays completed, failed, and denied tool outputs', () => {
    expect(
      event('tool.call.completed', {
        toolCallId: 'tool-1',
        status: 'completed',
        output: { ok: true },
        preliminary: false,
      })
    ).toEqual({
      type: 'tool-output-available',
      toolCallId: 'tool-1',
      output: { ok: true },
      preliminary: false,
    });
    expect(event('tool.call.completed', { toolCallId: 'tool-2', status: 'failed' })).toEqual({
      type: 'tool-output-error',
      toolCallId: 'tool-2',
      errorText: 'Tool execution failed.',
    });
    expect(event('tool.call.completed', { toolCallId: 'tool-3', status: 'denied' })).toEqual({
      type: 'tool-output-denied',
      toolCallId: 'tool-3',
    });
  });

  it('replays file changes, sources, and files', () => {
    expect(event('tool.file_change', { id: 'change-1', data: { path: 'a' }, transient: true })).toEqual({
      type: 'data-file-change',
      id: 'change-1',
      data: { path: 'a' },
      transient: true,
    });
    expect(
      event('message.source', {
        sourceType: 'url',
        sourceId: 'source-1',
        url: 'https://example.test',
        title: 'Example',
      })
    ).toEqual({
      type: 'source-url',
      sourceId: 'source-1',
      url: 'https://example.test',
      title: 'Example',
    });
    expect(
      event('message.source', {
        sourceType: 'document',
        sourceId: 'source-2',
        mediaType: 'text/plain',
        title: 'README',
        filename: 'README.md',
      })
    ).toEqual({
      type: 'source-document',
      sourceId: 'source-2',
      mediaType: 'text/plain',
      title: 'README',
      filename: 'README.md',
    });
    expect(event('message.file', { url: 'https://example.test/file', mediaType: 'text/plain' })).toEqual({
      type: 'file',
      url: 'https://example.test/file',
      mediaType: 'text/plain',
    });
  });

  it.each([
    ['message part without type', 'message.delta', { partId: 'part-1' }],
    ['message part without id', 'message.delta', { partType: 'text' }],
    ['tool input start without id', 'tool.call.input.started', { toolName: 'read_file' }],
    ['tool input start without name', 'tool.call.input.started', { toolCallId: 'tool-1' }],
    ['tool input delta without id', 'tool.call.input.delta', {}],
    ['tool call started without id', 'tool.call.started', { toolName: 'read_file' }],
    ['tool call started without name', 'tool.call.started', { toolCallId: 'tool-1' }],
    ['tool call completed without id', 'tool.call.completed', {}],
    ['approval request without id', 'approval.requested', { toolCallId: 'tool-1' }],
    ['approval request without call', 'approval.requested', { approvalId: 'approval-1' }],
    ['file change without data', 'tool.file_change', {}],
    ['URL source without id', 'message.source', { sourceType: 'url', url: 'https://example.test' }],
    ['URL source without URL', 'message.source', { sourceType: 'url', sourceId: 'source-1' }],
    [
      'document source without title',
      'message.source',
      { sourceType: 'document', sourceId: 'source-1', mediaType: 'text/plain' },
    ],
    ['unknown source type', 'message.source', { sourceType: 'video' }],
    ['file without URL', 'message.file', { mediaType: 'text/plain' }],
    ['file without media type', 'message.file', { url: 'https://example.test' }],
    ['unknown event', 'unknown.event', {}],
  ])('drops malformed %s', (_label, eventType, payload) => {
    expect(event(eventType, payload)).toBeNull();
  });

  it('uses safe defaults for transition, abort, error, and non-record payloads', () => {
    expect(event('run.transitioned', { finishReason: 'length', metadata: 'invalid', transition: null })).toEqual({
      type: 'finish',
      finishReason: 'length',
      messageMetadata: { transition: {} },
    });
    expect(event('run.aborted', {})).toEqual({ type: 'abort' });
    expect(event('run.error', {})).toEqual({ type: 'error', errorText: 'Agent run failed.' });
    expect(event('message.created', null)).toEqual({ type: 'start' });
    expect(event('message.metadata', [])).toEqual({ type: 'message-metadata', messageMetadata: {} });
  });
});

describe('run.failed error-message compatibility', () => {
  function failure(error: unknown, usageSummary?: unknown, errorText?: unknown) {
    return chunkFromEvent({
      eventType: 'run.failed',
      payload: { error, usageSummary, errorText },
    } as never);
  }

  it('describes a reached iteration limit when the observed step count reaches the configured limit', () => {
    expect(failure({ code: 'max_iterations_exceeded', details: { maxIterations: 12 } }, { steps: 12 })).toEqual({
      type: 'error',
      errorText: 'The agent reached the 12-step limit before it finished. Send a follow-up to continue.',
    });
  });

  it.each([
    ['missing details', { code: 'max_iterations_exceeded' }, undefined],
    ['invalid limit', { code: 'max_iterations_exceeded', details: { maxIterations: 0 } }, undefined],
    ['steps below limit', { code: 'max_iterations_exceeded', details: { maxIterations: 12 } }, { steps: 11 }],
  ])('uses the generic iteration message for %s', (_label, error, usageSummary) => {
    expect(failure(error, usageSummary)).toEqual({
      type: 'error',
      errorText: 'The agent reached its step limit before it finished. Send a follow-up to continue.',
    });
  });

  it('preserves a valid configured limit when the observed step count is malformed', () => {
    expect(failure({ code: 'max_iterations_exceeded', details: { maxIterations: 12 } }, { steps: 1.5 })).toEqual({
      type: 'error',
      errorText: 'The agent reached the 12-step limit before it finished. Send a follow-up to continue.',
    });
  });

  it.each([
    ['missing details', { code: 'run_token_budget_exceeded' }],
    ['non-record details', { code: 'run_token_budget_exceeded', details: 'invalid' }],
    ['invalid maximum', { code: 'run_token_budget_exceeded', details: { maxRunInputTokens: -1 } }],
  ])('uses the generic token-budget message for %s', (_label, error) => {
    expect(failure(error)).toEqual({
      type: 'error',
      errorText:
        'The agent used its input-token budget for this response. Send a follow-up to continue with a fresh budget.',
    });
  });

  it('prefers an ordinary error message, then the event fallback, then the stable default', () => {
    expect(failure({ code: 'provider_error', message: 'Provider unavailable' })).toEqual({
      type: 'error',
      errorText: 'Provider unavailable',
    });
    expect(failure({}, undefined, 'Run failed upstream')).toEqual({ type: 'error', errorText: 'Run failed upstream' });
    expect(failure(null)).toEqual({ type: 'error', errorText: 'Agent run failed.' });
  });
});
