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

const mockGetRequestUserIdentity = jest.fn();
const mockQueueAdd = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  redisClient: {
    getConnection: jest.fn(() => ({})),
    getRedis: jest.fn(() => ({})),
  },
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
}));

jest.mock('server/lib/queueManager', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      registerQueue: jest.fn(() => ({
        add: (...args: unknown[]) => mockQueueAdd(...args),
      })),
    })),
  },
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionRuntimeConfig: jest.fn(),
  resolveAgentSessionWorkspaceStorageIntent: jest.fn(),
  AgentSessionRuntimeConfigError: class AgentSessionRuntimeConfigError extends Error {},
  AgentSessionWorkspaceStorageConfigError: class AgentSessionWorkspaceStorageConfigError extends Error {},
}));

jest.mock('server/lib/agentSession/githubToken', () => ({
  resolveRequestGitHubToken: jest.fn(),
}));

jest.mock('server/lib/agentSession/sandboxLaunchState', () => ({
  setSandboxLaunchState: jest.fn(),
  toPublicSandboxLaunchState: jest.fn((state) => state),
}));

jest.mock('server/services/agentSandboxSession', () => ({
  __esModule: true,
  default: jest.fn(),
  formatRequestedSandboxServicesLabel: jest.fn(),
  summarizeRequestedSandboxServices: jest.fn(),
}));

import { POST } from './route';

function makeRequest(json: () => Promise<unknown>): NextRequest {
  return {
    json,
    headers: new Headers([['x-request-id', 'req-test']]),
    url: 'http://localhost/api/v2/ai/agent/sandbox-sessions',
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sandbox-sessions'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sandbox-sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
  });

  it('returns 400 for malformed JSON before queueing a launch', async () => {
    const response = await POST(makeRequest(jest.fn().mockRejectedValue(new SyntaxError('Unexpected token'))));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid JSON body');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('returns 400 for non-object bodies before queueing a launch', async () => {
    const response = await POST(makeRequest(jest.fn().mockResolvedValue(null)));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Request body must be an object');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
