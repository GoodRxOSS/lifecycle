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

import type { AgentUIMessage } from '../types';

const mockUuid = jest.fn();
const mockWarn = jest.fn();

jest.mock('uuid', () => ({
  v4: () => mockUuid(),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ warn: mockWarn })),
}));

import {
  getCanonicalPartsFromUiMessage,
  normalizeCanonicalAgentMessagePart,
  normalizeCanonicalAgentMessageParts,
  toUiMessageFromCanonicalInput,
  type CanonicalAgentMessagePart,
} from '../canonicalMessages';

const SECRET = 'ghp_1234567890abcdefghij1234567890ABCDwxyz';

function uiMessage(
  parts: Array<Record<string, unknown>>,
  { id = 'message-1', role = 'assistant' }: { id?: string; role?: AgentUIMessage['role'] } = {}
): AgentUIMessage {
  return { id, role, parts } as unknown as AgentUIMessage;
}

describe('canonical part normalization', () => {
  it('filters non-parts, unknown types, and blank text from a collection', () => {
    expect(normalizeCanonicalAgentMessageParts({ parts: [] })).toEqual([]);
    expect(
      normalizeCanonicalAgentMessageParts([
        null,
        'text',
        { type: 'unknown', value: 'ignored' },
        { type: 'text', text: '   ' },
        { type: 'reasoning', text: '' },
        { type: 'text', text: 'kept' },
      ])
    ).toEqual([{ type: 'text', text: 'kept' }]);
    expect(normalizeCanonicalAgentMessagePart(false)).toBeNull();
  });

  it('normalizes file and source references while requiring a usable locator', () => {
    expect(
      normalizeCanonicalAgentMessagePart({
        type: 'file_ref',
        path: 'src/index.ts',
        url: '   ',
        mediaType: 'text/typescript',
        title: 'Entry point',
      })
    ).toEqual({
      type: 'file_ref',
      path: 'src/index.ts',
      url: null,
      mediaType: 'text/typescript',
      title: 'Entry point',
    });
    expect(normalizeCanonicalAgentMessagePart({ type: 'file_ref', path: '', url: null })).toBeNull();

    expect(
      normalizeCanonicalAgentMessagePart({
        type: 'source_ref',
        url: null,
        title: 'Design notes',
        sourceType: 'document',
        sourceId: 'source-1',
        mediaType: 'text/markdown',
      })
    ).toEqual({
      type: 'source_ref',
      url: null,
      title: 'Design notes',
      sourceType: 'document',
      sourceId: 'source-1',
      mediaType: 'text/markdown',
    });
    expect(normalizeCanonicalAgentMessagePart({ type: 'source_ref', url: ' ', title: '' })).toBeNull();
  });

  it('scrubs and bounds persisted tool input, output, and approval details', () => {
    const input = `${SECRET}:${'i'.repeat(2_100)}`;
    const output = `${SECRET}:${'o'.repeat(4_100)}`;

    const normalized = normalizeCanonicalAgentMessagePart({
      type: 'tool_call',
      toolName: 'run_query',
      toolCallId: 'call-1',
      state: 'denied',
      input,
      output,
      approval: { id: 'approval-1', approved: false, reason: 'Not allowed' },
    });

    expect(normalized).toMatchObject({
      type: 'tool_call',
      toolName: 'run_query',
      toolCallId: 'call-1',
      state: 'denied',
      approval: { id: 'approval-1', approved: false, reason: 'Not allowed' },
    });
    const tool = normalized as Extract<CanonicalAgentMessagePart, { type: 'tool_call' }>;
    expect(tool.input).toHaveLength(2_000 + '\n… [truncated]'.length);
    expect(tool.output).toHaveLength(4_000 + '\n… [truncated]'.length);
    expect(tool.input).toMatch(/^\[redacted\]:/);
    expect(tool.output).toMatch(/^\[redacted\]:/);
    expect(tool.input).toMatch(/\n… \[truncated\]$/);
    expect(tool.output).toMatch(/\n… \[truncated\]$/);
    expect(tool.input).not.toContain(SECRET);
    expect(tool.output).not.toContain(SECRET);
  });

  it.each([
    ['a tool name', { toolName: '', toolCallId: 'call-1', state: 'completed' }],
    ['a call id', { toolName: 'run_query', toolCallId: ' ', state: 'error' }],
    ['a settled state', { toolName: 'run_query', toolCallId: 'call-1', state: 'input-available' }],
  ])('rejects a tool call without %s', (_case, fields) => {
    expect(normalizeCanonicalAgentMessagePart({ type: 'tool_call', ...fields })).toBeNull();
  });

  it('normalizes optional tool fields to null when they are unusable', () => {
    expect(
      normalizeCanonicalAgentMessagePart({
        type: 'tool_call',
        toolName: 'run_query',
        toolCallId: 'call-2',
        state: 'error',
        input: ' ',
        output: undefined,
        approval: { id: ' ', approved: null, reason: '' },
      })
    ).toEqual({
      type: 'tool_call',
      toolName: 'run_query',
      toolCallId: 'call-2',
      state: 'error',
      input: null,
      output: null,
      approval: { id: null, approved: null, reason: null },
    });
  });
});

describe('UI message persistence projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUuid.mockReturnValue('generated-id');
  });

  it('projects text, file, and source parts and filters empty variants', () => {
    const parts = getCanonicalPartsFromUiMessage(
      uiMessage([
        { type: 'text', text: '   ' },
        { type: 'reasoning', text: '' },
        {
          type: 'file',
          filename: 'report.txt',
          path: 'ignored.txt',
          url: 'https://example.test/report.txt',
          mediaType: 'text/plain',
          title: 'Ignored title',
        },
        { type: 'file', path: 'legacy/path.md', title: 'Legacy path', mediaType: 'text/markdown' },
        {
          type: 'source-url',
          url: 'https://example.test/docs',
          title: 'Docs',
          sourceId: 'source-url-1',
        },
        {
          type: 'source-document',
          title: 'Architecture',
          sourceId: 'source-doc-1',
          mediaType: 'text/markdown',
        },
        { type: 'file', filename: '', url: '' },
        { type: 'data-unrelated', data: { ignored: true } },
      ])
    );

    expect(parts).toEqual([
      {
        type: 'file_ref',
        path: 'report.txt',
        url: 'https://example.test/report.txt',
        mediaType: 'text/plain',
        title: 'report.txt',
      },
      {
        type: 'file_ref',
        path: 'legacy/path.md',
        url: null,
        mediaType: 'text/markdown',
        title: 'Legacy path',
      },
      {
        type: 'source_ref',
        url: 'https://example.test/docs',
        title: 'Docs',
        sourceType: 'url',
        sourceId: 'source-url-1',
        mediaType: null,
      },
      {
        type: 'source_ref',
        url: null,
        title: 'Architecture',
        sourceType: 'document',
        sourceId: 'source-doc-1',
        mediaType: 'text/markdown',
      },
    ]);
  });

  it('collapses repeated assistant text and emits one observable warning', () => {
    const answer =
      'Rivers are dynamic arteries, shaping landscapes and sustaining ecosystems since the dawn of humanity. ' +
      'From the majestic Amazon to the historic Nile, they have played an indelible role in the story of Earth. ' +
      'Their journeys begin as humble trickles, often high in mountainous regions, fed by melting snows.';

    expect(
      getCanonicalPartsFromUiMessage(uiMessage([{ type: 'text', text: answer + answer }], { id: 'repeated-1' }))
    ).toEqual([{ type: 'text', text: answer }]);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      { messageId: 'repeated-1', originalLength: (answer + answer).length },
      'AgentMessages: collapsed self-repeated assistant text messageId=repeated-1'
    );
  });

  it('persists settled tool states, value previews, and skips unsettled activity', () => {
    const circularOutput: Record<string, unknown> = {};
    circularOutput.self = circularOutput;

    const parts = getCanonicalPartsFromUiMessage(
      uiMessage([
        {
          type: 'dynamic-tool',
          toolName: 'search',
          toolCallId: 'call-completed',
          state: 'output-available',
          input: { query: 'lifecycle' },
          output: { rows: [1] },
        },
        {
          type: 'dynamic-tool',
          toolName: 'deploy',
          toolCallId: 'call-error',
          state: 'output-error',
          input: 7,
          output: 'ignored output',
          errorText: 'deployment failed',
        },
        {
          type: 'tool-read_file',
          toolCallId: 'call-static-error',
          state: 'output-error',
          input: { preview: 'cached preview' },
          output: 'fallback error output',
        },
        {
          type: 'dynamic-tool',
          toolName: 'inspect',
          toolCallId: 'call-circular',
          state: 'output-available',
          input: { preview: 'value', extra: true },
          output: circularOutput,
        },
        {
          type: 'dynamic-tool',
          toolName: 'delete_file',
          toolCallId: 'call-denied',
          state: 'output-denied',
          input: null,
          output: null,
          approval: { id: 'approval-1', approved: false, reason: 'Keep it' },
        },
        {
          type: 'dynamic-tool',
          toolName: 'still_running',
          toolCallId: 'call-pending',
          state: 'input-available',
          input: { value: 1 },
        },
      ])
    );

    expect(parts).toEqual([
      {
        type: 'tool_call',
        toolName: 'search',
        toolCallId: 'call-completed',
        state: 'completed',
        input: '{"query":"lifecycle"}',
        output: '{"rows":[1]}',
        approval: null,
      },
      {
        type: 'tool_call',
        toolName: 'deploy',
        toolCallId: 'call-error',
        state: 'error',
        input: '7',
        output: 'deployment failed',
        approval: null,
      },
      {
        type: 'tool_call',
        toolName: 'read_file',
        toolCallId: 'call-static-error',
        state: 'error',
        input: 'cached preview',
        output: 'fallback error output',
        approval: null,
      },
      {
        type: 'tool_call',
        toolName: 'inspect',
        toolCallId: 'call-circular',
        state: 'completed',
        input: '{"preview":"value","extra":true}',
        output: '[object Object]',
        approval: null,
      },
      {
        type: 'tool_call',
        toolName: 'delete_file',
        toolCallId: 'call-denied',
        state: 'denied',
        input: null,
        output: null,
        approval: { id: 'approval-1', approved: false, reason: 'Keep it' },
      },
    ]);
  });
});

describe('canonical replay projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUuid.mockReturnValue('generated-id');
  });

  it('preserves message identity, role, and explicit metadata without generating an id', () => {
    const metadata = { model: 'claude-sonnet', warningCount: 1 };

    expect(
      toUiMessageFromCanonicalInput(
        { id: 'canonical-1', role: 'system', parts: [{ type: 'text', text: 'System note' }] },
        metadata
      )
    ).toEqual({
      id: 'canonical-1',
      role: 'system',
      parts: [{ type: 'text', text: 'System note' }],
      metadata,
    });
    expect(mockUuid).not.toHaveBeenCalled();
  });

  it('generates missing identities and valid default file and source shapes', () => {
    mockUuid
      .mockReturnValueOnce('file-source-id')
      .mockReturnValueOnce('url-source-id')
      .mockReturnValueOnce('document-source-id')
      .mockReturnValueOnce('message-id');

    const message = toUiMessageFromCanonicalInput({
      id: '   ',
      role: 'assistant',
      parts: [
        { type: 'file_ref', url: 'https://example.test/file.bin', path: null, mediaType: null, title: null },
        { type: 'file_ref', path: 'notes.md', url: null, mediaType: null, title: null },
        { type: 'file_ref', path: null, url: null, mediaType: null, title: null },
        { type: 'source_ref', url: 'https://example.test', title: 'Example', sourceId: null },
        { type: 'source_ref', url: null, title: 'Document', sourceId: null, mediaType: null },
        { type: 'source_ref', url: null, title: null },
      ],
    });

    expect(message).toEqual({
      id: 'message-id',
      role: 'assistant',
      metadata: {},
      parts: [
        {
          type: 'file',
          url: 'https://example.test/file.bin',
          mediaType: 'application/octet-stream',
        },
        {
          type: 'source-document',
          sourceId: 'file-source-id',
          mediaType: 'application/octet-stream',
          title: 'notes.md',
          filename: 'notes.md',
        },
        {
          type: 'source-url',
          sourceId: 'url-source-id',
          url: 'https://example.test',
          title: 'Example',
        },
        {
          type: 'source-document',
          sourceId: 'document-source-id',
          mediaType: 'text/plain',
          title: 'Document',
        },
      ],
    });
  });

  it('projects completed, errored, and denied tool calls with replay-safe defaults', () => {
    mockUuid.mockReturnValueOnce('generated-approval-id');

    const message = toUiMessageFromCanonicalInput({
      id: 'canonical-tools',
      role: 'assistant',
      parts: [
        {
          type: 'tool_call',
          toolName: 'search',
          toolCallId: 'call-completed',
          state: 'completed',
          input: '{"query":"lifecycle"}',
          output: null,
        },
        {
          type: 'tool_call',
          toolName: 'deploy',
          toolCallId: 'call-error',
          state: 'error',
          input: 'bounded non-json preview',
          output: null,
        },
        {
          type: 'tool_call',
          toolName: 'delete_file',
          toolCallId: 'call-denied-generated',
          state: 'denied',
          input: null,
          output: null,
          approval: null,
        },
        {
          type: 'tool_call',
          toolName: 'write_file',
          toolCallId: 'call-denied-existing',
          state: 'denied',
          input: null,
          output: null,
          approval: { id: 'approval-existing', approved: false, reason: 'Not now' },
        },
      ],
    });

    expect(message.parts).toEqual([
      {
        type: 'dynamic-tool',
        toolName: 'search',
        toolCallId: 'call-completed',
        state: 'output-available',
        input: { query: 'lifecycle' },
        output: '',
      },
      {
        type: 'dynamic-tool',
        toolName: 'deploy',
        toolCallId: 'call-error',
        state: 'output-error',
        input: { preview: 'bounded non-json preview' },
        errorText: 'Tool call failed.',
      },
      {
        type: 'dynamic-tool',
        toolName: 'delete_file',
        toolCallId: 'call-denied-generated',
        state: 'output-denied',
        input: {},
        approval: { id: 'generated-approval-id', approved: false },
      },
      {
        type: 'dynamic-tool',
        toolName: 'write_file',
        toolCallId: 'call-denied-existing',
        state: 'output-denied',
        input: {},
        approval: { id: 'approval-existing', approved: false, reason: 'Not now' },
      },
    ]);
  });
});
