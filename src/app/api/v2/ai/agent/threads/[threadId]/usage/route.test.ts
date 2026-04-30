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

jest.mock('server/services/agent/AgentUsageService', () => ({
  __esModule: true,
  default: {
    getOwnedThreadUsage: jest.fn(),
  },
}));

import { GET } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentUsageService from 'server/services/agent/AgentUsageService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockGetOwnedThreadUsage = AgentUsageService.getOwnedThreadUsage as jest.Mock;

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/usage'),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/threads/[threadId]/usage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetOwnedThreadUsage.mockResolvedValue({
      threadId: 'thread-1',
      sessionId: 'session-1',
      usageSummary: {
        totalTokens: 42,
        inputTokens: 30,
        outputTokens: 12,
      },
      usageByModel: [
        {
          provider: 'openai',
          model: 'gpt-5.4',
          totalTokens: 42,
          inputTokens: 30,
          outputTokens: 12,
          runCount: 1,
          reportedRunCount: 1,
          missingUsageRunCount: 0,
        },
      ],
      usageCompleteness: {
        runCount: 1,
        reportedRunCount: 1,
        missingUsageRunCount: 0,
        complete: true,
      },
    });
  });

  it('returns thread usage for the authenticated owner', async () => {
    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetOwnedThreadUsage).toHaveBeenCalledWith('thread-1', 'sample-user');
    expect(body.data).toEqual(
      expect.objectContaining({
        threadId: 'thread-1',
        sessionId: 'session-1',
        usageSummary: {
          totalTokens: 42,
          inputTokens: 30,
          outputTokens: 12,
        },
      })
    );
  });

  it('returns 401 without a request identity', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });

    expect(response.status).toBe(401);
    expect(mockGetOwnedThreadUsage).not.toHaveBeenCalled();
  });

  it('maps missing thread or session ownership to 404', async () => {
    mockGetOwnedThreadUsage.mockRejectedValueOnce(new Error('Agent thread not found'));

    const response = await GET(makeRequest(), { params: { threadId: 'missing-thread' } });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent thread not found');
  });
});
