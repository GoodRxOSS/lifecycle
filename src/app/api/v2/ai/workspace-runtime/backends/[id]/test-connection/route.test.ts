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

const mockGetUser = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockTestE2bConnection = jest.fn();
const mockTestDaytonaConnection = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) })),
  },
}));

jest.mock('server/services/workspaceRuntime/providers/e2b', () => ({
  ...jest.requireActual('server/services/workspaceRuntime/providers/e2b'),
  testE2bConnection: (...args: unknown[]) => mockTestE2bConnection(...args),
}));

jest.mock('server/services/workspaceRuntime/providers/daytona', () => ({
  ...jest.requireActual('server/services/workspaceRuntime/providers/daytona'),
  testDaytonaConnection: (...args: unknown[]) => mockTestDaytonaConnection(...args),
}));

import { POST } from './route';
import { encryptConfigSecret } from 'server/lib/encryption';

function makeRequest(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(`http://localhost/api/v2/ai/workspace-runtime/backends/${id}/test-connection`),
  } as unknown as NextRequest;
  return [req, { params: Promise.resolve({ id }) }];
}

describe('POST /api/v2/ai/workspace-runtime/backends/{id}/test-connection', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a01b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b';
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockGetAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'workspace-image:v1',
        workspaceBackend: {
          provider: 'e2b',
          e2b: { apiKey: encryptConfigSecret('e2b-plain-key'), templateId: 'lifecycle-workspace' },
        },
      },
    });
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 401 when unauthenticated and 403 for non-admin users', async () => {
    mockGetUser.mockReturnValue(null);
    expect((await POST(...makeRequest('e2b'))).status).toBe(401);

    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });
    expect((await POST(...makeRequest('e2b'))).status).toBe(403);

    expect(mockTestE2bConnection).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown backend', async () => {
    const response = await POST(...makeRequest('nope'));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Unknown workspace backend: nope');
  });

  it('returns 400 for coming_soon and unsupported backends', async () => {
    const comingSoon = await POST(...makeRequest('substrate'));
    expect(comingSoon.status).toBe(400);
    expect((await comingSoon.json()).error.message).toContain('not available yet');

    const unsupported = await POST(...makeRequest('lifecycle_kubernetes'));
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error.message).toContain('does not support connection tests');
  });

  it('runs the probe against the merged stored+env config with secrets decrypted per call', async () => {
    mockTestE2bConnection.mockResolvedValue({
      ok: true,
      message: 'E2B connection verified.',
      details: { templateId: 'lifecycle-workspace' },
    });

    const response = await POST(...makeRequest('e2b'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      ok: true,
      message: 'E2B connection verified.',
      details: { templateId: 'lifecycle-workspace' },
    });
    // Decrypted for the probe only; ciphertext never reaches the provider.
    expect(mockTestE2bConnection.mock.calls[0][0].e2b.apiKey).toBe('e2b-plain-key');
  });

  it('refuses link-local/metadata probe targets before fetching', async () => {
    mockGetAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceBackend: {
          daytona: { apiKey: 'daytona-key', snapshot: 'snap', apiUrl: 'http://169.254.169.254/api' },
        },
      },
    });

    const response = await POST(...makeRequest('daytona'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('link-local/metadata');
    expect(mockTestDaytonaConnection).not.toHaveBeenCalled();
  });

  it('scrubs secrets from unexpected provider errors', async () => {
    mockTestE2bConnection.mockRejectedValue(new Error('fetch failed for key e2b-plain-key at api.e2b.app'));

    const response = await POST(...makeRequest('e2b'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toContain('[redacted]');
    expect(JSON.stringify(body)).not.toContain('e2b-plain-key');
  });

  it('reports a clear decryption failure without probing upstream', async () => {
    const ciphertext = encryptConfigSecret('e2b-plain-key');
    process.env.ENCRYPTION_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    mockGetAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceBackend: { e2b: { apiKey: ciphertext, templateId: 'lifecycle-workspace' } },
      },
    });

    const response = await POST(...makeRequest('e2b'));
    const body = await response.json();
    process.env.ENCRYPTION_KEY = 'a01b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b';

    expect(response.status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toContain('verify ENCRYPTION_KEY');
    expect(mockTestE2bConnection).not.toHaveBeenCalled();
  });
});
