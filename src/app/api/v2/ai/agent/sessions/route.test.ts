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
const mockSerializeSessionRecord = jest.fn();
const mockResolveAgentSessionRuntimeConfig = jest.fn();
const mockResolveAgentSessionWorkspaceStorageIntent = jest.fn();
const mockMergeAgentSessionReadinessForServices = jest.fn();
const mockMergeAgentSessionResources = jest.fn();
const mockResolveRequestGitHubToken = jest.fn();
const mockBuildQuery = jest.fn();
const mockFetchLifecycleConfig = jest.fn();
const mockCreateAgentSession = jest.fn();
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
    listOwnedSessionRecords: jest.fn(),
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

import { POST } from './route';
import { AgentThreadRuntimeControlsError } from 'server/services/agent/ThreadRuntimeControlsService';

const userIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
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

function mockBuildLookup(build: Record<string, unknown> | null) {
  const withGraphFetched = jest.fn().mockResolvedValue(build);
  const findOne = jest.fn(() => ({ withGraphFetched }));
  mockBuildQuery.mockReturnValueOnce({ findOne });
  return { findOne, withGraphFetched };
}

describe('/api/v2/ai/agent/sessions runtimeControlChoices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildQuery.mockReset();
    mockGetRequestUserIdentity.mockReturnValue(userIdentity);
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
    expect(mockResolveAgentSessionServiceCandidatesForBuild).toHaveBeenCalledWith(buildContext);
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
        source: { adapter: 'lifecycle_environment', input: { buildUuid: 'sample-build' } },
      })
    );

    expect(response.status).toBe(201);
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
});
