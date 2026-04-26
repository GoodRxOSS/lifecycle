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

jest.mock('server/lib/agentSession/githubToken', () => ({
  resolveRequestGitHubToken: jest.fn(),
}));

jest.mock('server/services/agent/ApprovalService', () => ({
  __esModule: true,
  default: {
    normalizePendingActionResponseBody: jest.requireActual('server/services/agent/ApprovalService').default
      .normalizePendingActionResponseBody,
    resolvePendingAction: jest.fn(),
    serializePendingAction: jest.fn((action) => action),
  },
}));

import { POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubToken } from 'server/lib/agentSession/githubToken';
import ApprovalService from 'server/services/agent/ApprovalService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockResolveRequestGitHubToken = resolveRequestGitHubToken as jest.Mock;
const mockResolvePendingAction = ApprovalService.resolvePendingAction as jest.Mock;
const mockSerializePendingAction = ApprovalService.serializePendingAction as jest.Mock;

function makeRequest(body: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/pending-actions/action-1/respond'),
  } as unknown as NextRequest;
}

function makeInvalidJsonRequest(): NextRequest {
  return {
    json: jest.fn().mockRejectedValue(new Error('invalid json')),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/pending-actions/action-1/respond'),
  } as unknown as NextRequest;
}

describe('POST /api/v2/ai/agent/pending-actions/[actionId]/respond', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockResolveRequestGitHubToken.mockResolvedValue('sample-gh-token');
    mockResolvePendingAction.mockResolvedValue({
      id: 'action-1',
      status: 'denied',
    });
    mockSerializePendingAction.mockReturnValue({
      id: 'action-1',
      kind: 'tool_approval',
      status: 'denied',
      threadId: 'thread-1',
      runId: 'run-1',
      title: 'Approve workspace edit',
      description: 'A workspace edit requires approval.',
      requestedAt: '2026-04-11T00:00:00.000Z',
      expiresAt: null,
      toolName: 'mcp__sandbox__workspace_edit_file',
      argumentsSummary: [],
      commandPreview: null,
      fileChangePreview: [],
      riskLabels: ['Workspace write'],
    });
  });

  it('returns 401 when the requester is not authenticated', async () => {
    mockGetRequestUserIdentity.mockReturnValue(null);

    const response = await POST(makeRequest({ approved: true }), { params: { actionId: 'action-1' } });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Unauthorized' },
    });
    expect(mockResolvePendingAction).not.toHaveBeenCalled();
  });

  it('resolves the pending action through the canonical response API', async () => {
    const response = await POST(makeRequest({ approved: false, reason: 'not needed' }), {
      params: { actionId: 'action-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockResolvePendingAction).toHaveBeenCalledWith(
      'action-1',
      'sample-user',
      'denied',
      {
        approved: false,
        reason: 'not needed',
        source: 'endpoint',
      },
      { githubToken: 'sample-gh-token' }
    );
    expect(body.data).toEqual({
      id: 'action-1',
      kind: 'tool_approval',
      status: 'denied',
      threadId: 'thread-1',
      runId: 'run-1',
      title: 'Approve workspace edit',
      description: 'A workspace edit requires approval.',
      requestedAt: '2026-04-11T00:00:00.000Z',
      expiresAt: null,
      toolName: 'mcp__sandbox__workspace_edit_file',
      argumentsSummary: [],
      commandPreview: null,
      fileChangePreview: [],
      riskLabels: ['Workspace write'],
    });
  });

  it('rejects malformed response bodies without resolving the action', async () => {
    const cases = [
      { body: {}, message: 'approved must be a boolean' },
      { body: { approved: 'yes' }, message: 'approved must be a boolean' },
      { body: { approved: true, reason: 123 }, message: 'reason must be a string when provided' },
      {
        body: { approved: true, rawApproval: true },
        message: 'Unsupported pending action response fields: rawApproval',
      },
    ];

    for (const testCase of cases) {
      jest.clearAllMocks();
      mockGetRequestUserIdentity.mockReturnValue({
        userId: 'sample-user',
        githubUsername: 'sample-user',
      });

      const response = await POST(makeRequest(testCase.body), { params: { actionId: 'action-1' } });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: testCase.message },
      });
      expect(mockResolveRequestGitHubToken).not.toHaveBeenCalled();
      expect(mockResolvePendingAction).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid JSON instead of denying the action', async () => {
    const response = await POST(makeInvalidJsonRequest(), { params: { actionId: 'action-1' } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Request body must be a JSON object' },
    });
    expect(mockResolveRequestGitHubToken).not.toHaveBeenCalled();
    expect(mockResolvePendingAction).not.toHaveBeenCalled();
  });

  it('returns 404 when the pending action cannot be resolved for the requester', async () => {
    mockResolvePendingAction.mockRejectedValue(new Error('Pending action not found'));

    const response = await POST(makeRequest({ approved: true }), { params: { actionId: 'missing-action' } });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Pending action not found' },
    });
    expect(mockResolvePendingAction).toHaveBeenCalledWith(
      'missing-action',
      'sample-user',
      'approved',
      {
        approved: true,
        reason: null,
        source: 'endpoint',
      },
      { githubToken: 'sample-gh-token' }
    );
  });
});
