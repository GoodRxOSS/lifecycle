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
const mockListByScope = jest.fn();
const mockCreate = jest.fn();
const mockGetBySlugAndScope = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockRedactMcpConfigSecrets = jest.fn((config: Record<string, unknown>) => ({
  ...config,
  secret: '[REDACTED]',
}));

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    return user ? { userId: user.sub, githubUsername: null, roles: user.realm_access?.roles ?? [] } : null;
  },
  requireRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    if (!user) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return { userId: user.sub, githubUsername: null, roles: user.realm_access?.roles ?? [] };
  },
}));

jest.mock('server/services/agentRuntime/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    listByScope: (...args: unknown[]) => mockListByScope(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    getBySlugAndScope: (...args: unknown[]) => mockGetBySlugAndScope(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  })),
  redactMcpConfigSecrets: (...args: [Record<string, unknown>]) => mockRedactMcpConfigSecrets(...args),
}));

jest.mock('server/lib/dependencies', () => ({}));

import { GET as listConfigs, POST as createConfig } from './route';
import { GET as getConfig, PUT as updateConfig, DELETE as deleteConfig } from './[slug]/route';

const originalEnableAuth = process.env.ENABLE_AUTH;
const detailParams = { params: Promise.resolve({ slug: 'sample' }) };

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      'x-request-id': 'req-test',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function configRecord(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'sample',
    name: 'Sample',
    scope: 'global',
    secret: 'shared-secret',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
  mockListByScope.mockResolvedValue([]);
  mockCreate.mockResolvedValue(configRecord());
  mockGetBySlugAndScope.mockResolvedValue(configRecord());
  mockUpdate.mockResolvedValue(configRecord({ name: 'Updated' }));
  mockDelete.mockResolvedValue(undefined);
});

afterAll(() => {
  if (originalEnableAuth === undefined) {
    delete process.env.ENABLE_AUTH;
  } else {
    process.env.ENABLE_AUTH = originalEnableAuth;
  }
});

describe('MCP config collection routes', () => {
  it('lists and redacts both model instances and plain service values in the requested scope', async () => {
    const modelJson = configRecord({ slug: 'model-config' });
    const model = { toJSON: jest.fn(() => modelJson) };
    const plain = configRecord({ slug: 'plain-config' });
    mockListByScope.mockResolvedValueOnce([model, plain]);

    const response = await listConfigs(request('/api/v2/ai/config/mcp-servers?scope=goodrx/sample', 'GET'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListByScope).toHaveBeenCalledWith('goodrx/sample');
    expect(model.toJSON).toHaveBeenCalledTimes(1);
    expect(mockRedactMcpConfigSecrets).toHaveBeenNthCalledWith(1, modelJson);
    expect(mockRedactMcpConfigSecrets).toHaveBeenNthCalledWith(2, plain);
    expect(body.data).toEqual([
      expect.objectContaining({ slug: 'model-config', secret: '[REDACTED]' }),
      expect.objectContaining({ slug: 'plain-config', secret: '[REDACTED]' }),
    ]);
  });

  it('defaults an omitted list scope to global', async () => {
    const response = await listConfigs(request('/api/v2/ai/config/mcp-servers', 'GET'));

    expect(response.status).toBe(200);
    expect(mockListByScope).toHaveBeenCalledWith('global');
  });

  it('requires a session to list configs', async () => {
    mockGetUser.mockReturnValueOnce(null);

    const response = await listConfigs(request('/api/v2/ai/config/mcp-servers', 'GET'));

    expect(response.status).toBe(401);
    expect(mockListByScope).not.toHaveBeenCalled();
  });

  it('returns 500 when listing fails', async () => {
    mockListByScope.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await listConfigs(request('/api/v2/ai/config/mcp-servers', 'GET'));

    expect(response.status).toBe(500);
  });

  it.each([
    { label: 'slug', body: { name: 'Sample', transport: {} } },
    { label: 'name', body: { slug: 'sample', transport: {} } },
    { label: 'transport', body: { slug: 'sample', name: 'Sample' } },
  ])('rejects create when $label is missing', async ({ body }) => {
    const response = await createConfig(request('/api/v2/ai/config/mcp-servers', 'POST', body));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('Missing required fields: slug, name, transport');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates in the default scope, forwards optional fields, and redacts a model result', async () => {
    const modelJson = configRecord({ enabled: false });
    const model = { toJSON: jest.fn(() => modelJson) };
    mockCreate.mockResolvedValueOnce(model);
    const transport = { type: 'http', url: 'https://mcp.example.test' };

    const response = await createConfig(
      request('/api/v2/ai/config/mcp-servers', 'POST', {
        slug: 'sample',
        name: 'Sample',
        description: 'Sample MCP',
        transport,
        preset: 'sample-preset',
        sharedConfig: { headers: { authorization: 'secret' } },
        authConfig: { mode: 'none' },
        enabled: false,
        timeout: 5000,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      slug: 'sample',
      name: 'Sample',
      scope: 'global',
      description: 'Sample MCP',
      transport,
      preset: 'sample-preset',
      sharedConfig: { headers: { authorization: 'secret' } },
      authConfig: { mode: 'none' },
      enabled: false,
      timeout: 5000,
    });
    expect(model.toJSON).toHaveBeenCalledTimes(1);
    expect(body.data).toEqual(expect.objectContaining({ slug: 'sample', secret: '[REDACTED]' }));
  });

  it('uses an explicit create scope and redacts a plain result', async () => {
    const response = await createConfig(
      request('/api/v2/ai/config/mcp-servers', 'POST', {
        slug: 'sample',
        name: 'Sample',
        scope: 'goodrx/sample',
        transport: { type: 'sse', url: 'https://mcp.example.test/events' },
      })
    );

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ scope: 'goodrx/sample' }));
    expect(mockRedactMcpConfigSecrets).toHaveBeenCalledWith(expect.objectContaining({ slug: 'sample' }));
  });

  it.each([
    { label: 'duplicate Error', error: new Error('MCP sample already exists'), status: 409 },
    { label: 'duplicate non-Error', error: 'MCP sample already exists', status: 409 },
    { label: 'connectivity failure', error: new Error('connectivity validation failed: offline'), status: 422 },
    { label: 'invalid slug', error: new Error('Invalid slug: Sample!'), status: 422 },
  ])('maps a create $label to its public status', async ({ error, status }) => {
    mockCreate.mockRejectedValueOnce(error);

    const response = await createConfig(
      request('/api/v2/ai/config/mcp-servers', 'POST', {
        slug: 'sample',
        name: 'Sample',
        transport: {},
      })
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error.message).toBe(String(error instanceof Error ? error.message : error));
  });

  it('returns 500 for an unexpected create failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await createConfig(
      request('/api/v2/ai/config/mcp-servers', 'POST', {
        slug: 'sample',
        name: 'Sample',
        transport: {},
      })
    );

    expect(response.status).toBe(500);
  });
});

describe('MCP config detail routes', () => {
  it('gets a model config in the requested scope and returns a redacted value', async () => {
    const modelJson = configRecord();
    const model = { toJSON: jest.fn(() => modelJson) };
    mockGetBySlugAndScope.mockResolvedValueOnce(model);

    const response = await getConfig(
      request('/api/v2/ai/config/mcp-servers/sample?scope=goodrx/sample', 'GET'),
      detailParams
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetBySlugAndScope).toHaveBeenCalledWith('sample', 'goodrx/sample');
    expect(model.toJSON).toHaveBeenCalledTimes(1);
    expect(body.data).toEqual(expect.objectContaining({ slug: 'sample', secret: '[REDACTED]' }));
  });

  it('gets a plain config in the default scope', async () => {
    const response = await getConfig(request('/api/v2/ai/config/mcp-servers/sample', 'GET'), detailParams);

    expect(response.status).toBe(200);
    expect(mockGetBySlugAndScope).toHaveBeenCalledWith('sample', 'global');
    expect(mockRedactMcpConfigSecrets).toHaveBeenCalledWith(expect.objectContaining({ slug: 'sample' }));
  });

  it('returns 404 when a config is missing', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce(null);

    const response = await getConfig(request('/api/v2/ai/config/mcp-servers/missing', 'GET'), {
      params: Promise.resolve({ slug: 'missing' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe("MCP server config 'missing' not found");
    expect(mockRedactMcpConfigSecrets).not.toHaveBeenCalled();
  });

  it('requires a session before getting a config', async () => {
    mockGetUser.mockReturnValueOnce(null);

    const response = await getConfig(request('/api/v2/ai/config/mcp-servers/sample', 'GET'), detailParams);

    expect(response.status).toBe(401);
    expect(mockGetBySlugAndScope).not.toHaveBeenCalled();
  });

  it('returns 500 when config lookup fails', async () => {
    mockGetBySlugAndScope.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await getConfig(request('/api/v2/ai/config/mcp-servers/sample', 'GET'), detailParams);

    expect(response.status).toBe(500);
  });

  it('updates a config in an explicit scope and redacts a model result', async () => {
    const modelJson = configRecord({ name: 'Updated' });
    const model = { toJSON: jest.fn(() => modelJson) };
    mockUpdate.mockResolvedValueOnce(model);
    const patch = { name: 'Updated', enabled: false };

    const response = await updateConfig(
      request('/api/v2/ai/config/mcp-servers/sample?scope=goodrx/sample', 'PUT', patch),
      detailParams
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('sample', 'goodrx/sample', patch);
    expect(model.toJSON).toHaveBeenCalledTimes(1);
    expect(body.data).toEqual(expect.objectContaining({ name: 'Updated', secret: '[REDACTED]' }));
  });

  it('updates in the default scope and redacts a plain result', async () => {
    const response = await updateConfig(
      request('/api/v2/ai/config/mcp-servers/sample', 'PUT', { name: 'Updated' }),
      detailParams
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('sample', 'global', { name: 'Updated' });
    expect(mockRedactMcpConfigSecrets).toHaveBeenCalledWith(expect.objectContaining({ name: 'Updated' }));
  });

  it.each([
    { label: 'Error not-found', error: new Error('MCP sample not found'), status: 404 },
    { label: 'non-Error not-found', error: 'MCP sample not found', status: 404 },
    { label: 'connectivity failure', error: new Error('connectivity validation failed: offline'), status: 422 },
  ])('maps update $label to its public status', async ({ error, status }) => {
    mockUpdate.mockRejectedValueOnce(error);

    const response = await updateConfig(
      request('/api/v2/ai/config/mcp-servers/sample', 'PUT', { name: 'Updated' }),
      detailParams
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error.message).toBe(error instanceof Error ? error.message : error);
  });

  it('returns 500 for an unexpected update failure', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await updateConfig(
      request('/api/v2/ai/config/mcp-servers/sample', 'PUT', { name: 'Updated' }),
      detailParams
    );

    expect(response.status).toBe(500);
  });

  it('deletes a config in an explicit scope with no response body', async () => {
    const response = await deleteConfig(
      request('/api/v2/ai/config/mcp-servers/sample?scope=goodrx/sample', 'DELETE'),
      detailParams
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockDelete).toHaveBeenCalledWith('sample', 'goodrx/sample');
  });

  it('deletes in the default scope', async () => {
    const response = await deleteConfig(request('/api/v2/ai/config/mcp-servers/sample', 'DELETE'), detailParams);

    expect(response.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith('sample', 'global');
  });

  it.each([
    { label: 'Error', error: new Error('MCP sample not found') },
    { label: 'non-Error', error: 'MCP sample not found' },
  ])('returns 404 when delete rejects with a not-found $label', async ({ error }) => {
    mockDelete.mockRejectedValueOnce(error);

    const response = await deleteConfig(request('/api/v2/ai/config/mcp-servers/sample', 'DELETE'), detailParams);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe(error instanceof Error ? error.message : error);
  });

  it('returns 500 for an unexpected delete failure', async () => {
    mockDelete.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await deleteConfig(request('/api/v2/ai/config/mcp-servers/sample', 'DELETE'), detailParams);

    expect(response.status).toBe(500);
  });
});
