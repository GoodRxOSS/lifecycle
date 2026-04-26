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

const mockRemoveRepository = jest.fn();

jest.mock('server/services/repository', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    removeRepository: mockRemoveRepository,
  })),
}));

import { DELETE } from './route';

function makeRequest(url = 'http://localhost/api/v2/repositories/example-org/api') {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('DELETE /api/v2/repositories/{owner}/{repo}', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRemoveRepository.mockResolvedValue({
      id: 1,
      fullName: 'example-org/api',
      onboarded: false,
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('soft-removes the repository by owner/repo path', async () => {
    const response = await DELETE(makeRequest(), {
      params: {
        fullName: ['example-org', 'api'],
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRemoveRepository).toHaveBeenCalledWith('example-org/api', undefined);
    expect(body.data.repository).toEqual({
      id: 1,
      fullName: 'example-org/api',
      onboarded: false,
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('passes installationId through when provided', async () => {
    const response = await DELETE(
      makeRequest('http://localhost/api/v2/repositories/example-org/api?installationId=34'),
      {
        params: {
          fullName: ['example-org', 'api'],
        },
      }
    );

    expect(response.status).toBe(200);
    expect(mockRemoveRepository).toHaveBeenCalledWith('example-org/api', 34);
  });

  test('rejects incomplete repository paths', async () => {
    const response = await DELETE(makeRequest(), {
      params: {
        fullName: ['example-org'],
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Invalid repository fullName');
  });
});
