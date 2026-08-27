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

const mockRunWorkspaceBackendDeepCheck = jest.fn();

jest.mock('server/lib/createApiHandler', () => ({
  createApiHandler: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

jest.mock('server/services/workspaceRuntime/deepCheck', () => ({
  runWorkspaceBackendDeepCheck: (...args: unknown[]) => mockRunWorkspaceBackendDeepCheck(...args),
}));

import { POST } from './route';

function makeRequest(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest('http://localhost/api/v2/ai/workspace-runtime/backends/daytona/deep-check', {
      method: 'POST',
    }),
    { params: Promise.resolve({ id }) },
  ];
}

describe('POST /api/v2/ai/workspace-runtime/backends/{id}/deep-check route mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('trims the backend id and returns the deep-check report', async () => {
    const result = {
      ok: true,
      message: 'Booted a test sandbox in 1.2s.',
      durationMs: 1300,
      stages: [
        { name: 'Provision', status: 'passed' },
        { name: 'Teardown', status: 'passed' },
      ],
    };
    mockRunWorkspaceBackendDeepCheck.mockResolvedValue(result);

    const response = await POST(...makeRequest('  daytona  '));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(result);
    expect(mockRunWorkspaceBackendDeepCheck).toHaveBeenCalledWith('daytona');
  });

  it('propagates a deep-check service failure to the API wrapper', async () => {
    mockRunWorkspaceBackendDeepCheck.mockRejectedValue(new Error('deep check unavailable'));

    await expect(POST(...makeRequest('daytona'))).rejects.toThrow('deep check unavailable');
  });
});
