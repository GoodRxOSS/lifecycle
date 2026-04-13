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

import { sanitizeAgentRunStreamChunks, sanitizeAgentRunStreamState } from '../streamState';

describe('agent stream replay sanitization', () => {
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

  it('drops redundant top-level finishReason when the finish chunk already records it', () => {
    const streamState = sanitizeAgentRunStreamState({
      finishReason: 'stop',
      chunks: [
        {
          type: 'finish',
          finishReason: 'stop',
        },
      ],
    });

    expect(streamState.finishReason).toBeUndefined();
    expect(streamState.chunks).toEqual([
      {
        type: 'finish',
        finishReason: 'stop',
      },
    ]);
  });
});
