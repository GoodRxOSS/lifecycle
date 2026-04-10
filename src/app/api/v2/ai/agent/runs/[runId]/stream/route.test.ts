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

import { NextRequest } from 'next/server';

const mockCreateUIMessageStream = jest.fn();
const mockCreateUIMessageStreamResponse = jest.fn();

jest.mock('ai', () => ({
  createUIMessageStream: (...args: unknown[]) => mockCreateUIMessageStream(...args),
  createUIMessageStreamResponse: (...args: unknown[]) => mockCreateUIMessageStreamResponse(...args),
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    getOwnedRun: jest.fn(),
    isRunNotFoundError: jest.fn(),
  },
}));

jest.mock('server/services/agent/StreamBroker', () => ({
  __esModule: true,
  default: {
    open: jest.fn(),
  },
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  default: {
    listRunMessages: jest.fn(),
  },
}));

import { GET } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentRunService from 'server/services/agent/RunService';
import AgentStreamBroker from 'server/services/agent/StreamBroker';
import AgentMessageStore from 'server/services/agent/MessageStore';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockGetOwnedRun = AgentRunService.getOwnedRun as jest.Mock;
const mockIsRunNotFoundError = AgentRunService.isRunNotFoundError as jest.Mock;
const mockOpenStream = AgentStreamBroker.open as jest.Mock;
const mockListRunMessages = AgentMessageStore.listRunMessages as jest.Mock;

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/runs/[runId]/stream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateUIMessageStream.mockImplementation(({ execute }) => {
      const chunks: unknown[] = [];
      void execute({
        writer: {
          write: (chunk: unknown) => {
            chunks.push(chunk);
          },
        },
      });
      return chunks;
    });
    mockCreateUIMessageStreamResponse.mockImplementation(
      ({ stream }) =>
        new Response(JSON.stringify(stream), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        })
    );
  });

  it('returns 204 when the run cannot be found', async () => {
    const missingRunError = new Error('Agent run not found');
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
    mockGetOwnedRun.mockRejectedValue(missingRunError);
    mockIsRunNotFoundError.mockReturnValue(true);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/unavailable/stream'), {
      params: { runId: 'unavailable' },
    });

    expect(response.status).toBe(204);
    expect(mockOpenStream).not.toHaveBeenCalled();
    expect(mockListRunMessages).not.toHaveBeenCalled();
  });

  it('replays only the final tool state for completed approval-backed tools', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
    mockGetOwnedRun.mockResolvedValue({
      uuid: 'run-123',
      status: 'completed',
      streamState: {
        finishReason: 'stop',
      },
    });
    mockOpenStream.mockReturnValue(null);
    mockListRunMessages.mockResolvedValue([
      {
        id: 'assistant-1',
        role: 'assistant',
        metadata: {
          runId: 'run-123',
        },
        parts: [
          {
            type: 'tool-workspace_edit_file',
            toolCallId: 'tool-1',
            toolName: 'workspace_edit_file',
            state: 'output-available',
            input: {
              path: '/workspace/sample.ts',
              oldText: 'before',
              newText: 'after',
            },
            output: {
              ok: true,
            },
            approval: {
              id: 'approval-1',
            },
          },
        ],
      },
    ]);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/run-123/stream'), {
      params: { runId: 'run-123' },
    });

    const chunks = (await response.json()) as Array<{ type: string }>;

    expect(response.status).toBe(200);
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(chunks.some((chunk) => chunk.type === 'tool-output-available')).toBe(true);
  });

  it('removes duplicate file-change payloads from replayed tool output when canonical file changes exist', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
    mockGetOwnedRun.mockResolvedValue({
      uuid: 'run-456',
      status: 'completed',
      streamState: {
        finishReason: 'stop',
      },
    });
    mockOpenStream.mockReturnValue(null);
    mockListRunMessages.mockResolvedValue([
      {
        id: 'assistant-2',
        role: 'assistant',
        metadata: {
          runId: 'run-456',
        },
        parts: [
          {
            type: 'data-file-change',
            id: 'tool-2:file.ts',
            data: {
              id: 'tool-2:file.ts',
              toolCallId: 'tool-2',
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
            type: 'tool-workspace_edit_file',
            toolCallId: 'tool-2',
            toolName: 'workspace_edit_file',
            state: 'output-available',
            output: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: true,
                      path: 'file.ts',
                      fileChanges: [{ path: 'file.ts', additions: 1 }],
                    },
                    null,
                    2
                  ),
                },
              ],
            },
          },
        ],
      },
    ]);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/run-456/stream'), {
      params: { runId: 'run-456' },
    });

    const chunks = (await response.json()) as Array<{
      type: string;
      output?: {
        content?: Array<{ text?: string }>;
      };
    }>;
    const toolOutput = chunks.find((chunk) => chunk.type === 'tool-output-available');

    expect(response.status).toBe(200);
    expect(toolOutput?.output?.content?.[0]?.text).not.toContain('fileChanges');
  });

  it('replays stored stream chunks when terminal runs have no persisted assistant message', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
    mockGetOwnedRun.mockResolvedValue({
      uuid: 'run-234',
      status: 'completed',
      streamState: {
        chunks: [
          {
            type: 'start',
            messageMetadata: {
              runId: 'run-234',
            },
          },
          {
            type: 'text-start',
            id: 'text-1',
          },
          {
            type: 'text-delta',
            id: 'text-1',
            delta: 'Recovered answer',
          },
          {
            type: 'text-end',
            id: 'text-1',
          },
          {
            type: 'finish',
            finishReason: 'stop',
          },
        ],
      },
    });
    mockOpenStream.mockReturnValue(null);
    mockListRunMessages.mockResolvedValue([
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ]);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/run-234/stream'), {
      params: { runId: 'run-234' },
    });

    const chunks = (await response.json()) as Array<{ type: string }>;

    expect(response.status).toBe(200);
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true);
  });
});
