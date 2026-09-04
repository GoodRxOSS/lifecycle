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

import {
  addFileChangesToApprovalPayload,
  applyApprovalResponsesToFileChangeParts,
  buildProposedFileChanges,
  buildResultFileChanges,
  listMessageFileChanges,
} from '../fileChanges';

describe('buildProposedFileChanges', () => {
  it('keeps workspace edit approvals as before-and-after previews instead of fake diffs', () => {
    const [change] = buildProposedFileChanges({
      toolCallId: 'tool-1',
      sourceTool: 'mcp__workspace_core__edit_file',
      input: {
        path: '/workspace/sample-service/app.js',
        old_text: 'before',
        new_text: 'after',
      },
    });

    expect(change).toMatchObject({
      id: 'tool-1:sample-service/app.js',
      toolCallId: 'tool-1',
      sourceTool: 'mcp__workspace_core__edit_file',
      path: '/workspace/sample-service/app.js',
      displayPath: 'sample-service/app.js',
      stage: 'awaiting-approval',
      unifiedDiff: null,
      beforeTextPreview: 'before',
      afterTextPreview: 'after',
    });
  });

  it('keeps workspace writes as preview-only changes', () => {
    const [change] = buildProposedFileChanges({
      toolCallId: 'tool-2',
      sourceTool: 'mcp__workspace_core__write_file',
      input: {
        path: '/workspace/sample-service/README.md',
        content: '# Sample service',
      },
    });

    expect(change).toMatchObject({
      id: 'tool-2:sample-service/README.md',
      toolCallId: 'tool-2',
      sourceTool: 'mcp__workspace_core__write_file',
      path: '/workspace/sample-service/README.md',
      displayPath: 'sample-service/README.md',
      stage: 'awaiting-approval',
      unifiedDiff: null,
      beforeTextPreview: null,
      afterTextPreview: '# Sample service',
    });
  });

  it('normalizes tool naming, counts changed lines, hashes content, and truncates previews', () => {
    const [change] = buildProposedFileChanges({
      toolCallId: 'tool-3',
      sourceTool: 'MCP__WORKSPACE.CORE__EDIT-FILE',
      input: {
        path: './src/index.ts',
        old_text: 'old line 1\nold line 2',
        new_text: 'new line 1\nnew line 2\nnew line 3',
      },
      previewChars: 8,
    });

    expect(change).toMatchObject({
      id: 'tool-3:src/index.ts',
      additions: 3,
      deletions: 2,
      beforeTextPreview: 'old line\n\n[truncated]',
      afterTextPreview: 'new line\n\n[truncated]',
      summary: 'Proposed update to src/index.ts',
      encoding: 'utf-8',
      oldSizeBytes: Buffer.byteLength('old line 1\nold line 2'),
      newSizeBytes: Buffer.byteLength('new line 1\nnew line 2\nnew line 3'),
      oldSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      newSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('handles an empty edit and multiline write with the current count and checksum contract', () => {
    const [edit] = buildProposedFileChanges({
      toolCallId: 'tool-edit',
      sourceTool: 'edit_file',
      input: { path: 'empty.txt', old_text: '', new_text: '' },
    });
    const [write] = buildProposedFileChanges({
      toolCallId: 'tool-write',
      sourceTool: 'write_file',
      input: { path: './created.txt', content: 'one\ntwo' },
    });

    expect(edit).toMatchObject({ additions: 0, deletions: 0, beforeTextPreview: null, afterTextPreview: null });
    expect(write).toMatchObject({
      id: 'tool-write:created.txt',
      additions: 2,
      deletions: 0,
      summary: 'Proposed write to created.txt',
      oldSizeBytes: null,
      newSizeBytes: 7,
      oldSha256: null,
      newSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    ['edit_file', null],
    ['edit_file', { path: 'a', old_text: 'old' }],
    ['edit_file', { path: 'a', new_text: 'new' }],
    ['edit_file', { old_text: 'old', new_text: 'new' }],
    ['write_file', []],
    ['write_file', { path: 'a' }],
    ['write_file', { content: 'new' }],
    ['read_file', { path: 'a' }],
  ])('returns no proposal for invalid %s input %p', (sourceTool, input) => {
    expect(
      buildProposedFileChanges({
        toolCallId: 'tool-invalid',
        sourceTool,
        input: input as any,
      })
    ).toEqual([]);
  });
});

describe('buildResultFileChanges', () => {
  const base = {
    toolCallId: 'tool-1',
    sourceTool: 'edit_file',
    input: { path: '/workspace/a.txt', old_text: 'old', new_text: 'new' },
  };

  it('maps structured artifacts, derives patch stats, preserves metadata, and applies the result stage', () => {
    const changes = buildResultFileChanges({
      ...base,
      failed: false,
      previewChars: 5,
      result: {
        fileChanges: [
          {
            path: '/workspace/created.txt',
            kind: 'created',
            unifiedDiff: ['--- a/created.txt', '+++ b/created.txt', '@@ -1 +1,2 @@', '-old', '+new', '+second'].join(
              '\n'
            ),
            beforeTextPreview: 'before-long',
            afterTextPreview: 'after-long',
            encoding: 'utf-8',
            oldSizeBytes: 3,
            newSizeBytes: 10,
            oldSha256: 'old-sha',
            newSha256: 'new-sha',
            truncated: true,
          },
          {
            path: 'deleted.txt',
            kind: 'deleted',
            unifiedDiff: null,
            additions: 4,
            deletions: 5,
            summary: 'Custom summary',
          },
          {
            path: '/workspace/deleted-with-default-summary.txt',
            kind: 'deleted',
          },
        ],
      },
    });

    expect(changes).toHaveLength(3);
    expect(changes[0]).toMatchObject({
      id: 'tool-1:created.txt',
      kind: 'created',
      additions: 2,
      deletions: 1,
      truncated: true,
      stage: 'applied',
      summary: 'Created created.txt',
      beforeTextPreview: 'befor\n\n[truncated]',
      afterTextPreview: 'after\n\n[truncated]',
      encoding: 'utf-8',
      oldSizeBytes: 3,
      newSizeBytes: 10,
      oldSha256: 'old-sha',
      newSha256: 'new-sha',
    });
    expect(changes[1]).toMatchObject({
      kind: 'deleted',
      additions: 4,
      deletions: 5,
      summary: 'Custom summary',
      stage: 'applied',
    });
    expect(changes[2]).toMatchObject({
      kind: 'deleted',
      summary: 'Deleted deleted-with-default-summary.txt',
      stage: 'applied',
    });
  });

  it('unwraps JSON text tool payloads and defaults malformed artifact fields', () => {
    const result = {
      content: [
        { type: 'image', data: 'ignored' },
        {
          type: 'text',
          text: JSON.stringify({
            fileChanges: [
              {
                path: 'edited.txt',
                kind: 'unknown',
                additions: Number.NaN,
                deletions: Number.POSITIVE_INFINITY,
                unifiedDiff: '+one\n-two',
                beforeTextPreview: 42,
                afterTextPreview: null,
                oldSizeBytes: Number.NaN,
                newSizeBytes: '10',
              },
              { path: 42 },
              null,
            ],
          }),
        },
      ],
    };

    const changes = buildResultFileChanges({ ...base, result, failed: true });

    expect(changes).toEqual([
      expect.objectContaining({
        path: 'edited.txt',
        kind: 'edited',
        additions: 1,
        deletions: 1,
        stage: 'failed',
        summary: 'Updated edited.txt',
        beforeTextPreview: null,
        afterTextPreview: null,
        encoding: null,
        oldSizeBytes: null,
        newSizeBytes: null,
        oldSha256: null,
        newSha256: null,
      }),
    ]);
  });

  it.each([
    ['no result', null],
    ['non-JSON text wrapper', { content: [{ type: 'text', text: 'not json' }] }],
    ['blank text wrapper', { content: [{ type: 'text', text: '   ' }] }],
    ['wrapper without text', { content: [{ type: 'image' }] }],
    ['ordinary result', { ok: true }],
  ])('returns no changes for successful %s without artifacts', (_label, result) => {
    expect(buildResultFileChanges({ ...base, result, failed: false })).toEqual([]);
  });

  it('falls back to a failed proposal when a failed result has no artifacts', () => {
    const changes = buildResultFileChanges({ ...base, result: { error: 'failed' }, failed: true });

    expect(changes).toEqual([
      expect.objectContaining({
        id: 'tool-1:a.txt',
        stage: 'failed',
        beforeTextPreview: 'old',
        afterTextPreview: 'new',
      }),
    ]);
  });
});

function fileChange(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool-1:a.txt',
    toolCallId: 'tool-1',
    sourceTool: 'edit_file',
    displayPath: 'a.txt',
    path: '/workspace/a.txt',
    kind: 'edited',
    additions: 1,
    deletions: 1,
    truncated: false,
    unifiedDiff: null,
    beforeTextPreview: 'old',
    afterTextPreview: 'new',
    summary: 'Updated a.txt',
    encoding: 'utf-8',
    oldSizeBytes: 3,
    newSizeBytes: 3,
    oldSha256: 'old-sha',
    newSha256: 'new-sha',
    stage: 'awaiting-approval',
    ...overrides,
  };
}

describe('message file-change folding', () => {
  it('keeps the latest valid part per id and defaults an invalid stage', () => {
    const earlier = fileChange({ stage: 'approved' });
    const latest = fileChange({ stage: 'unexpected', afterTextPreview: 'latest' });
    const result = listMessageFileChanges({
      role: 'assistant',
      parts: [
        null,
        { type: 'text', text: 'ignored' },
        { type: 'data-file-change', data: { id: 'missing-fields' } },
        { type: 'data-file-change', data: earlier },
        { type: 'data-file-change', data: latest },
      ],
    } as any);

    expect(result).toEqual([
      expect.objectContaining({
        id: 'tool-1:a.txt',
        stage: 'awaiting-approval',
        afterTextPreview: 'latest',
      }),
    ]);
  });

  it.each(['approved', 'applied', 'denied', 'failed', 'awaiting-approval'])('preserves the valid %s stage', (stage) => {
    const [result] = listMessageFileChanges({
      role: 'assistant',
      parts: [{ type: 'data-file-change', data: fileChange({ stage }) }],
    } as any);
    expect(result.stage).toBe(stage);
  });

  it('adds only matching file changes to an approval payload', () => {
    const payload = { actionId: 'action-1' };
    const message = {
      role: 'assistant',
      parts: [
        { type: 'data-file-change', data: fileChange() },
        { type: 'data-file-change', data: fileChange({ id: 'tool-2:b.txt', toolCallId: 'tool-2', path: 'b.txt' }) },
      ],
    } as any;

    expect(addFileChangesToApprovalPayload({ payload, message, toolCallId: 'tool-1' })).toEqual({
      actionId: 'action-1',
      fileChanges: [expect.objectContaining({ toolCallId: 'tool-1' })],
    });
    expect(addFileChangesToApprovalPayload({ payload, message, toolCallId: null })).toBe(payload);
    expect(addFileChangesToApprovalPayload({ payload, message, toolCallId: 'missing' })).toBe(payload);
  });

  it('applies approved and denied tool responses to their matching file-change parts', () => {
    const userMessage = { role: 'user', parts: [{ type: 'text', text: 'hello' }] } as any;
    const unchangedAssistant = { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] } as any;
    const assistant = {
      role: 'assistant',
      parts: [
        {
          type: 'tool-edit_file',
          state: 'approval-responded',
          toolCallId: 'tool-1',
          approval: { approved: false },
        },
        {
          type: 'dynamic-tool',
          state: 'approval-responded',
          toolCallId: 'tool-2',
          approval: { approved: true },
        },
        { type: 'tool-ignored', state: 'input-available', toolCallId: 'tool-3', input: {} },
        { type: 'data-file-change', data: fileChange() },
        {
          type: 'data-file-change',
          data: fileChange({ id: 'tool-2:b.txt', toolCallId: 'tool-2', path: 'b.txt', displayPath: 'b.txt' }),
        },
        {
          type: 'data-file-change',
          data: fileChange({ id: 'tool-3:c.txt', toolCallId: 'tool-3', path: 'c.txt', displayPath: 'c.txt' }),
        },
        { type: 'data-file-change', data: { malformed: true } },
        { type: 'text', text: 'unchanged' },
      ],
    } as any;

    const result = applyApprovalResponsesToFileChangeParts([userMessage, unchangedAssistant, assistant]);

    expect(result[0]).toBe(userMessage);
    expect(result[1]).toBe(unchangedAssistant);
    expect((result[2].parts[3] as any).data.stage).toBe('denied');
    expect((result[2].parts[4] as any).data.stage).toBe('approved');
    expect((result[2].parts[5] as any).data.stage).toBe('awaiting-approval');
    expect(result[2].parts[6]).toBe(assistant.parts[6]);
    expect(result[2].parts[7]).toBe(assistant.parts[7]);
  });
});
