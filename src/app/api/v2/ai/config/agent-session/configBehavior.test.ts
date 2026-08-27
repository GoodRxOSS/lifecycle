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
const mockGetGlobalConfig = jest.fn();
const mockSetGlobalConfig = jest.fn();
const mockGetRepoConfig = jest.fn();
const mockSetRepoConfig = jest.fn();
const mockDeleteRepoConfig = jest.fn();

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

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getGlobalConfig: (...args: unknown[]) => mockGetGlobalConfig(...args),
      setGlobalConfig: (...args: unknown[]) => mockSetGlobalConfig(...args),
      getRepoConfig: (...args: unknown[]) => mockGetRepoConfig(...args),
      setRepoConfig: (...args: unknown[]) => mockSetRepoConfig(...args),
      deleteRepoConfig: (...args: unknown[]) => mockDeleteRepoConfig(...args),
    })),
  },
}));

import { GET as getGlobalConfig, PUT as putGlobalConfig } from './route';
import { GET as getRepoConfig, PUT as putRepoConfig, DELETE as deleteRepoConfig } from './repos/[...fullName]/route';
import { AgentSessionConfigValidationError } from 'server/lib/validation/agentSessionConfigValidator';

const originalEnableAuth = process.env.ENABLE_AUTH;
const repoParams = { params: Promise.resolve({ fullName: ['Example-Org', 'Example-Repo.git'] }) };

function request(path: string, method: string, body?: unknown, jsonError?: unknown): NextRequest {
  if (jsonError !== undefined) {
    return {
      headers: new Headers([['x-request-id', 'req-test']]),
      nextUrl: new URL(`http://localhost${path}`),
      json: jest.fn().mockRejectedValue(jsonError),
    } as unknown as NextRequest;
  }

  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      'x-request-id': 'req-test',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
  mockGetGlobalConfig.mockResolvedValue({ maxIterations: 12 });
  mockSetGlobalConfig.mockImplementation(async (config) => config);
  mockGetRepoConfig.mockResolvedValue({ maxIterations: 8 });
  mockSetRepoConfig.mockImplementation(async (_repo, config) => config);
  mockDeleteRepoConfig.mockResolvedValue(undefined);
});

afterAll(() => {
  if (originalEnableAuth === undefined) {
    delete process.env.ENABLE_AUTH;
  } else {
    process.env.ENABLE_AUTH = originalEnableAuth;
  }
});

describe('global Agent Session configuration', () => {
  it('returns the current global configuration', async () => {
    const response = await getGlobalConfig(request('/api/v2/ai/config/agent-session', 'GET'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ maxIterations: 12 });
    expect(mockGetGlobalConfig).toHaveBeenCalledTimes(1);
  });

  it('requires a session before reading global configuration', async () => {
    mockGetUser.mockReturnValueOnce(null);

    const response = await getGlobalConfig(request('/api/v2/ai/config/agent-session', 'GET'));

    expect(response.status).toBe(401);
    expect(mockGetGlobalConfig).not.toHaveBeenCalled();
  });

  it('returns 500 when global configuration lookup fails', async () => {
    mockGetGlobalConfig.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await getGlobalConfig(request('/api/v2/ai/config/agent-session', 'GET'));

    expect(response.status).toBe(500);
  });

  it('rejects malformed JSON without calling the config service', async () => {
    const response = await putGlobalConfig(
      request('/api/v2/ai/config/agent-session', 'PUT', undefined, new SyntaxError('invalid JSON'))
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid JSON in request body');
    expect(mockSetGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects schema-invalid global configuration with validator details', async () => {
    const response = await putGlobalConfig(
      request('/api/v2/ai/config/agent-session', 'PUT', { maxIterations: 0, unexpected: true })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed:');
    expect(mockSetGlobalConfig).not.toHaveBeenCalled();
  });

  it('persists schema-valid global configuration', async () => {
    const config = { systemPrompt: 'Use repository context.', maxIterations: 12, autoProvisionWorkspace: true };

    const response = await putGlobalConfig(request('/api/v2/ai/config/agent-session', 'PUT', config));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSetGlobalConfig).toHaveBeenCalledWith(config);
    expect(body.data).toEqual(config);
  });

  it('maps service-level validation failures to 400', async () => {
    mockSetGlobalConfig.mockRejectedValueOnce(new AgentSessionConfigValidationError('maxIterations is invalid'));

    const response = await putGlobalConfig(request('/api/v2/ai/config/agent-session', 'PUT', { maxIterations: 12 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('maxIterations is invalid');
  });

  it('returns 500 for an unexpected global write failure', async () => {
    mockSetGlobalConfig.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await putGlobalConfig(request('/api/v2/ai/config/agent-session', 'PUT', { maxIterations: 12 }));

    expect(response.status).toBe(500);
  });
});

describe('repository Agent Session configuration', () => {
  it('normalizes the repository full name and returns its override', async () => {
    const response = await getRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/Example-Org/Example-Repo.git', 'GET'),
      repoParams
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetRepoConfig).toHaveBeenCalledWith('example-org/example-repo');
    expect(body.data).toEqual({
      repoFullName: 'example-org/example-repo',
      config: { maxIterations: 8 },
    });
  });

  it('returns an empty object when no repository override exists', async () => {
    mockGetRepoConfig.mockResolvedValueOnce(null);

    const response = await getRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/example-org/example-repo', 'GET'),
      { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.config).toEqual({});
  });

  it.each([
    { label: 'one segment', fullName: ['example-org'] },
    { label: 'an empty repository segment', fullName: ['example-org', ''] },
    { label: 'more than owner/repo', fullName: ['example-org', 'example-repo', 'extra'] },
  ])('rejects GET repository names with $label', async ({ fullName }) => {
    const response = await getRepoConfig(request('/api/v2/ai/config/agent-session/repos/invalid', 'GET'), {
      params: Promise.resolve({ fullName }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid repository fullName. Expected format: owner/repo');
    expect(mockGetRepoConfig).not.toHaveBeenCalled();
  });

  it('returns 500 when repository configuration lookup fails', async () => {
    mockGetRepoConfig.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await getRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/example-org/example-repo', 'GET'),
      { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) }
    );

    expect(response.status).toBe(500);
  });

  it('rejects an invalid repository before reading a PUT body', async () => {
    const invalidRequest = request(
      '/api/v2/ai/config/agent-session/repos/invalid',
      'PUT',
      undefined,
      new SyntaxError('body must not be read')
    );

    const response = await putRepoConfig(invalidRequest, {
      params: Promise.resolve({ fullName: ['invalid'] }),
    });

    expect(response.status).toBe(400);
    expect(invalidRequest.json).not.toHaveBeenCalled();
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('rejects malformed repository JSON', async () => {
    const response = await putRepoConfig(
      request(
        '/api/v2/ai/config/agent-session/repos/example-org/example-repo',
        'PUT',
        undefined,
        new SyntaxError('invalid JSON')
      ),
      { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid JSON in request body');
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('rejects schema-invalid repository configuration', async () => {
    const response = await putRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/example-org/example-repo', 'PUT', {
        maxIterations: 'many',
      }),
      { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed:');
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('normalizes and persists schema-valid repository configuration', async () => {
    const config = { maxIterations: 8, appendSystemPrompt: 'Repository-specific instructions.' };

    const response = await putRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/Example-Org/Example-Repo.git', 'PUT', config),
      repoParams
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSetRepoConfig).toHaveBeenCalledWith('example-org/example-repo', config);
    expect(body.data).toEqual({ repoFullName: 'example-org/example-repo', config });
  });

  it('maps repository service validation failures to 400', async () => {
    mockSetRepoConfig.mockRejectedValueOnce(new AgentSessionConfigValidationError('toolRules are invalid'));

    const response = await putRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/example-org/example-repo', 'PUT', {}),
      { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('toolRules are invalid');
  });

  it('returns 500 for an unexpected repository write failure', async () => {
    mockSetRepoConfig.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await putRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/example-org/example-repo', 'PUT', {}),
      { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) }
    );

    expect(response.status).toBe(500);
  });

  it('rejects an invalid repository DELETE without calling the service', async () => {
    const response = await deleteRepoConfig(request('/api/v2/ai/config/agent-session/repos/invalid', 'DELETE'), {
      params: Promise.resolve({ fullName: ['invalid'] }),
    });

    expect(response.status).toBe(400);
    expect(mockDeleteRepoConfig).not.toHaveBeenCalled();
  });

  it('normalizes and deletes a repository override', async () => {
    const response = await deleteRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/Example-Org/Example-Repo.git', 'DELETE'),
      repoParams
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockDeleteRepoConfig).toHaveBeenCalledWith('example-org/example-repo');
  });

  it('returns 500 when repository deletion fails', async () => {
    mockDeleteRepoConfig.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await deleteRepoConfig(
      request('/api/v2/ai/config/agent-session/repos/example-org/example-repo', 'DELETE'),
      { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) }
    );

    expect(response.status).toBe(500);
  });
});
