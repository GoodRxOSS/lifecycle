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

jest.mock('server/lib/get-user', () => {
  const getRequestUserIdentity = jest.fn();
  return {
    getRequestUserIdentity,
    // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
    requireRequestUserIdentity: (...args: unknown[]) => {
      const id = getRequestUserIdentity(...args);
      if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
      return id;
    },
  };
});

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  getToolApprovalAllowlist: jest.fn((thread) => thread?.metadata?.toolApprovalAllowlist ?? []),
  default: {
    getOwnedThreadWithSession: jest.fn(),
    setToolApprovalAllowlist: jest.fn(),
  },
}));

import { PUT } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentThreadService from 'server/services/agent/ThreadService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockSetToolApprovalAllowlist = AgentThreadService.setToolApprovalAllowlist as jest.Mock;

function makePutRequest(body: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/tool-approval-allowlist'),
  } as unknown as NextRequest;
}

describe('PUT /api/v2/ai/agent/threads/[threadId]/tool-approval-allowlist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({ roles: ['user'], userId: 'sample-user' });
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: { id: 7, metadata: { toolApprovalAllowlist: [] } },
      session: { id: 17 },
    });
    mockSetToolApprovalAllowlist.mockResolvedValue({ metadata: { toolApprovalAllowlist: ['read_tool'] } });
  });

  it('rejects git_write tool keys instead of storing a silently inert allowlist entry', async () => {
    const response = await PUT(makePutRequest({ toolKeys: ['mcp__lifecycle__update_file'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('mcp__lifecycle__update_file');
    expect(mockSetToolApprovalAllowlist).not.toHaveBeenCalled();
  });

  it('accepts always-allow-eligible tool keys', async () => {
    const response = await PUT(makePutRequest({ toolKeys: ['read_tool'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockSetToolApprovalAllowlist).toHaveBeenCalledWith(7, ['read_tool']);
  });
});
