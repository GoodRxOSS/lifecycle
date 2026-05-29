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
const mockCreate = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/agentRuntime/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    listByScope: jest.fn().mockResolvedValue([]),
    create: (...args: unknown[]) => mockCreate(...args),
  })),
  redactMcpConfigSecrets: (config: unknown) => config,
}));

jest.mock('server/lib/dependencies', () => ({}));

import { POST } from './route';

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/config/mcp-servers'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('POST /api/v2/ai/config/mcp-servers (admin-gated org-wide write)', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockCreate.mockResolvedValue({ slug: 'sample', name: 'Sample', scope: 'global' });
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 403 for a non-admin user and does not create', async () => {
    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });

    const response = await POST(makeRequest({ slug: 'sample', name: 'Sample', transport: {} }));

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates the global MCP config for an admin', async () => {
    const response = await POST(makeRequest({ slug: 'sample', name: 'Sample', transport: {} }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalled();
  });
});
