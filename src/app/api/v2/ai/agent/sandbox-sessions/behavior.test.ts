import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockGetServiceCandidates = jest.fn();
const mockQueueAdd = jest.fn();
const mockGetRedis = jest.fn();
const mockResolveRuntimeConfig = jest.fn();
const mockResolveWorkspaceStorageIntent = jest.fn();
const mockResolveGitHubToken = jest.fn();
const mockEncrypt = jest.fn();
const mockSetLaunchState = jest.fn();
const mockToPublicLaunchState = jest.fn();
const mockSummarizeServices = jest.fn();
const mockFormatServicesLabel = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

jest.mock('uuid', () => ({ v4: () => 'launch-123' }));

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    return user
      ? {
          userId: user.sub,
          githubUsername: user.preferred_username ?? null,
          roles: user.realm_access?.roles ?? [],
        }
      : null;
  },
  requireRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    if (!user) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return {
      userId: user.sub,
      githubUsername: user.preferred_username ?? null,
      roles: user.realm_access?.roles ?? [],
    };
  },
}));

jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('server/lib/dependencies', () => ({
  redisClient: {
    getConnection: () => ({ connection: 'queue' }),
    getRedis: (...args: unknown[]) => mockGetRedis(...args),
  },
}));

jest.mock('server/lib/queueManager', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      registerQueue: () => ({ add: (...args: unknown[]) => mockQueueAdd(...args) }),
    }),
  },
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  AgentSessionRuntimeConfigError: class AgentSessionRuntimeConfigError extends Error {},
  AgentSessionWorkspaceStorageConfigError: class AgentSessionWorkspaceStorageConfigError extends Error {},
  resolveAgentSessionRuntimeConfig: (...args: unknown[]) => mockResolveRuntimeConfig(...args),
  resolveAgentSessionWorkspaceStorageIntent: (...args: unknown[]) => mockResolveWorkspaceStorageIntent(...args),
}));

jest.mock('server/lib/agentSession/githubToken', () => ({
  resolveRequestGitHubToken: (...args: unknown[]) => mockResolveGitHubToken(...args),
}));

jest.mock('server/lib/encryption', () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
}));

jest.mock('server/lib/agentSession/sandboxLaunchState', () => ({
  setSandboxLaunchState: (...args: unknown[]) => mockSetLaunchState(...args),
  toPublicSandboxLaunchState: (...args: unknown[]) => mockToPublicLaunchState(...args),
}));

jest.mock('server/services/agentSandboxSession', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getServiceCandidates: (...args: unknown[]) => mockGetServiceCandidates(...args),
  })),
  summarizeRequestedSandboxServices: (...args: unknown[]) => mockSummarizeServices(...args),
  formatRequestedSandboxServicesLabel: (...args: unknown[]) => mockFormatServicesLabel(...args),
}));

import {
  AgentSessionRuntimeConfigError,
  AgentSessionWorkspaceStorageConfigError,
} from 'server/lib/agentSession/runtimeConfig';
import { GET, POST } from './route';

function request(url: string, body?: unknown, jsonError?: Error): NextRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    url,
    headers: new Headers([['x-request-id', 'req-sandbox-launch']]),
    nextUrl: new URL(url),
    json: jsonError ? jest.fn().mockRejectedValue(jsonError) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const runtimeConfig = {
  workspaceImage: 'workspace:latest',
  workspaceEditorImage: 'editor:latest',
  workspaceGatewayImage: 'gateway:latest',
  nodeSelector: { pool: 'agent' },
  keepAttachedServicesOnSessionNode: true,
  readiness: { timeoutSeconds: 60 },
  resources: { requests: { cpu: '100m' } },
  workspaceStorage: { defaultSize: '10Gi', accessMode: 'ReadWriteOnce', allowClientOverride: true },
  cleanup: { redisTtlSeconds: 3600 },
};

const workspaceStorage = {
  requestedSize: '20Gi',
  storageSize: '20Gi',
  accessMode: 'ReadWriteOnce',
};

describe('sandbox-session launch route behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockReturnValue({
      sub: 'user-1',
      preferred_username: 'octocat',
      realm_access: { roles: ['user'] },
    });
    mockGetServiceCandidates.mockResolvedValue([
      { name: 'api', type: 'deployment', repo: 'goodrx/lifecycle', branch: 'main' },
    ]);
    mockGetRedis.mockReturnValue({ redis: 'client' });
    mockResolveRuntimeConfig.mockResolvedValue(runtimeConfig);
    mockResolveWorkspaceStorageIntent.mockReturnValue(workspaceStorage);
    mockResolveGitHubToken.mockResolvedValue('github-token');
    mockEncrypt.mockImplementation((value) => `encrypted:${value}`);
    mockSetLaunchState.mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue(undefined);
    mockSummarizeServices.mockImplementation((services: unknown[]) =>
      services.length === 1 ? 'api' : `${services.length} services`
    );
    mockFormatServicesLabel.mockReturnValue('api, worker');
    mockToPublicLaunchState.mockImplementation((state) => ({
      launchId: state.launchId,
      status: state.status,
      stage: state.stage,
      service: state.service,
    }));
  });

  it('requires an authenticated session before listing candidates or launching', async () => {
    mockGetUser.mockReturnValue(null);

    const listResponse = await GET(request('http://localhost/api/v2/ai/agent/sandbox-sessions?baseBuildUuid=base-1'));
    const postResponse = await POST(
      request('http://localhost/api/v2/ai/agent/sandbox-sessions', {
        baseBuildUuid: 'base-1',
        service: 'api',
      })
    );

    expect(listResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(mockGetServiceCandidates).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('requires a base build id before listing candidates', async () => {
    const response = await GET(request('http://localhost/api/v2/ai/agent/sandbox-sessions'));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('baseBuildUuid is required');
    expect(mockGetServiceCandidates).not.toHaveBeenCalled();
  });

  it('returns sandboxable services for a base build', async () => {
    const response = await GET(request('http://localhost/api/v2/ai/agent/sandbox-sessions?baseBuildUuid=base-1'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      status: 'needs_service_selection',
      services: [{ name: 'api', type: 'deployment', repo: 'goodrx/lifecycle', branch: 'main' }],
    });
    expect(mockGetServiceCandidates).toHaveBeenCalledWith({ baseBuildUuid: 'base-1' });
  });

  it.each([
    ['a missing base build', new Error('Base build not found'), 404],
    ['an ineligible build', new Error('No sandboxable services'), 400],
    ['a non-Error rejection', { reason: 'invalid state' }, 400],
  ])('maps candidate failure for %s', async (_label, error, status) => {
    mockGetServiceCandidates.mockRejectedValue(error);

    const response = await GET(request('http://localhost/api/v2/ai/agent/sandbox-sessions?baseBuildUuid=base-1'));

    expect(response.status).toBe(status);
  });

  it('requires a base build id before resolving requested services', async () => {
    const response = await POST(request('http://localhost/api/v2/ai/agent/sandbox-sessions', { service: 'api' }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('baseBuildUuid is required');
    expect(mockResolveRuntimeConfig).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it.each([
    ['missing service selection', { baseBuildUuid: 'base-1' }, 'service or services is required'],
    [
      'both service fields',
      { baseBuildUuid: 'base-1', service: 'api', services: ['worker'] },
      'Provide either service or services, not both',
    ],
    [
      'non-array services',
      { baseBuildUuid: 'base-1', services: 'api' },
      'services must be an array of service names or repo-qualified service references',
    ],
    ['empty services', { baseBuildUuid: 'base-1', services: [] }, 'services must contain at least one service'],
    [
      'null service item',
      { baseBuildUuid: 'base-1', services: [null] },
      'service must be a service name or repo-qualified service reference',
    ],
    [
      'array service item',
      { baseBuildUuid: 'base-1', services: [[]] },
      'service must be a service name or repo-qualified service reference',
    ],
    [
      'service ref without a string name',
      { baseBuildUuid: 'base-1', service: { name: 42 } },
      'service must be a service name or repo-qualified service reference',
    ],
    [
      'service ref with a non-string repo',
      { baseBuildUuid: 'base-1', service: { name: 'api', repo: 42 } },
      'service must be a service name or repo-qualified service reference',
    ],
    [
      'service ref with a non-string branch',
      { baseBuildUuid: 'base-1', service: { name: 'api', branch: 42 } },
      'service must be a service name or repo-qualified service reference',
    ],
    ['null workspace', { baseBuildUuid: 'base-1', service: 'api', workspace: null }, 'workspace must be an object'],
    ['array workspace', { baseBuildUuid: 'base-1', service: 'api', workspace: [] }, 'workspace must be an object'],
    [
      'non-string storage size',
      { baseBuildUuid: 'base-1', service: 'api', workspace: { storageSize: 20 } },
      'workspace.storageSize must be a non-empty string',
    ],
    [
      'blank storage size',
      { baseBuildUuid: 'base-1', service: 'api', workspace: { storageSize: '   ' } },
      'workspace.storageSize must be a non-empty string',
    ],
  ])('rejects %s without persisting or queueing a launch', async (_label, body, message) => {
    const response = await POST(request('http://localhost/api/v2/ai/agent/sandbox-sessions', body));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(message);
    expect(mockSetLaunchState).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('queues a multi-service launch with normalized storage, encrypted GitHub token, and runtime settings', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const services = ['api', { name: 'worker', repo: 'goodrx/lifecycle', branch: 'feature' }];

    try {
      const response = await POST(
        request('http://localhost/api/v2/ai/agent/sandbox-sessions', {
          baseBuildUuid: 'base-1',
          services,
          model: 'claude-sonnet',
          workspace: { storageSize: ' 20Gi ' },
        })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toEqual({ launchId: 'launch-123', status: 'queued', stage: 'queued', service: '2 services' });
      expect(mockResolveWorkspaceStorageIntent).toHaveBeenCalledWith({
        requestedSize: '20Gi',
        storage: runtimeConfig.workspaceStorage,
      });
      expect(mockResolveGitHubToken).toHaveBeenCalledWith(expect.any(Object));
      expect(mockEncrypt).toHaveBeenCalledWith('github-token');
      expect(mockSetLaunchState).toHaveBeenCalledWith(
        { redis: 'client' },
        {
          launchId: 'launch-123',
          userId: 'user-1',
          status: 'queued',
          stage: 'queued',
          message: 'Queued sandbox launch for api, worker',
          createdAt: '2026-08-27T12:00:00.000Z',
          updatedAt: '2026-08-27T12:00:00.000Z',
          baseBuildUuid: 'base-1',
          service: '2 services',
          buildUuid: null,
          namespace: null,
          sessionId: null,
          focusUrl: null,
          error: null,
          workspaceFailure: null,
        }
      );
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'launch',
        {
          launchId: 'launch-123',
          userId: 'user-1',
          userIdentity: {
            userId: 'user-1',
            githubUsername: 'octocat',
            roles: ['user'],
          },
          encryptedGithubToken: 'encrypted:github-token',
          baseBuildUuid: 'base-1',
          services,
          model: 'claude-sonnet',
          workspaceImage: 'workspace:latest',
          workspaceEditorImage: 'editor:latest',
          workspaceGatewayImage: 'gateway:latest',
          nodeSelector: { pool: 'agent' },
          keepAttachedServicesOnSessionNode: true,
          readiness: { timeoutSeconds: 60 },
          resources: { requests: { cpu: '100m' } },
          workspaceStorage,
          redisTtlSeconds: 3600,
        },
        { jobId: 'launch-123' }
      );
      expect(mockToPublicLaunchState).toHaveBeenCalledWith(
        expect.objectContaining({ launchId: 'launch-123', userId: 'user-1', service: '2 services' })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('queues a single repo-qualified service without storage override or GitHub token', async () => {
    mockResolveGitHubToken.mockResolvedValue(null);
    mockResolveWorkspaceStorageIntent.mockReturnValue({
      requestedSize: null,
      storageSize: '10Gi',
      accessMode: 'ReadWriteOnce',
    });
    const service = { name: 'api', repo: null, branch: null };

    const response = await POST(
      request('http://localhost/api/v2/ai/agent/sandbox-sessions', {
        baseBuildUuid: 'base-1',
        service,
        workspace: {},
      })
    );

    expect(response.status).toBe(200);
    expect(mockSummarizeServices).toHaveBeenCalledWith([service]);
    expect(mockResolveWorkspaceStorageIntent).toHaveBeenCalledWith({
      requestedSize: undefined,
      storage: runtimeConfig.workspaceStorage,
    });
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'launch',
      expect.objectContaining({ encryptedGithubToken: null, services: [service], model: undefined }),
      { jobId: 'launch-123' }
    );
  });

  it.each([
    ['a missing base build', new Error('Base build not found'), 404],
    ['missing workspace runtime settings', new AgentSessionRuntimeConfigError(['workspaceImage']), 503],
    [
      'a disallowed storage override',
      new AgentSessionWorkspaceStorageConfigError('workspace.storageSize overrides are not enabled.'),
      400,
    ],
    ['an unexpected launch error', new Error('queue prerequisites failed'), 400],
    ['a non-Error launch rejection', { reason: 'invalid state' }, 400],
  ])('maps %s before queueing', async (_label, error, status) => {
    mockResolveRuntimeConfig.mockRejectedValue(error);

    const response = await POST(
      request('http://localhost/api/v2/ai/agent/sandbox-sessions', {
        baseBuildUuid: 'base-1',
        service: 'api',
      })
    );

    expect(response.status).toBe(status);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('does not enqueue when launch-state persistence fails', async () => {
    mockSetLaunchState.mockRejectedValue(new Error('redis unavailable'));

    const response = await POST(
      request('http://localhost/api/v2/ai/agent/sandbox-sessions', {
        baseBuildUuid: 'base-1',
        service: 'api',
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('redis unavailable');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('returns a launch error if queueing fails after state persistence', async () => {
    mockQueueAdd.mockRejectedValue(new Error('queue unavailable'));

    const response = await POST(
      request('http://localhost/api/v2/ai/agent/sandbox-sessions', {
        baseBuildUuid: 'base-1',
        service: 'api',
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('queue unavailable');
    expect(mockSetLaunchState).toHaveBeenCalledTimes(1);
    expect(mockToPublicLaunchState).not.toHaveBeenCalled();
  });
});
