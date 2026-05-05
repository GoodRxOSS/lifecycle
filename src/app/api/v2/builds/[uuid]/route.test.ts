/**
 * Copyright 2026 Lifecycle contributors
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

const mockGetBuildByUUID = jest.fn();
const mockQueueAdd = jest.fn();
const mockFindOne = jest.fn();
const mockWithGraphFetched = jest.fn();
const mockValidateUuid = jest.fn();
const mockUpdateBuildUuid = jest.fn();

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'run-uuid'),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
  })),
  LogStage: {
    BUILD_QUEUED: 'build_queued',
  },
}));

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getBuildByUUID: (...args: unknown[]) => mockGetBuildByUUID(...args),
    resolveAndDeployBuildQueue: {
      add: (...args: unknown[]) => mockQueueAdd(...args),
    },
  })),
}));

jest.mock('server/services/override', () => {
  class BuildUuidValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BuildUuidValidationError';
    }
  }

  return {
    __esModule: true,
    BuildUuidValidationError,
    default: jest.fn().mockImplementation(() => ({
      db: {
        models: {
          Build: {
            query: jest.fn(() => ({
              findOne: (...args: unknown[]) => mockFindOne(...args),
            })),
          },
        },
      },
      validateUuid: (...args: unknown[]) => mockValidateUuid(...args),
      updateBuildUuid: (...args: unknown[]) => mockUpdateBuildUuid(...args),
    })),
  };
});

import { GET, PATCH } from './route';

function makeRequest(body?: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body || {}),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/builds/current-build'),
  } as unknown as NextRequest;
}

describe('/api/v2/builds/[uuid]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockReturnValue({
      withGraphFetched: mockWithGraphFetched,
    });
    mockValidateUuid.mockResolvedValue({ valid: true });
    mockUpdateBuildUuid.mockResolvedValue({
      build: {
        id: 42,
        uuid: 'new-build',
      },
      deploysUpdated: 3,
    });
  });

  it('GET returns a build by UUID', async () => {
    mockGetBuildByUUID.mockResolvedValueOnce({
      id: 42,
      uuid: 'current-build',
    });

    const response = await GET(makeRequest(), {
      params: {
        uuid: 'current-build',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetBuildByUUID).toHaveBeenCalledWith('current-build');
    expect(body.data).toEqual({
      id: 42,
      uuid: 'current-build',
    });
  });

  it('PATCH validates and updates the build UUID', async () => {
    const build = {
      id: 42,
      uuid: 'current-build',
      pullRequest: {
        deployOnUpdate: true,
      },
    };
    mockWithGraphFetched.mockResolvedValueOnce(build);

    const response = await PATCH(makeRequest({ uuid: 'new-build' }), {
      params: {
        uuid: 'current-build',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledWith({ uuid: 'current-build' });
    expect(mockWithGraphFetched).toHaveBeenCalledWith('pullRequest');
    expect(mockValidateUuid).toHaveBeenCalledWith('new-build', 42);
    expect(mockUpdateBuildUuid).toHaveBeenCalledWith(build, 'new-build');
    expect(mockQueueAdd).toHaveBeenCalledWith('resolve-deploy', {
      buildId: 42,
      runUUID: 'run-uuid',
      correlationId: 'req-test',
    });
    expect(body.data).toEqual({
      id: 42,
      uuid: 'new-build',
    });
  });

  it('PATCH rejects unavailable UUIDs before updating', async () => {
    mockWithGraphFetched.mockResolvedValueOnce({
      id: 42,
      uuid: 'current-build',
    });
    mockValidateUuid.mockResolvedValueOnce({
      valid: false,
      error: 'UUID is not available',
    });

    const response = await PATCH(makeRequest({ uuid: 'existing-build' }), {
      params: {
        uuid: 'current-build',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('UUID is not available');
    expect(mockUpdateBuildUuid).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('PATCH returns 404 when the build does not exist', async () => {
    mockWithGraphFetched.mockResolvedValueOnce(null);

    const response = await PATCH(makeRequest({ uuid: 'new-build' }), {
      params: {
        uuid: 'missing-build',
      },
    });

    expect(response.status).toBe(404);
    expect(mockValidateUuid).not.toHaveBeenCalled();
    expect(mockUpdateBuildUuid).not.toHaveBeenCalled();
  });

  it('PATCH rejects missing UUID bodies and no-op UUID changes', async () => {
    const missingUuidResponse = await PATCH(makeRequest({}), {
      params: {
        uuid: 'current-build',
      },
    });
    expect(missingUuidResponse.status).toBe(400);

    mockWithGraphFetched.mockResolvedValueOnce({
      id: 42,
      uuid: 'current-build',
    });

    const sameUuidResponse = await PATCH(makeRequest({ uuid: 'current-build' }), {
      params: {
        uuid: 'current-build',
      },
    });

    expect(sameUuidResponse.status).toBe(400);
    expect(mockValidateUuid).not.toHaveBeenCalled();
    expect(mockUpdateBuildUuid).not.toHaveBeenCalled();
  });
});
