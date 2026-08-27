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

import { sanitizeAgentRunStreamChunks, scrubSecretsFromAgentRunStreamChunks } from '../streamChunks';

describe('agent stream chunk sanitization', () => {
  it('handles an empty stream and deep-clones streams without canonical file-change chunks', () => {
    expect(sanitizeAgentRunStreamChunks([])).toEqual([]);

    const original = [{ type: 'tool-output-available', toolCallId: 'tool-1', output: { nested: { ok: true } } }];
    const sanitized = sanitizeAgentRunStreamChunks(original as never[]);

    expect(sanitized).toEqual(original);
    expect(sanitized).not.toBe(original);
    expect((sanitized[0] as any).output).not.toBe(original[0].output);
  });

  it('removes duplicate fileChanges from tool-output chunks when canonical file-change chunks exist', () => {
    const chunks = sanitizeAgentRunStreamChunks([
      {
        type: 'data-file-change',
        id: 'tool-1:file.ts',
        data: {
          id: 'tool-1:file.ts',
          toolCallId: 'tool-1',
          path: 'file.ts',
          displayPath: 'file.ts',
          sourceTool: 'workspace.edit_file',
          stage: 'applied',
          kind: 'edited',
          additions: 1,
          deletions: 0,
          truncated: false,
        },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: true,
                  path: 'file.ts',
                  fileChanges: [{ path: 'file.ts', additions: 1, deletions: 0 }],
                },
                null,
                2
              ),
            },
          ],
          isError: false,
        },
      },
    ] as never[]);

    const toolOutputChunk = chunks.find((chunk) => chunk.type === 'tool-output-available');
    const text = (toolOutputChunk as { output: { content: Array<{ text: string }> } }).output.content[0].text;

    expect(text).not.toContain('fileChanges');
    expect(text).toContain('"path": "file.ts"');
  });

  it('removes direct duplicate changes while preserving malformed and unrelated output content', () => {
    const chunks = sanitizeAgentRunStreamChunks([
      {
        type: 'data-file-change',
        data: { toolCallId: 'tool-1' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: {
          fileChanges: [{ path: 'file.ts' }],
          content: [
            null,
            { type: 'metadata', fileChanges: [{ path: 'file.ts' }] },
            { type: 'text', text: '{not-json' },
            { type: 'text', text: '[]' },
            { type: 'text', text: '{"ok":true}' },
          ],
        },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: 'plain output',
      },
      {
        type: 'tool-output-available',
        toolCallId: 'unrelated-tool',
        output: { fileChanges: [{ path: 'keep.ts' }] },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: { ok: true },
      },
    ] as never[]);

    expect(chunks[1]).toEqual({
      type: 'tool-output-available',
      toolCallId: 'tool-1',
      output: {
        content: [
          null,
          { type: 'metadata' },
          { type: 'text', text: '{not-json' },
          { type: 'text', text: '[]' },
          { type: 'text', text: '{"ok":true}' },
        ],
      },
    });
    expect(chunks[2]).toEqual({
      type: 'tool-output-available',
      toolCallId: 'tool-1',
      output: 'plain output',
    });
    expect(chunks[3]).toEqual({
      type: 'tool-output-available',
      toolCallId: 'unrelated-tool',
      output: { fileChanges: [{ path: 'keep.ts' }] },
    });
    expect(chunks[4]).toEqual({
      type: 'tool-output-available',
      toolCallId: 'tool-1',
      output: { ok: true },
    });
  });

  it('ignores malformed canonical file-change records', () => {
    const chunks = [
      null,
      { type: 'data-file-change', data: null },
      { type: 'data-file-change', data: { toolCallId: '   ' } },
      { type: 'tool-output-available', toolCallId: 'tool-1', output: { fileChanges: [] } },
    ] as never[];

    expect(sanitizeAgentRunStreamChunks(chunks)).toEqual(chunks);
  });
});

describe('scrubSecretsFromAgentRunStreamChunks', () => {
  it('preserves an empty stream and unchanged reasoning chunks', () => {
    const empty: never[] = [];
    const unchanged = [{ type: 'reasoning-start', id: 'r1', text: 'review the deployment' }] as never[];

    expect(scrubSecretsFromAgentRunStreamChunks(empty)).toBe(empty);
    expect(scrubSecretsFromAgentRunStreamChunks(unchanged)[0]).toBe(unchanged[0]);
  });

  it('redacts secrets in reasoning-delta chunk text', () => {
    const scrubbed = scrubSecretsFromAgentRunStreamChunks([
      { type: 'reasoning-delta', id: 'r1', delta: 'use ghp_1234567890abcdefghij1234567890ABCDwxyz now' },
      { type: 'text-delta', id: 't1', delta: 'token ghp_1234567890abcdefghij1234567890ABCDwxyz stays' },
    ] as never[]);

    expect((scrubbed[0] as { delta: string }).delta).toBe('use [redacted] now');
    // text chunks are out of scope — left untouched.
    expect((scrubbed[1] as { delta: string }).delta).toContain('ghp_');
  });

  it('redacts a secret carried by reasoning-start text', () => {
    const scrubbed = scrubSecretsFromAgentRunStreamChunks([
      { type: 'reasoning-start', id: 'r1', text: 'token=ghp_1234567890abcdefghij1234567890ABCDwxyz' },
    ] as never[]);

    expect((scrubbed[0] as { text: string }).text).toBe('token=[redacted]');
  });
});
