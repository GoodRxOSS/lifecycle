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

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/services/agent/ApprovalService', () => ({
  __esModule: true,
  default: {
    listPendingActions: jest.fn(),
    serializePendingAction: jest.fn((action) => action),
  },
}));

import { GET } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import ApprovalService from 'server/services/agent/ApprovalService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockListPendingActions = ApprovalService.listPendingActions as jest.Mock;
const mockSerializePendingAction = ApprovalService.serializePendingAction as jest.Mock;

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/pending-actions'),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/threads/[threadId]/pending-actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when the requester is not authenticated', async () => {
    mockGetRequestUserIdentity.mockReturnValue(null);

    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Unauthorized' },
    });
    expect(mockListPendingActions).not.toHaveBeenCalled();
  });

  it('returns canonical pending action display payloads for the owned thread', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockListPendingActions.mockResolvedValue([
      {
        id: 'action-db-id',
        publicPayload: true,
      },
    ]);
    mockSerializePendingAction.mockReturnValue({
      id: 'action-1',
      kind: 'tool_approval',
      status: 'pending',
      threadId: 'thread-1',
      runId: 'run-1',
      title: 'Approve workspace edit',
      description: 'A workspace edit requires approval.',
      requestedAt: '2026-04-11T00:00:00.000Z',
      expiresAt: null,
      toolName: 'mcp__sandbox__workspace_edit_file',
      argumentsSummary: [{ name: 'path', value: 'sample-file.txt' }],
      commandPreview: null,
      fileChangePreview: [{ path: 'sample-file.txt', action: 'edited', summary: 'Updated sample-file.txt' }],
      riskLabels: ['Workspace write'],
    });

    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListPendingActions).toHaveBeenCalledWith('thread-1', 'sample-user');
    expect(body.data.pendingActions).toEqual([
      {
        id: 'action-1',
        kind: 'tool_approval',
        status: 'pending',
        threadId: 'thread-1',
        runId: 'run-1',
        title: 'Approve workspace edit',
        description: 'A workspace edit requires approval.',
        requestedAt: '2026-04-11T00:00:00.000Z',
        expiresAt: null,
        toolName: 'mcp__sandbox__workspace_edit_file',
        argumentsSummary: [{ name: 'path', value: 'sample-file.txt' }],
        commandPreview: null,
        fileChangePreview: [{ path: 'sample-file.txt', action: 'edited', summary: 'Updated sample-file.txt' }],
        riskLabels: ['Workspace write'],
      },
    ]);
  });

  it('returns 404 when the thread is not owned by the requester', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockListPendingActions.mockRejectedValue(new Error('Agent thread not found'));

    const response = await GET(makeRequest(), { params: { threadId: 'missing-thread' } });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Agent thread not found' },
    });
    expect(mockListPendingActions).toHaveBeenCalledWith('missing-thread', 'sample-user');
  });
});
