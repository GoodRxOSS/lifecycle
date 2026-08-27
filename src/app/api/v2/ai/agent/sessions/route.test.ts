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
const mockCreateChatSession = jest.fn();
const mockListOwnedSessionRecords = jest.fn();
const mockSerializeSessionRecord = jest.fn();
const mockResolveAgentSessionRuntimeConfig = jest.fn();
const mockResolveAgentSessionWorkspaceStorageIntent = jest.fn();
const mockMergeAgentSessionReadinessForServices = jest.fn();
const mockMergeAgentSessionResources = jest.fn();
const mockResolveRequestGitHubToken = jest.fn();
const mockBuildQuery = jest.fn();
const mockFetchLifecycleConfig = jest.fn();
const mockCreateAgentSession = jest.fn();
const mockResolveAgentSessionCandidateBuildSource = jest.fn();
const mockResolveAgentSessionServiceCandidatesForBuild = jest.fn();
const mockResolveRequestedAgentSessionServices = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
}));

jest.mock('server/services/agent/ChatSessionService', () => ({
  __esModule: true,
  default: {
    createChatSession: (...args: unknown[]) => mockCreateChatSession(...args),
  },
}));

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: {
    listOwnedSessionRecords: (...args: unknown[]) => mockListOwnedSessionRecords(...args),
    serializeSessionRecord: (...args: unknown[]) => mockSerializeSessionRecord(...args),
  },
  DEFAULT_AGENT_SESSION_LIST_LIMIT: 25,
  MAX_AGENT_SESSION_LIST_LIMIT: 100,
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  class AgentSessionRuntimeConfigError extends Error {}
  class AgentSessionWorkspaceStorageConfigError extends Error {}

  return {
    resolveAgentSessionRuntimeConfig: (...args: unknown[]) => mockResolveAgentSessionRuntimeConfig(...args),
    resolveAgentSessionWorkspaceStorageIntent: (...args: unknown[]) =>
      mockResolveAgentSessionWorkspaceStorageIntent(...args),
    mergeAgentSessionReadinessForServices: (...args: unknown[]) => mockMergeAgentSessionReadinessForServices(...args),
    mergeAgentSessionResources: (...args: unknown[]) => mockMergeAgentSessionResources(...args),
    AgentSessionRuntimeConfigError,
    AgentSessionWorkspaceStorageConfigError,
  };
});

jest.mock('server/lib/agentSession/githubToken', () => ({
  resolveRequestGitHubToken: (...args: unknown[]) => mockResolveRequestGitHubToken(...args),
}));

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockBuildQuery(...args),
  },
}));

jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: (...args: unknown[]) => mockFetchLifecycleConfig(...args),
}));

jest.mock('server/services/agentSession', () => {
  class ActiveEnvironmentSessionError extends Error {}

  return {
    __esModule: true,
    default: {
      createSession: (...args: unknown[]) => mockCreateAgentSession(...args),
    },
    ActiveEnvironmentSessionError,
  };
});

jest.mock('server/services/agentSessionCandidates', () => ({
  resolveAgentSessionCandidateBuildSource: (...args: unknown[]) => mockResolveAgentSessionCandidateBuildSource(...args),
  resolveAgentSessionServiceCandidatesForBuild: (...args: unknown[]) =>
    mockResolveAgentSessionServiceCandidatesForBuild(...args),
  resolveRequestedAgentSessionServices: (...args: unknown[]) => mockResolveRequestedAgentSessionServices(...args),
}));

jest.mock('server/services/agent/ProviderRegistry', () => {
  class MissingAgentProviderApiKeyError extends Error {
    readonly httpStatus = 400;
    readonly code = 'provider_api_key_required';
  }
  return {
    __esModule: true,
    default: {},
    MissingAgentProviderApiKeyError,
  };
});

jest.mock('server/services/agent/ThreadRuntimeControlsService', () => {
  const HTTP_STATUS: Record<string, number> = {
    invalid_input: 400,
    unknown_choice: 400,
    policy_denied: 403,
    not_found: 404,
    active_run: 409,
  };
  class AgentThreadRuntimeControlsError extends Error {
    readonly httpStatus: number;
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = 'AgentThreadRuntimeControlsError';
      this.httpStatus = HTTP_STATUS[code] ?? 400;
    }
  }

  return {
    __esModule: true,
    AgentThreadRuntimeControlsError,
  };
});

import { GET, POST } from './route';
import { AgentThreadRuntimeControlsError } from 'server/services/agent/ThreadRuntimeControlsService';
import {
  AgentSessionRuntimeConfigError,
  AgentSessionWorkspaceStorageConfigError,
} from 'server/lib/agentSession/runtimeConfig';
import { ActiveEnvironmentSessionError } from 'server/services/agentSession';
import { MissingAgentProviderApiKeyError } from 'server/services/agent/ProviderRegistry';

const userIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
  roles: ['user'],
  preferredUsername: 'sample-user',
  email: 'sample-user@example.com',
  firstName: 'Sample',
  lastName: 'User',
  displayName: 'Sample User',
  gitUserName: 'Sample User',
  gitUserEmail: 'sample-user@example.com',
};

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions'),
  } as unknown as NextRequest;
}

function makeMalformedJsonRequest(): NextRequest {
  return {
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions'),
  } as unknown as NextRequest;
}

function makeNonObjectRequest(): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(null),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions'),
  } as unknown as NextRequest;
}

function makeGetRequest(query = ''): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(`http://localhost/api/v2/ai/agent/sessions${query}`),
  } as unknown as NextRequest;
}

function mockBuildLookup(build: Record<string, unknown> | null) {
  const withGraphFetched = jest.fn().mockResolvedValue(build);
  const whereNull = jest.fn(() => ({ withGraphFetched }));
  const findOne = jest.fn(() => ({ whereNull }));
  mockBuildQuery.mockReturnValueOnce({ findOne });
  return { findOne, whereNull, withGraphFetched };
}

describe('/api/v2/ai/agent/sessions runtimeControlChoices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildQuery.mockReset();
    mockGetRequestUserIdentity.mockReturnValue(userIdentity);
    mockListOwnedSessionRecords.mockResolvedValue({
      records: [{ uuid: 'session-list-1' }],
      metadata: { pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } },
    });
    mockResolveAgentSessionRuntimeConfig.mockResolvedValue({
      workspaceStorage: {},
      workspaceImage: 'sample-workspace-image',
      workspaceEditorImage: 'sample-editor-image',
      workspaceGatewayImage: 'sample-gateway-image',
      nodeSelector: {},
      keepAttachedServicesOnSessionNode: false,
      readiness: {},
      resources: {},
      cleanup: { redisTtlSeconds: 3600 },
    });
    mockResolveAgentSessionWorkspaceStorageIntent.mockReturnValue(undefined);
    mockMergeAgentSessionReadinessForServices.mockImplementation((readiness) => readiness);
    mockMergeAgentSessionResources.mockImplementation((resources) => resources);
    mockResolveRequestGitHubToken.mockResolvedValue('sample-token');
    mockFetchLifecycleConfig.mockResolvedValue(null);
    mockCreateAgentSession.mockResolvedValue({ uuid: 'session-env-1' });
    mockCreateChatSession.mockResolvedValue({ uuid: 'session-1' });
    mockResolveAgentSessionCandidateBuildSource.mockImplementation(async (build) => {
      const pullRequest = (build as { pullRequest?: Record<string, unknown> | null }).pullRequest;
      if (!pullRequest) {
        return null;
      }

      return {
        repo: pullRequest.fullName,
        branch: pullRequest.branchName,
        configRef: pullRequest.branchName,
        githubRepositoryId: 42,
      };
    });
    mockResolveAgentSessionServiceCandidatesForBuild.mockResolvedValue([]);
    mockResolveRequestedAgentSessionServices.mockReturnValue([]);
    mockSerializeSessionRecord.mockResolvedValue({
      session: {
        id: 'session-1',
        status: 'ready',
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        defaults: { provider: 'openai', model: 'sample-model', harness: null },
        defaultThreadId: 'thread-1',
      },
      source: {},
      sandbox: {},
    });
  });

  it('passes runtimeControlChoices to chat session creation', async () => {
    const body = {
      defaults: { provider: 'openai', model: 'sample-model' },
      source: { adapter: 'blank_workspace', input: {} },
      runtimeControlChoices: {
        agentId: 'custom.sample-agent',
        toolChoiceIds: ['rtc_tool_choice'],
        mcpChoiceIds: [],
      },
    };

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(201);
    expect(mockCreateChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        userIdentity,
        provider: 'openai',
        model: 'sample-model',
        runtimeControlChoices: body.runtimeControlChoices,
      })
    );
  });

  it('preserves current behavior when runtimeControlChoices is absent', async () => {
    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: { adapter: 'blank_workspace', input: {} },
      })
    );

    expect(response.status).toBe(201);
    expect(mockCreateChatSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        runtimeControlChoices: expect.anything(),
      })
    );
  });

  it('returns 400 for malformed JSON before creating a session', async () => {
    const response = await POST(makeMalformedJsonRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid JSON body');
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('returns 400 for non-object bodies before creating a session', async () => {
    const response = await POST(makeNonObjectRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Request body must be an object');
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('maps invalid bootstrap runtime choices to 403', async () => {
    mockCreateChatSession.mockRejectedValueOnce(
      new AgentThreadRuntimeControlsError('policy_denied', 'Runtime control choice is unavailable.')
    );

    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: { adapter: 'blank_workspace', input: {} },
        runtimeControlChoices: {
          toolChoiceIds: ['rtc_denied'],
          mcpChoiceIds: [],
        },
      })
    );

    expect(response.status).toBe(403);
  });

  it('rejects direct lifecycle_fork creation through the generic sessions route', async () => {
    mockBuildLookup({
      uuid: 'sample-build',
      kind: 'sandbox',
      namespace: 'sample-namespace',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 123,
      },
    });

    const response = await POST(
      makeRequest({
        source: { adapter: 'lifecycle_fork', input: { buildUuid: 'sample-build' } },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('/api/v2/ai/agent/sandbox-sessions');
    expect(mockBuildQuery).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('rejects sandbox builds posted through a non-fork generic sessions adapter', async () => {
    mockBuildLookup({
      uuid: 'sample-build',
      kind: 'sandbox',
      namespace: 'sample-namespace',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 123,
      },
    });

    const response = await POST(
      makeRequest({
        source: { adapter: 'lifecycle_environment', input: { buildUuid: 'sample-build' } },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('/api/v2/ai/agent/sandbox-sessions');
    expect(mockFetchLifecycleConfig).not.toHaveBeenCalled();
    expect(mockResolveRequestGitHubToken).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('rejects client-supplied resolved service objects without a build context', async () => {
    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: {
          adapter: 'lifecycle_environment',
          input: {
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/sample',
            namespace: 'sample-namespace',
            services: [
              {
                name: 'sample-service',
                deployId: 123,
                resourceName: 'sample-deploy',
                devConfig: { image: 'node:20', command: 'pnpm dev' },
              },
            ],
          },
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('buildUuid is required when services are specified');
    expect(mockResolveAgentSessionServiceCandidatesForBuild).not.toHaveBeenCalled();
    expect(mockResolveRequestedAgentSessionServices).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('rejects client-supplied resolved service objects even when buildUuid is present', async () => {
    mockBuildLookup({
      uuid: 'sample-build',
      kind: 'environment',
      namespace: 'sample-namespace',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 123,
      },
    });

    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: {
          adapter: 'lifecycle_environment',
          input: {
            buildUuid: 'sample-build',
            services: [
              {
                name: 'sample-service',
                deployId: 123,
                resourceName: 'sample-deploy',
                devConfig: { image: 'node:20', command: 'pnpm dev' },
              },
            ],
          },
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('services must be an array of service names or repo-qualified service references');
    expect(mockResolveAgentSessionServiceCandidatesForBuild).not.toHaveBeenCalled();
    expect(mockResolveRequestedAgentSessionServices).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('resolves requested service refs from the authenticated build context', async () => {
    const buildContext = {
      uuid: 'sample-build',
      kind: 'environment',
      namespace: 'sample-namespace',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 123,
      },
    };
    const candidate = {
      name: 'sample-service',
      deployId: 123,
      devConfig: { image: 'node:20', command: 'pnpm dev', agentSession: { readiness: { pollMs: 1000 } } },
      baseDeploy: { uuid: 'sample-deploy' },
      repo: 'example-org/example-repo',
      branch: 'feature/sample',
      revision: 'sample-revision',
    };
    mockBuildLookup(buildContext);
    mockResolveAgentSessionServiceCandidatesForBuild.mockResolvedValueOnce([candidate]);
    mockResolveRequestedAgentSessionServices.mockReturnValueOnce([candidate]);

    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: {
          adapter: 'lifecycle_environment',
          input: {
            buildUuid: 'sample-build',
            services: [{ name: 'sample-service', repo: 'example-org/example-repo', branch: 'feature/sample' }],
          },
        },
      })
    );

    expect(response.status).toBe(201);
    expect(mockResolveAgentSessionServiceCandidatesForBuild).toHaveBeenCalledWith(
      buildContext,
      expect.objectContaining({
        repo: 'example-org/example-repo',
        branch: 'feature/sample',
      })
    );
    expect(mockResolveRequestedAgentSessionServices).toHaveBeenCalledWith(
      [candidate],
      [{ name: 'sample-service', repo: 'example-org/example-repo', branch: 'feature/sample' }]
    );
    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        services: [
          expect.objectContaining({
            name: 'sample-service',
            deployId: 123,
            resourceName: 'sample-deploy',
            repo: 'example-org/example-repo',
            branch: 'feature/sample',
            revision: 'sample-revision',
          }),
        ],
      })
    );
    expect(mockMergeAgentSessionReadinessForServices).toHaveBeenCalledWith({}, [{ pollMs: 1000 }]);
  });

  it('keeps normal environment session creation on the generic sessions route', async () => {
    const lookup = mockBuildLookup({
      uuid: 'sample-build',
      kind: 'environment',
      namespace: 'sample-namespace',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 123,
      },
    });

    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: { adapter: 'lifecycle_environment', input: { buildUuid: 'sample-build' } },
      })
    );

    expect(response.status).toBe(201);
    expect(lookup.findOne).toHaveBeenCalledWith({ uuid: 'sample-build' });
    expect(lookup.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(lookup.withGraphFetched).toHaveBeenCalledWith(
      '[pullRequest.[repository], deploys.[deployable, repository]]'
    );
    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        buildUuid: 'sample-build',
        buildKind: 'environment',
        repoUrl: 'https://github.com/example-org/example-repo.git',
        branch: 'feature/sample',
        namespace: 'sample-namespace',
      })
    );
  });

  it('creates sessions for live API environments from their server-resolved source context', async () => {
    const buildContext = {
      uuid: 'api-environment',
      kind: 'environment',
      namespace: 'env-api-environment',
      pullRequest: null,
      triggerType: 'api',
      githubRepositoryId: 84,
      branchName: 'main',
      configSha: '0123456789abcdef0123456789abcdef01234567',
    };
    mockBuildLookup(buildContext);
    mockResolveAgentSessionCandidateBuildSource.mockResolvedValueOnce({
      repo: 'example-org/api-repo',
      branch: 'main',
      configRef: '0123456789abcdef0123456789abcdef01234567',
      githubRepositoryId: 84,
    });

    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: {
          adapter: 'lifecycle_environment',
          input: {
            buildUuid: 'api-environment',
            repoUrl: 'https://github.com/untrusted/override.git',
            branch: 'untrusted-branch',
            namespace: 'untrusted-namespace',
            prNumber: 999,
          },
        },
      })
    );

    expect(response.status).toBe(201);
    expect(mockResolveAgentSessionCandidateBuildSource).toHaveBeenCalledWith(buildContext);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith(
      'example-org/api-repo',
      '0123456789abcdef0123456789abcdef01234567'
    );
    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        buildUuid: 'api-environment',
        buildKind: 'environment',
        repoUrl: 'https://github.com/example-org/api-repo.git',
        branch: 'main',
        namespace: 'env-api-environment',
        prNumber: undefined,
      })
    );
  });

  it('returns 404 when the live-row build lookup excludes a tombstone', async () => {
    const lookup = mockBuildLookup(null);

    const response = await POST(
      makeRequest({
        source: { adapter: 'lifecycle_environment', input: { buildUuid: 'deleted-environment' } },
      })
    );

    expect(response.status).toBe(404);
    expect(lookup.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(mockResolveAgentSessionCandidateBuildSource).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  describe('session listing', () => {
    it('requires an authenticated session before listing owned sessions', async () => {
      mockGetRequestUserIdentity.mockReturnValue(null);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
      expect(mockListOwnedSessionRecords).not.toHaveBeenCalled();
    });

    it('uses the default archive, page, and limit filters', async () => {
      const response = await GET(makeGetRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockListOwnedSessionRecords).toHaveBeenCalledWith('sample-user', {
        includeArchived: false,
        page: 1,
        limit: 25,
      });
      expect(body.data).toEqual([{ uuid: 'session-list-1' }]);
      expect(body.metadata).toEqual({ pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } });
    });

    it('includes archived sessions and caps an oversized limit', async () => {
      const response = await GET(makeGetRequest('?includeArchived=true&page=3&limit=999'));

      expect(response.status).toBe(200);
      expect(mockListOwnedSessionRecords).toHaveBeenCalledWith('sample-user', {
        includeArchived: true,
        page: 3,
        limit: 100,
      });
    });

    it('accepts the legacy includeEnded flag and falls back from a nonnumeric limit', async () => {
      const response = await GET(makeGetRequest('?includeEnded=true&page=not-a-page&limit=not-a-limit'));

      expect(response.status).toBe(200);
      expect(mockListOwnedSessionRecords).toHaveBeenCalledWith('sample-user', {
        includeArchived: true,
        page: Number.NaN,
        limit: 25,
      });
    });

    it('maps an unexpected listing failure to 500', async () => {
      mockListOwnedSessionRecords.mockRejectedValue(new Error('session store unavailable'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(500);
      expect((await response.json()).error.message).toBe('session store unavailable');
    });
  });

  describe('request field validation', () => {
    it.each([
      ['null workspace', { workspace: null }, 'workspace must be an object'],
      ['array workspace', { workspace: [] }, 'workspace must be an object'],
      ['primitive workspace', { workspace: '10Gi' }, 'workspace must be an object'],
      ['numeric storage size', { workspace: { storageSize: 10 } }, 'workspace.storageSize must be a non-empty string'],
      ['blank storage size', { workspace: { storageSize: '   ' } }, 'workspace.storageSize must be a non-empty string'],
      ['null runtime controls', { runtimeControlChoices: null }, 'runtimeControlChoices must be an object'],
      ['array runtime controls', { runtimeControlChoices: [] }, 'runtimeControlChoices must be an object'],
      [
        'unknown runtime-control field',
        { runtimeControlChoices: { agentId: 'agent-1', unexpected: true } },
        'Unsupported runtime-control fields: unexpected',
      ],
      [
        'blank runtime-control agent',
        { runtimeControlChoices: { agentId: '   ' } },
        'runtimeControlChoices.agentId must be a non-empty string',
      ],
      [
        'non-string runtime-control agent',
        { runtimeControlChoices: { agentId: 42 } },
        'runtimeControlChoices.agentId must be a non-empty string',
      ],
      [
        'non-array tool choices',
        { runtimeControlChoices: { toolChoiceIds: 'tool-1' } },
        'runtimeControlChoices.toolChoiceIds must be an array of choice ids.',
      ],
      [
        'blank tool choice',
        { runtimeControlChoices: { toolChoiceIds: ['   '] } },
        'runtimeControlChoices.toolChoiceIds must contain only choice ids.',
      ],
      [
        'non-string tool choice',
        { runtimeControlChoices: { toolChoiceIds: [42] } },
        'runtimeControlChoices.toolChoiceIds must contain only choice ids.',
      ],
      [
        'non-array MCP choices',
        { runtimeControlChoices: { mcpChoiceIds: 'mcp-1' } },
        'runtimeControlChoices.mcpChoiceIds must be an array of choice ids.',
      ],
      [
        'blank MCP choice',
        { runtimeControlChoices: { mcpChoiceIds: ['   '] } },
        'runtimeControlChoices.mcpChoiceIds must contain only choice ids.',
      ],
    ])('rejects %s before creating a session', async (_label, fields, message) => {
      const response = await POST(
        makeRequest({
          source: { adapter: 'blank_workspace', input: {} },
          ...fields,
        })
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe(message);
      expect(mockCreateChatSession).not.toHaveBeenCalled();
      expect(mockCreateAgentSession).not.toHaveBeenCalled();
    });

    it('normalizes optional storage and runtime-control choices before chat creation', async () => {
      mockResolveAgentSessionWorkspaceStorageIntent.mockReturnValue({
        requestedSize: '20Gi',
        storageSize: '20Gi',
      });

      const response = await POST(
        makeRequest({
          source: { adapter: 'blank_workspace', input: {} },
          workspace: { storageSize: ' 20Gi ' },
          runtimeControlChoices: {
            agentId: null,
            toolChoiceIds: [' tool-1 '],
            mcpChoiceIds: [' mcp-1 '],
          },
        })
      );

      expect(response.status).toBe(201);
      expect(mockResolveAgentSessionWorkspaceStorageIntent).toHaveBeenCalledWith({
        requestedSize: '20Gi',
        storage: {},
      });
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceStorage: { requestedSize: '20Gi', storageSize: '20Gi' },
          runtimeControlChoices: {
            agentId: undefined,
            toolChoiceIds: ['tool-1'],
            mcpChoiceIds: ['mcp-1'],
          },
        })
      );
    });

    it('accepts an empty workspace object without resolving storage configuration', async () => {
      const response = await POST(makeRequest({ source: { adapter: 'blank_workspace', input: {} }, workspace: {} }));

      expect(response.status).toBe(201);
      expect(mockResolveAgentSessionWorkspaceStorageIntent).not.toHaveBeenCalled();
      expect(mockCreateChatSession).toHaveBeenCalledWith(expect.objectContaining({ workspaceStorage: undefined }));
    });
  });

  describe('chat session input and failures', () => {
    it.each([
      ['a build id', { buildUuid: 'build-1' }],
      ['attached services', { services: ['api'] }],
    ])('rejects chat creation with %s', async (_label, input) => {
      const response = await POST(makeRequest({ source: { adapter: 'blank_workspace', input } }));

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe(
        'Chat sessions cannot be created with buildUuid or attached services'
      );
      expect(mockCreateChatSession).not.toHaveBeenCalled();
    });

    it('treats an empty service list as no attachments', async () => {
      const response = await POST(makeRequest({ source: { adapter: 'blank_workspace', input: { services: [] } } }));

      expect(response.status).toBe(201);
      expect(mockCreateChatSession).toHaveBeenCalledTimes(1);
    });

    it('ignores a non-object source input and a blank provider', async () => {
      const response = await POST(
        makeRequest({
          defaults: { provider: '   ', model: 'model-1' },
          source: { adapter: 'blank_workspace', input: [] },
        })
      );

      expect(response.status).toBe(201);
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        expect.objectContaining({ provider: undefined, model: 'model-1' })
      );
    });

    it('ignores a non-string provider', async () => {
      const response = await POST(
        makeRequest({ defaults: { provider: 42 }, source: { adapter: 'blank_workspace', input: {} } })
      );

      expect(response.status).toBe(201);
      expect(mockCreateChatSession).toHaveBeenCalledWith(expect.objectContaining({ provider: undefined }));
    });

    it.each([
      ['runtime configuration', new AgentSessionRuntimeConfigError('Workspace runtime is not configured.')],
      [
        'workspace storage configuration',
        new AgentSessionWorkspaceStorageConfigError('Storage override is not allowed.'),
      ],
    ])('maps a chat %s error to 400', async (_label, error) => {
      mockCreateChatSession.mockRejectedValue(error);

      const response = await POST(makeRequest({ source: { adapter: 'blank_workspace', input: {} } }));

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe(error.message);
    });

    it('maps an unexpected chat creation failure to 500', async () => {
      mockCreateChatSession.mockRejectedValue(new Error('chat create failed'));

      const response = await POST(makeRequest({ source: { adapter: 'blank_workspace', input: {} } }));

      expect(response.status).toBe(500);
      expect((await response.json()).error.message).toBe('chat create failed');
    });
  });

  describe('environment source validation and resolution', () => {
    it('rejects a missing source as an incomplete environment session request', async () => {
      const response = await POST(makeRequest({}));

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe('repoUrl, branch, and namespace are required');
      expect(mockCreateChatSession).not.toHaveBeenCalled();
      expect(mockCreateAgentSession).not.toHaveBeenCalled();
    });

    it('creates a source-only environment session and applies lifecycle agent settings', async () => {
      mockFetchLifecycleConfig.mockResolvedValue({
        environment: {
          agentSession: {
            skills: ['skill:debug'],
            resources: { requests: { cpu: '250m' } },
          },
        },
      });
      mockMergeAgentSessionResources.mockReturnValue({ merged: true });

      const response = await POST(
        makeRequest({
          defaults: { provider: ' anthropic ', model: 'model-1' },
          source: {
            adapter: 'lifecycle_environment',
            input: {
              repoUrl: 'https://github.com/example-org/example-repo.git',
              branch: 'main',
              prNumber: 12,
              namespace: 'env-source-only',
              services: [],
            },
          },
          workspace: { storageSize: ' 30Gi ' },
        })
      );

      expect(response.status).toBe(201);
      expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/example-repo', 'main');
      expect(mockMergeAgentSessionResources).toHaveBeenCalledWith({}, { requests: { cpu: '250m' } });
      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          buildUuid: undefined,
          buildKind: 'environment',
          services: [],
          provider: 'anthropic',
          model: 'model-1',
          environmentSkillRefs: ['skill:debug'],
          repoUrl: 'https://github.com/example-org/example-repo.git',
          branch: 'main',
          prNumber: 12,
          namespace: 'env-source-only',
          workspaceStorageSize: '30Gi',
          resources: { merged: true },
        })
      );
    });

    it('continues without lifecycle settings when source config loading fails', async () => {
      mockFetchLifecycleConfig.mockRejectedValue(new Error('config not found'));

      const response = await POST(
        makeRequest({
          source: {
            adapter: 'lifecycle_environment',
            input: {
              repoUrl: 'github.com/example-org/example-repo.git',
              branch: 'main',
              namespace: 'env-source-only',
            },
          },
        })
      );

      expect(response.status).toBe(201);
      expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('github.com/example-org/example-repo', 'main');
      expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({ environmentSkillRefs: undefined }));
      expect(mockMergeAgentSessionResources).toHaveBeenCalledWith({}, undefined);
    });

    it.each([
      ['repo URL', { branch: 'main', namespace: 'env-source-only' }],
      ['branch', { repoUrl: 'https://github.com/example-org/example-repo.git', namespace: 'env-source-only' }],
      ['namespace', { repoUrl: 'https://github.com/example-org/example-repo.git', branch: 'main' }],
    ])('requires environment %s before creating', async (_label, input) => {
      const response = await POST(makeRequest({ source: { adapter: 'lifecycle_environment', input } }));

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe('repoUrl, branch, and namespace are required');
      expect(mockCreateAgentSession).not.toHaveBeenCalled();
    });

    it('skips lifecycle-config lookup when the repository URL normalizes empty', async () => {
      const response = await POST(
        makeRequest({
          source: {
            adapter: 'lifecycle_environment',
            input: { repoUrl: 'https://github.com/.git', branch: 'main', namespace: 'env-source-only' },
          },
        })
      );

      expect(response.status).toBe(201);
      expect(mockFetchLifecycleConfig).not.toHaveBeenCalled();
    });

    it('returns 404 when a live build has no resolvable source', async () => {
      const build = {
        uuid: 'build-without-source',
        kind: 'environment',
        namespace: 'env-build',
        pullRequest: null,
      };
      mockBuildLookup(build);
      mockResolveAgentSessionCandidateBuildSource.mockResolvedValue(null);

      const response = await POST(
        makeRequest({
          source: { adapter: 'lifecycle_environment', input: { buildUuid: 'build-without-source' } },
        })
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error.message).toBe('Build not found');
      expect(mockCreateAgentSession).not.toHaveBeenCalled();
    });

    it('defaults a build with no kind to an environment session', async () => {
      const build = {
        uuid: 'legacy-build',
        kind: null,
        namespace: 'env-legacy',
        pullRequest: { pullRequestNumber: null },
      };
      mockBuildLookup(build);
      mockResolveAgentSessionCandidateBuildSource.mockResolvedValue({
        repo: 'example-org/example-repo',
        branch: 'main',
        configRef: 'main',
        githubRepositoryId: 42,
      });

      const response = await POST(
        makeRequest({
          source: { adapter: 'lifecycle_environment', input: { buildUuid: 'legacy-build' } },
        })
      );

      expect(response.status).toBe(201);
      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ buildKind: 'environment', prNumber: undefined })
      );
    });
  });

  describe('requested environment services', () => {
    const buildContext = {
      uuid: 'sample-build',
      kind: 'environment',
      namespace: 'sample-namespace',
      pullRequest: { pullRequestNumber: 123 },
    };
    const buildSource = {
      repo: 'example-org/example-repo',
      branch: 'main',
      configRef: 'main',
      githubRepositoryId: 42,
    };

    function arrangeBuild() {
      mockBuildLookup(buildContext);
      mockResolveAgentSessionCandidateBuildSource.mockResolvedValueOnce(buildSource);
    }

    it.each([
      ['null item', null],
      ['array item', []],
      ['unknown object field', { name: 'api', deployId: 12 }],
      ['non-string name', { name: 12 }],
      ['non-string repo', { name: 'api', repo: 12 }],
      ['non-string branch', { name: 'api', branch: 12 }],
    ])('rejects a requested service with %s', async (_label, service) => {
      arrangeBuild();

      const response = await POST(
        makeRequest({
          source: {
            adapter: 'lifecycle_environment',
            input: { buildUuid: 'sample-build', services: [service] },
          },
        })
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe(
        'services must be an array of service names or repo-qualified service references'
      );
      expect(mockResolveRequestedAgentSessionServices).not.toHaveBeenCalled();
    });

    it('resolves string and nullable repo-qualified service refs and normalizes missing output identifiers', async () => {
      arrangeBuild();
      const candidate = {
        name: 'api',
        deployId: 12,
        devConfig: {},
        baseDeploy: { uuid: '' },
        repo: 'example-org/example-repo',
        branch: 'main',
        revision: '',
      };
      mockResolveAgentSessionServiceCandidatesForBuild.mockResolvedValue([candidate]);
      mockResolveRequestedAgentSessionServices.mockReturnValue([candidate]);
      const requested = ['api', { name: 'worker', repo: null, branch: null }];

      const response = await POST(
        makeRequest({
          source: {
            adapter: 'lifecycle_environment',
            input: { buildUuid: 'sample-build', services: requested },
          },
        })
      );

      expect(response.status).toBe(201);
      expect(mockResolveRequestedAgentSessionServices).toHaveBeenCalledWith([candidate], requested);
      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          services: [expect.objectContaining({ resourceName: undefined, revision: null })],
        })
      );
      expect(mockMergeAgentSessionReadinessForServices).toHaveBeenCalledWith({}, [undefined]);
    });
  });

  describe('environment session service failures', () => {
    const validBody = {
      source: {
        adapter: 'lifecycle_environment',
        input: {
          repoUrl: 'https://github.com/example-org/example-repo.git',
          branch: 'main',
          namespace: 'env-source-only',
        },
      },
    };

    it.each([
      {
        label: 'an existing active environment session',
        error: new ActiveEnvironmentSessionError('Already active.'),
        status: 409,
      },
      {
        label: 'missing runtime configuration',
        error: new AgentSessionRuntimeConfigError('Runtime config missing.'),
        status: 503,
      },
      {
        label: 'invalid workspace storage configuration',
        error: new AgentSessionWorkspaceStorageConfigError('Storage configuration invalid.'),
        status: 400,
      },
      {
        label: 'a missing provider key',
        error: new MissingAgentProviderApiKeyError('Provider key required.'),
        status: 400,
      },
      { label: 'an unexpected failure', error: new Error('environment create failed'), status: 500 },
    ])('maps $label to status $status', async ({ error, status }) => {
      mockCreateAgentSession.mockRejectedValue(error);

      const response = await POST(makeRequest(validBody));

      expect(response.status).toBe(status);
      expect((await response.json()).error.message).toBe(error.message);
    });
  });
});
