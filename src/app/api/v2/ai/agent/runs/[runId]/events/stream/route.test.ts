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
  default: {
    createCanonicalRunEventStream: jest.fn(),
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
const mockCreateCanonicalRunEventStream = AgentRunEventService.createCanonicalRunEventStream as jest.Mock;
const mockGetOwnedRun = AgentRunService.getOwnedRun as jest.Mock;
const mockIsRunNotFoundError = AgentRunService.isRunNotFoundError as jest.Mock;

function makeRequest(url: string, headers: [string, string][] = []): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test'], ...headers]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

function makeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('GET /api/v2/ai/agent/runs/[runId]/events/stream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
    mockGetOwnedRun.mockResolvedValue({
      uuid: 'run-1',
      status: 'running',
    });
    mockCreateCanonicalRunEventStream.mockReturnValue(makeStream('id: 6\n\n'));
  });

  it('returns the canonical run event SSE stream', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/runs/run-1/events/stream?afterSequence=5'),
      {
        params: { runId: 'run-1' },
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(await response.text()).toBe('id: 6\n\n');
    expect(mockGetOwnedRun).toHaveBeenCalledWith('run-1', 'sample-user');
    expect(mockCreateCanonicalRunEventStream).toHaveBeenCalledWith('run-1', 5);
  });

  it('uses Last-Event-ID as the replay cursor when present', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/runs/run-1/events/stream?afterSequence=2', [
        ['last-event-id', '8'],
      ]),
      {
        params: { runId: 'run-1' },
      }
    );

    expect(response.status).toBe(200);
    expect(mockCreateCanonicalRunEventStream).toHaveBeenCalledWith('run-1', 8);
  });

  it('returns 400 for an invalid cursor', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/runs/run-1/events/stream?afterSequence=-1'),
      {
        params: { runId: 'run-1' },
      }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Expected a non-negative integer cursor.');
    expect(mockGetOwnedRun).not.toHaveBeenCalled();
  });

  it('returns 404 when the run is not owned by the user', async () => {
    const missingRunError = new Error('Agent run not found');
    mockGetOwnedRun.mockRejectedValue(missingRunError);
    mockIsRunNotFoundError.mockReturnValue(true);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/missing-run/events/stream'), {
      params: { runId: 'missing-run' },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent run not found');
  });

  it('returns 401 when the request has no user identity', async () => {
    mockGetRequestUserIdentity.mockReturnValue(null);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/runs/run-1/events/stream'), {
      params: { runId: 'run-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Unauthorized');
    expect(mockGetOwnedRun).not.toHaveBeenCalled();
  });
});
