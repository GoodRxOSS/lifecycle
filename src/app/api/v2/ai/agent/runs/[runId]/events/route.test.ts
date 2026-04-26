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

jest.mock('server/services/agent/RunEventService', () => ({
  __esModule: true,
  DEFAULT_RUN_EVENT_PAGE_LIMIT: 100,
  MAX_RUN_EVENT_PAGE_LIMIT: 500,
  default: {
    listRunEventsPageForRun: jest.fn(),
    serializeRunEvent: jest.fn((event) => ({
      id: event.uuid,
      runId: event.runUuid,
      sequence: event.sequence,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt || null,
      updatedAt: event.updatedAt || null,
    })),
  },
}));

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    getOwnedRun: jest.fn(),
    isRunNotFoundError: jest.fn(),
  },
}));

import { GET } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentRunEventService from 'server/services/agent/RunEventService';
import AgentRunService from 'server/services/agent/RunService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockGetOwnedRun = AgentRunService.getOwnedRun as jest.Mock;
const mockIsRunNotFoundError = AgentRunService.isRunNotFoundError as jest.Mock;
const mockListRunEventsPageForRun = AgentRunEventService.listRunEventsPageForRun as jest.Mock;

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/runs/[runId]/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
  });

  it('returns a cursor page of owned run events', async () => {
    const run = {
      id: 17,
      uuid: 'run-1',
      status: 'running',
    };
    mockGetOwnedRun.mockResolvedValue(run);
    mockListRunEventsPageForRun.mockResolvedValue({
      events: [
        {
          uuid: 'event-1',
          runUuid: 'run-1',
          sequence: 6,
          eventType: 'message.delta',
          payload: { delta: 'Hello' },
        },
      ],
      nextSequence: 6,
      hasMore: false,
      run: {
        id: 'run-1',
        status: 'running',
      },
      limit: 2,
      maxLimit: 500,
    });

    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/runs/run-1/events?afterSequence=5&limit=2'),
      {
        params: { runId: 'run-1' },
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetOwnedRun).toHaveBeenCalledWith('run-1', 'sample-user');
    expect(mockListRunEventsPageForRun).toHaveBeenCalledWith(run, {
      afterSequence: 5,
      limit: 2,
    });
    expect(body.data).toEqual({
      run: {
        id: 'run-1',
        status: 'running',
      },
      events: [
        {
          id: 'event-1',
          runId: 'run-1',
          sequence: 6,
          eventType: 'message.delta',
          payload: { delta: 'Hello' },
          createdAt: null,
          updatedAt: null,
        },
      ],
      pagination: {
        nextSequence: 6,
        hasMore: false,
      },
    });
    expect(body.metadata).toEqual({
      limit: 2,
      maxLimit: 500,
    });
  });

  it('clamps oversized limits to the endpoint maximum', async () => {
    const run = {
      id: 17,
      uuid: 'run-1',
      status: 'completed',
    };
    mockGetOwnedRun.mockResolvedValue(run);
    mockListRunEventsPageForRun.mockResolvedValue({
      events: [],
      nextSequence: 0,
      hasMore: false,
      run: {
        id: 'run-1',
        status: 'completed',
      },
      limit: 500,
      maxLimit: 500,
    });

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/run-1/events?limit=999'), {
      params: { runId: 'run-1' },
    });

    expect(response.status).toBe(200);
    expect(mockListRunEventsPageForRun).toHaveBeenCalledWith(run, {
      afterSequence: 0,
      limit: 500,
    });
  });

  it('returns 400 for an invalid cursor', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/run-1/events?afterSequence=-1'), {
      params: { runId: 'run-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Expected a non-negative integer cursor.');
    expect(mockGetOwnedRun).not.toHaveBeenCalled();
  });

  it('returns 404 when the run is not owned by the user', async () => {
    const missingRunError = new Error('Agent run not found');
    mockGetOwnedRun.mockRejectedValue(missingRunError);
    mockIsRunNotFoundError.mockReturnValue(true);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/missing-run/events'), {
      params: { runId: 'missing-run' },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent run not found');
  });
});
