import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockListToolInventory = jest.fn();
const mockListMcpServerCoverage = jest.fn();
const mockListModels = jest.fn();
const mockGetSettings = jest.fn();
const mockListConnections = jest.fn();
const mockGetOwnedRun = jest.fn();
const mockSerializeRun = jest.fn();
const mockIsRunNotFound = jest.fn();
const mockGetOwnedThread = jest.fn();
const mockSerializeThread = jest.fn();
const mockUnarchiveSession = jest.fn();
const mockSetKeepWorkspace = jest.fn();
const mockGetSession = jest.fn();
const mockReleaseWorkspace = jest.fn();
const mockSerializeSession = jest.fn();
const mockGetLaunchState = jest.fn();
const mockPublicLaunchState = jest.fn();
const mockStartTemplateBuild = jest.fn();
const mockGetTemplateBuild = jest.fn();
const mockListWorkspaceSources = jest.fn();
const mockListRepoConfigs = jest.fn();
const mockSwagger = jest.fn();
const mockLogger = { info: jest.fn(), error: jest.fn() };
const mockRedis = { get: jest.fn() };

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    return user
      ? {
          userId: user.sub,
          githubUsername: user.preferred_username ?? null,
          roles: user.realm_access?.roles ?? user.roles ?? [],
        }
      : null;
  },
  requireRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    if (!user) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return {
      userId: user.sub,
      githubUsername: user.preferred_username ?? null,
      roles: user.realm_access?.roles ?? user.roles ?? [],
    };
  },
}));

jest.mock('server/lib/dependencies', () => ({
  redisClient: { getRedis: () => mockRedis },
}));

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ listToolInventory: (...args: unknown[]) => mockListToolInventory(...args) }) },
}));

jest.mock('server/services/agent/AdminService', () => ({
  __esModule: true,
  default: { listMcpServerCoverage: (...args: unknown[]) => mockListMcpServerCoverage(...args) },
}));

jest.mock('server/services/agent/ProviderRegistry', () => ({
  __esModule: true,
  default: { listAvailableModelsForUser: (...args: unknown[]) => mockListModels(...args) },
}));

jest.mock('server/services/agent/SettingsService', () => ({
  __esModule: true,
  default: { getSettingsSnapshot: (...args: unknown[]) => mockGetSettings(...args) },
}));

jest.mock('server/services/agentRuntime/mcp/config', () => ({
  McpConfigService: jest.fn(() => ({
    listEnabledConnectionsForUser: (...args: unknown[]) => mockListConnections(...args),
  })),
}));

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    getOwnedRun: (...args: unknown[]) => mockGetOwnedRun(...args),
    serializeRun: (...args: unknown[]) => mockSerializeRun(...args),
    isRunNotFoundError: (...args: unknown[]) => mockIsRunNotFound(...args),
  },
}));

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThreadWithSession: (...args: unknown[]) => mockGetOwnedThread(...args),
    serializeThread: (...args: unknown[]) => mockSerializeThread(...args),
  },
}));

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: { serializeSessionRecord: (...args: unknown[]) => mockSerializeSession(...args) },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  ActiveEnvironmentSessionError: class ActiveEnvironmentSessionError extends Error {},
  default: {
    unarchiveSession: (...args: unknown[]) => mockUnarchiveSession(...args),
    setKeepWorkspace: (...args: unknown[]) => mockSetKeepWorkspace(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    releaseWorkspace: (...args: unknown[]) => mockReleaseWorkspace(...args),
  },
}));

jest.mock('server/services/agent/WorkspaceRuntimeStateService', () => ({
  WorkspaceActionBlockedError: class WorkspaceActionBlockedError extends Error {
    constructor(public reason: string, message: string) {
      super(message);
    }
  },
}));

jest.mock('server/lib/agentSession/sandboxLaunchState', () => ({
  getSandboxLaunchState: (...args: unknown[]) => mockGetLaunchState(...args),
  toPublicSandboxLaunchState: (...args: unknown[]) => mockPublicLaunchState(...args),
}));

jest.mock('server/services/workspaceRuntime/templateBuild', () => ({
  startWorkspaceTemplateBuild: (...args: unknown[]) => mockStartTemplateBuild(...args),
  getWorkspaceTemplateBuild: (...args: unknown[]) => mockGetTemplateBuild(...args),
}));

jest.mock('server/services/workspaceRuntime/testConnection', () => ({
  runWorkspaceBackendListSources: (...args: unknown[]) => mockListWorkspaceSources(...args),
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ listRepoConfigs: (...args: unknown[]) => mockListRepoConfigs(...args) }) },
}));

jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('swagger-jsdoc', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSwagger(...args),
}));

jest.mock('shared/openApiSpec', () => ({ openApiSpecificationForV2Api: { definition: { openapi: '3.0.0' } } }));

import { GET as docsGet } from '../../../docs/route';
import { GET as toolsGet } from '../admin/agent/tools/route';
import { GET as adminMcpGet } from '../admin/agent/mcp-servers/route';
import { GET as modelsGet } from './models/route';
import { GET as settingsGet } from './settings/route';
import { GET as connectionsGet } from './mcp-connections/route';
import { GET as runGet } from './runs/[runId]/route';
import { GET as threadGet } from './threads/[threadId]/route';
import { POST as unarchivePost } from './sessions/[sessionId]/unarchive/route';
import { POST as keepPost } from './sessions/[sessionId]/workspace/keep/route';
import { POST as releasePost } from './sessions/[sessionId]/workspace/release/route';
import { GET as launchGet } from './sandbox-sessions/launches/[launchId]/route';
import { POST as templateBuildPost } from '../workspace-runtime/backends/[id]/template-build/route';
import { GET as templateBuildGet } from '../workspace-runtime/backends/[id]/template-build/[buildId]/route';
import { GET as workspaceSourcesGet } from '../workspace-runtime/backends/[id]/workspace-sources/route';
import { GET as runtimeReposGet } from './runtime-config/repos/route';
import { ActiveEnvironmentSessionError } from 'server/services/agentSession';
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';

function makeRequest(url: string, body?: unknown, jsonReject = false): NextRequest {
  return {
    method: 'GET',
    headers: new Headers([['x-request-id', 'req-thin']]),
    nextUrl: new URL(url),
    json: jsonReject ? jest.fn().mockRejectedValue(new Error('invalid JSON')) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const params = <T extends Record<string, string | undefined>>(value: T) => ({ params: Promise.resolve(value) });

describe('thin App Router API adapters', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'user-1',
      preferred_username: 'octocat',
      realm_access: { roles: ['user'] },
    });
    mockListToolInventory.mockResolvedValue([{ key: 'workspace_exec' }]);
    mockListMcpServerCoverage.mockResolvedValue([{ slug: 'github' }]);
    mockListModels.mockResolvedValue([{ id: 'model-1' }]);
    mockGetSettings.mockResolvedValue({ providers: [] });
    mockListConnections.mockResolvedValue([{ slug: 'github', connected: true }]);
    mockGetOwnedRun.mockResolvedValue({ id: 'run-1' });
    mockSerializeRun.mockReturnValue({ id: 'run-1', status: 'running' });
    mockIsRunNotFound.mockReturnValue(false);
    mockGetOwnedThread.mockResolvedValue({ thread: { id: 'thread-1' }, session: { uuid: 'session-1' } });
    mockSerializeThread.mockReturnValue({ id: 'thread-1', sessionId: 'session-1' });
    mockUnarchiveSession.mockResolvedValue({ uuid: 'session-1' });
    mockSetKeepWorkspace.mockResolvedValue({ uuid: 'session-1', keepWorkspace: true });
    mockGetSession
      .mockResolvedValueOnce({ uuid: 'session-1', userId: 'user-1' })
      .mockResolvedValue({ uuid: 'session-1', userId: 'user-1', workspaceState: 'released' });
    mockReleaseWorkspace.mockResolvedValue(undefined);
    mockSerializeSession.mockImplementation(async (session) => ({ ...session, serialized: true }));
    mockGetLaunchState.mockResolvedValue({ launchId: 'launch-1', userId: 'user-1', status: 'running' });
    mockPublicLaunchState.mockReturnValue({ launchId: 'launch-1', status: 'running' });
    mockStartTemplateBuild.mockResolvedValue({ buildId: 'build-1', status: 'queued' });
    mockGetTemplateBuild.mockResolvedValue({ buildId: 'build-1', status: 'building' });
    mockListWorkspaceSources.mockResolvedValue([{ id: 'template-1' }]);
    mockListRepoConfigs.mockResolvedValue([{ repoFullName: 'goodrx/lifecycle' }]);
    mockSwagger.mockReturnValue({ openapi: '3.0.0', paths: {} });
  });

  afterAll(() => {
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it('returns the generated OpenAPI document', async () => {
    const res = await docsGet();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ openapi: '3.0.0', paths: {} });
    expect(mockSwagger).toHaveBeenCalledWith({ definition: { openapi: '3.0.0' } });
  });

  describe.each([
    [
      'admin tool inventory',
      toolsGet,
      'http://localhost/api/v2/ai/admin/agent/tools',
      mockListToolInventory,
      [{ key: 'workspace_exec' }],
    ],
    [
      'admin MCP coverage',
      adminMcpGet,
      'http://localhost/api/v2/ai/admin/agent/mcp-servers',
      mockListMcpServerCoverage,
      [{ slug: 'github' }],
    ],
  ])('%s', (_label, handler, url, service, expected) => {
    it('enforces admin role before calling the service', async () => {
      const forbidden = await handler(makeRequest(url));
      expect(forbidden.status).toBe(403);
      expect(service).not.toHaveBeenCalled();
    });

    it.each([
      ['', 'global'],
      ['?scope=goodrx/lifecycle', 'goodrx/lifecycle'],
    ])('loads requested scope: %s', async (query, scope) => {
      mockGetUser.mockReturnValue({ sub: 'admin-1', realm_access: { roles: ['admin'] } });
      const res = await handler(makeRequest(`${url}${query}`));
      expect(res.status).toBe(200);
      expect(service).toHaveBeenCalledWith(scope);
      expect((await res.json()).data).toEqual(expected);
    });
  });

  describe.each([
    ['models', modelsGet, 'models', mockListModels],
    ['settings', settingsGet, 'settings', mockGetSettings],
    ['MCP connections', connectionsGet, 'mcp-connections', mockListConnections],
  ])('GET agent %s', (label, handler, path, service) => {
    it('requires a session before loading data', async () => {
      mockGetUser.mockReturnValue(null);
      const res = await handler(makeRequest(`http://localhost/api/v2/ai/agent/${path}`));
      expect(res.status).toBe(401);
      expect(service).not.toHaveBeenCalled();
    });

    it.each([
      ['', undefined],
      ['?repo=goodrx/lifecycle', 'goodrx/lifecycle'],
    ])(`returns ${label} with optional repository context: %s`, async (query, repo) => {
      const res = await handler(makeRequest(`http://localhost/api/v2/ai/agent/${path}${query}`));
      expect(res.status).toBe(200);
      if (service === mockListModels) {
        expect(service).toHaveBeenCalledWith({
          repoFullName: repo,
          userIdentity: { userId: 'user-1', githubUsername: 'octocat', roles: ['user'] },
        });
        expect((await res.json()).data).toEqual({ models: [{ id: 'model-1' }] });
      } else if (service === mockListConnections) {
        expect(service).toHaveBeenCalledWith(repo, {
          userId: 'user-1',
          githubUsername: 'octocat',
          roles: ['user'],
        });
      } else {
        expect(service).toHaveBeenCalledWith({ userId: 'user-1', githubUsername: 'octocat', roles: ['user'] }, repo);
      }
    });
  });

  it('returns and serializes an owned run', async () => {
    const res = await runGet(makeRequest('http://localhost/api/v2/ai/agent/runs/run-1'), params({ runId: 'run-1' }));
    expect(mockGetOwnedRun).toHaveBeenCalledWith('run-1', 'user-1');
    expect(mockSerializeRun).toHaveBeenCalledWith({ id: 'run-1' });
    expect((await res.json()).data).toEqual({ id: 'run-1', status: 'running' });
  });

  it('maps a missing run to 404 and propagates unrelated failures through the API wrapper', async () => {
    const missingError = new Error('missing');
    mockGetOwnedRun.mockRejectedValueOnce(missingError);
    mockIsRunNotFound.mockReturnValueOnce(true);
    const missing = await runGet(
      makeRequest('http://localhost/api/v2/ai/agent/runs/missing'),
      params({ runId: 'missing' })
    );
    expect(missing.status).toBe(404);

    mockGetOwnedRun.mockRejectedValueOnce(new Error('database unavailable'));
    const failed = await runGet(makeRequest('http://localhost/api/v2/ai/agent/runs/run-1'), params({ runId: 'run-1' }));
    expect(failed.status).toBe(500);
  });

  it('returns and serializes an owned thread with its session UUID', async () => {
    const res = await threadGet(
      makeRequest('http://localhost/api/v2/ai/agent/threads/thread-1'),
      params({ threadId: 'thread-1' })
    );
    expect(mockGetOwnedThread).toHaveBeenCalledWith('thread-1', 'user-1');
    expect(mockSerializeThread).toHaveBeenCalledWith({ id: 'thread-1' }, 'session-1');
    expect(res.status).toBe(200);
  });

  it('unarchives and serializes an owned session', async () => {
    const res = await unarchivePost(
      makeRequest('http://localhost/api/v2/ai/agent/sessions/session-1/unarchive'),
      params({ sessionId: 'session-1' })
    );
    expect(mockUnarchiveSession).toHaveBeenCalledWith('session-1', 'user-1');
    expect(mockSerializeSession).toHaveBeenCalledWith({ uuid: 'session-1' });
    expect(res.status).toBe(200);
  });

  it.each([
    [
      new ActiveEnvironmentSessionError({
        id: 'session-1',
        status: 'active',
        ownerGithubUsername: null,
        ownedByCurrentUser: true,
      }),
      409,
    ],
    [new Error('Session not found'), 404],
    [new Error('unexpected'), 500],
  ])('maps unarchive errors: %s', async (error, status) => {
    mockUnarchiveSession.mockRejectedValueOnce(error);
    const res = await unarchivePost(
      makeRequest('http://localhost/api/v2/ai/agent/sessions/session-1/unarchive'),
      params({ sessionId: 'session-1' })
    );
    expect(res.status).toBe(status);
  });

  it.each([
    [undefined, false, 400],
    [{ keep: 'yes' }, false, 400],
    [{ keep: false }, false, 200],
    [{ keep: true }, false, 200],
    [undefined, true, 400],
  ])('validates and applies workspace keep preference: %j', async (body, rejectsJson, status) => {
    const res = await keepPost(
      makeRequest('http://localhost/api/v2/ai/agent/sessions/session-1/workspace/keep', body, rejectsJson),
      params({ sessionId: 'session-1' })
    );
    expect(res.status).toBe(status);
    if (status === 200) expect(mockSetKeepWorkspace).toHaveBeenCalledWith('session-1', 'user-1', body!.keep);
    else expect(mockSetKeepWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('Session not found'), 404],
    [new Error('unexpected'), 500],
  ])('maps workspace keep failures: %s', async (error, status) => {
    mockSetKeepWorkspace.mockRejectedValueOnce(error);
    const res = await keepPost(
      makeRequest('http://localhost/api/v2/ai/agent/sessions/session-1/workspace/keep', { keep: true }),
      params({ sessionId: 'session-1' })
    );
    expect(res.status).toBe(status);
  });

  it.each([undefined, { uuid: 'session-1', userId: 'other-user' }])(
    'does not release a missing or foreign session: %j',
    async (session) => {
      mockGetSession.mockReset().mockResolvedValueOnce(session);
      const res = await releasePost(
        makeRequest('http://localhost/api/v2/ai/agent/sessions/session-1/workspace/release'),
        params({ sessionId: 'session-1' })
      );
      expect(res.status).toBe(404);
      expect(mockReleaseWorkspace).not.toHaveBeenCalled();
    }
  );

  it('releases and returns the refreshed session', async () => {
    const res = await releasePost(
      makeRequest('http://localhost/api/v2/ai/agent/sessions/session-1/workspace/release'),
      params({ sessionId: 'session-1' })
    );
    expect(mockReleaseWorkspace).toHaveBeenCalledWith('session-1');
    expect(mockSerializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'session-1', workspaceState: 'released' })
    );
    expect(res.status).toBe(200);
  });

  it.each([
    [new WorkspaceActionBlockedError('active_run', 'run active'), 409],
    [new Error('unexpected'), 500],
  ])('maps release failures: %s', async (error, status) => {
    mockReleaseWorkspace.mockRejectedValueOnce(error);
    const res = await releasePost(
      makeRequest('http://localhost/api/v2/ai/agent/sessions/session-1/workspace/release'),
      params({ sessionId: 'session-1' })
    );
    expect(res.status).toBe(status);
  });

  it.each([
    [undefined, 404],
    [{ launchId: 'launch-1', userId: 'other-user' }, 404],
    [{ launchId: 'launch-1', userId: 'user-1', status: 'running' }, 200],
  ])('returns only an owned sandbox launch: %j', async (state, status) => {
    mockGetLaunchState.mockResolvedValueOnce(state);
    const res = await launchGet(
      makeRequest('http://localhost/api/v2/ai/agent/sandbox-sessions/launches/launch-1'),
      params({ launchId: 'launch-1' })
    );
    expect(mockGetLaunchState).toHaveBeenCalledWith(mockRedis, 'launch-1');
    expect(res.status).toBe(status);
    if (status === 200) expect(mockPublicLaunchState).toHaveBeenCalledWith(state);
    else expect(mockPublicLaunchState).not.toHaveBeenCalled();
  });

  describe('admin workspace runtime helpers', () => {
    beforeEach(() => mockGetUser.mockReturnValue({ sub: 'admin-1', realm_access: { roles: ['admin'] } }));

    type TemplateBuildInput = { templateName?: string; cpuCount?: number; memoryMB?: number };
    const templateBuildCases: Array<[string | undefined, TemplateBuildInput | undefined, string, TemplateBuildInput]> =
      [
        [undefined, undefined, '', {}],
        [
          ' e2b ',
          { templateName: ' custom ', cpuCount: 4, memoryMB: 2048 },
          'e2b',
          { templateName: ' custom ', cpuCount: 4, memoryMB: 2048 },
        ],
      ];

    it.each(templateBuildCases)(
      'starts a template build with normalized route ID: %j',
      async (id, body, expectedId, expectedBody) => {
        const res = await templateBuildPost(
          makeRequest('http://localhost/template-build', body, body === undefined),
          params({ id })
        );
        expect(mockStartTemplateBuild).toHaveBeenCalledWith(expectedId, {
          templateName: expectedBody.templateName,
          cpuCount: expectedBody.cpuCount,
          memoryMB: expectedBody.memoryMB,
        });
        expect(res.status).toBe(202);
      }
    );

    it.each([
      [{ id: undefined, buildId: undefined }, '', ''],
      [{ id: ' e2b ', buildId: ' build-1 ' }, 'e2b', 'build-1'],
    ])('gets a normalized template build: %j', async (routeParams, id, buildId) => {
      const res = await templateBuildGet(makeRequest('http://localhost/template-build/build-1'), params(routeParams));
      expect(mockGetTemplateBuild).toHaveBeenCalledWith(id, buildId);
      expect(res.status).toBe(200);
    });

    it.each([
      [undefined, ''],
      [' e2b ', 'e2b'],
    ])('lists normalized workspace sources: %j', async (id, expected) => {
      const res = await workspaceSourcesGet(makeRequest('http://localhost/workspace-sources'), params({ id }));
      expect(mockListWorkspaceSources).toHaveBeenCalledWith(expected);
      expect((await res.json()).data).toEqual({ sources: [{ id: 'template-1' }] });
    });

    it('rejects non-admin users before spending provider resources', async () => {
      mockGetUser.mockReturnValue({ sub: 'user-1', realm_access: { roles: ['user'] } });
      const res = await templateBuildPost(makeRequest('http://localhost/template-build', {}), params({ id: 'e2b' }));
      expect(res.status).toBe(403);
      expect(mockStartTemplateBuild).not.toHaveBeenCalled();
    });
  });

  it('lists persisted repo runtime configs and records count', async () => {
    const res = await runtimeReposGet(makeRequest('http://localhost/api/v2/ai/agent/runtime-config/repos'));
    expect((await res.json()).data).toEqual([{ repoFullName: 'goodrx/lifecycle' }]);
    expect(mockLogger.info).toHaveBeenCalledWith('AgentRuntimeConfig: repo configs listed via=api count=1');
  });
});
