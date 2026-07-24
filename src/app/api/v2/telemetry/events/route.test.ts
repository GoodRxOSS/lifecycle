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

const mockInsertEvent = jest.fn();

jest.mock('server/services/telemetry', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    insertEvent: (...args: unknown[]) => mockInsertEvent(...args),
  })),
}));

import { POST } from './route';

function makeRequest(body?: unknown, options: { invalidJson?: boolean } = {}): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/telemetry/events'),
    json: options.invalidJson
      ? jest.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
      : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const validPayload = {
  source: 'cli',
  clientId: '4c2c83f1-2a1f-4a3e-9b5d-1a2b3c4d5e6f',
  event: 'builds list',
  attributes: { flags: ['--json', '--verbose'] },
  durationMs: 1200,
  status: 'success',
  exitCode: 0,
  clientVersion: '1.2.3',
  runtimeVersion: 'v20.11.0',
  platform: 'darwin',
  arch: 'arm64',
};

describe('POST /api/v2/telemetry/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsertEvent.mockResolvedValue({ id: 42, createdAt: '2026-07-01T00:00:00.000Z' });
  });

  it('inserts a valid event and returns 201', async () => {
    const response = await POST(makeRequest(validPayload));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.event).toEqual({ id: 42, createdAt: '2026-07-01T00:00:00.000Z' });
    expect(body.error).toBeNull();
    expect(mockInsertEvent).toHaveBeenCalledWith({
      source: 'cli',
      clientId: '4c2c83f1-2a1f-4a3e-9b5d-1a2b3c4d5e6f',
      event: 'builds list',
      attributes: { flags: ['--json', '--verbose'] },
      durationMs: 1200,
      status: 'success',
      exitCode: 0,
      errorClass: null,
      errorHttpStatus: null,
      errorCode: null,
      clientVersion: '1.2.3',
      runtimeVersion: 'v20.11.0',
      platform: 'darwin',
      arch: 'arm64',
    });
  });

  it('accepts ui events with only required fields and defaults optionals', async () => {
    const response = await POST(
      makeRequest({
        source: 'ui',
        clientId: validPayload.clientId,
        event: 'builds page viewed',
        status: 'success',
        clientVersion: '2.0.0',
      })
    );

    expect(response.status).toBe(201);
    expect(mockInsertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ui',
        attributes: {},
        durationMs: null,
        exitCode: null,
        runtimeVersion: null,
        platform: null,
        arch: null,
      })
    );
  });

  it('accepts error events with error details', async () => {
    const response = await POST(
      makeRequest({
        source: 'cli',
        clientId: validPayload.clientId,
        event: 'builds get',
        durationMs: 300,
        status: 'error',
        exitCode: 1,
        errorClass: 'HttpError',
        errorHttpStatus: 404,
        errorCode: 'NOT_FOUND',
        clientVersion: '1.2.3',
      })
    );

    expect(response.status).toBe(201);
    expect(mockInsertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        exitCode: 1,
        errorClass: 'HttpError',
        errorHttpStatus: 404,
        errorCode: 'NOT_FOUND',
      })
    );
  });

  it('never forwards unknown fields such as user identity', async () => {
    const response = await POST(
      makeRequest({
        ...validPayload,
        userEmail: 'someone@example.com',
        token: 'secret',
      })
    );

    expect(response.status).toBe(201);
    const inserted = mockInsertEvent.mock.calls[0][0];
    expect(inserted).not.toHaveProperty('userEmail');
    expect(inserted).not.toHaveProperty('token');
  });

  it('rejects invalid JSON bodies', async () => {
    const response = await POST(makeRequest(undefined, { invalidJson: true }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Invalid JSON');
    expect(mockInsertEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['missing source', { ...validPayload, source: undefined }],
    ['invalid source', { ...validPayload, source: 'mobile' }],
    ['missing clientId', { ...validPayload, clientId: undefined }],
    ['non-uuid clientId', { ...validPayload, clientId: 'not-a-uuid' }],
    ['empty event', { ...validPayload, event: '' }],
    ['event too long', { ...validPayload, event: 'a'.repeat(201) }],
    ['array attributes', { ...validPayload, attributes: ['--json'] }],
    ['string attributes', { ...validPayload, attributes: 'flags' }],
    ['object attribute value', { ...validPayload, attributes: { nested: { deep: true } } }],
    ['non-string array attribute value', { ...validPayload, attributes: { flags: [1, 2] } }],
    [
      'oversized attributes',
      {
        ...validPayload,
        attributes: {
          blob: 'x'.repeat(500),
          blob2: 'y'.repeat(500),
          blob3: 'z'.repeat(500),
          blob4: 'w'.repeat(500),
          blob5: 'v'.repeat(500),
        },
      },
    ],
    ['non-integer durationMs', { ...validPayload, durationMs: 12.5 }],
    ['negative durationMs', { ...validPayload, durationMs: -1 }],
    ['missing status', { ...validPayload, status: undefined }],
    ['invalid status', { ...validPayload, status: 'failed' }],
    ['non-integer exitCode', { ...validPayload, exitCode: 1.5 }],
    ['non-integer errorHttpStatus', { ...validPayload, errorHttpStatus: 'oops' }],
    ['missing clientVersion', { ...validPayload, clientVersion: undefined }],
    ['array body', [validPayload]],
    ['string body', 'hello'],
  ])('rejects %s with 400', async (_name, payload) => {
    const response = await POST(makeRequest(payload));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed');
    expect(mockInsertEvent).not.toHaveBeenCalled();
  });
});
