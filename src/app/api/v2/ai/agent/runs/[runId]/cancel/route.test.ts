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

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    cancelRun: jest.fn(),
    isRunNotFoundError: jest.fn(),
    serializeRun: jest.fn((run) => ({
      id: run.uuid,
      status: run.status,
    })),
  },
}));

import { POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentRunService from 'server/services/agent/RunService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockCancelRun = AgentRunService.cancelRun as jest.Mock;
const mockIsRunNotFoundError = AgentRunService.isRunNotFoundError as jest.Mock;

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/runs/run-1/cancel'),
  } as unknown as NextRequest;
}

describe('POST /api/v2/ai/agent/runs/[runId]/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
    mockIsRunNotFoundError.mockReturnValue(false);
  });

  it('cancels the owned run through the control-plane service path', async () => {
    mockCancelRun.mockResolvedValue({
      uuid: 'run-1',
      status: 'cancelled',
    });

    const response = await POST(makeRequest(), {
      params: { runId: 'run-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCancelRun).toHaveBeenCalledWith('run-1', 'sample-user');
    expect(body.data).toEqual({
      id: 'run-1',
      status: 'cancelled',
    });
  });

  it('maps missing runs to 404', async () => {
    const error = new Error('Agent run not found');
    mockCancelRun.mockRejectedValueOnce(error);
    mockIsRunNotFoundError.mockReturnValueOnce(true);

    const response = await POST(makeRequest(), {
      params: { runId: 'missing-run' },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent run not found');
  });

  it('rejects unauthenticated requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(makeRequest(), {
      params: { runId: 'run-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Unauthorized');
    expect(mockCancelRun).not.toHaveBeenCalled();
  });
});
