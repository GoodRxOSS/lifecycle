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

// The Edge middleware forwards lfc_-shaped bearers on ALL /api/v2 paths, so the v2 route files below
// fail closed ONLY through their route wrappers. This suite invokes each exported method directly (the
// middleware-bypass threat model) and proves, by name, that every one rejects an unauthenticated,
// unknown-key, or under-scoped caller.

const mockGetBuildByUUID = jest.fn();
const mockDestroyBuildEnvironment = jest.fn();
const mockRedeployBuild = jest.fn();
const mockRedeployServiceFromBuild = jest.fn();
const mockGetWebhooksForBuild = jest.fn();
const mockInvokeWebhooksForBuild = jest.fn();
const mockValidateLifecycleSchema = jest.fn();
const mockOnboardRepository = jest.fn();
const mockRemoveRepository = jest.fn();
const mockListOnboardedRepositories = jest.fn();
const mockListInstalledRepositories = jest.fn();
const mockDestroyServiceDeployment = jest.fn();
const mockGetSite = jest.fn();
const mockDeleteSite = jest.fn();
const mockExtendSite = jest.fn();
const mockInsertEvent = jest.fn();
const mockGetStats = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  redisClient: {},
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/services/authRateLimit', () => ({
  checkApiKeyRateLimit: jest.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  DEFAULT_RATE_LIMIT_PER_MINUTE: 600,
}));
jest.mock('server/services/apiToken', () => {
  const actual = jest.requireActual('server/services/apiToken');
  return { __esModule: true, ...actual, default: { verifyToken: jest.fn(), touchLastUsed: jest.fn() } };
});
jest.mock('server/services/globalConfig', () => {
  const getAllConfigs = jest.fn();
  const getConfig = jest.fn();
  return {
    __esModule: true,
    default: { getInstance: () => ({ getAllConfigs, getConfig }) },
    __getAllConfigs: getAllConfigs,
    __getConfig: getConfig,
  };
});
jest.mock('server/lib/auth', () => ({ verifyAuth: jest.fn() }));

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getBuildByUUID: mockGetBuildByUUID,
    destroyBuildEnvironment: mockDestroyBuildEnvironment,
    redeployBuild: mockRedeployBuild,
    redeployServiceFromBuild: mockRedeployServiceFromBuild,
    getWebhooksForBuild: mockGetWebhooksForBuild,
    invokeWebhooksForBuild: mockInvokeWebhooksForBuild,
    validateLifecycleSchema: mockValidateLifecycleSchema,
  })),
}));
jest.mock('server/services/override', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    db: { models: { Build: { query: () => ({ findOne: () => ({ withGraphFetched: jest.fn() }) }) } } },
    applyBuildConfigPatch: jest.fn(),
    applyServiceOverrides: jest.fn(),
    getServiceOverrideStates: jest.fn(),
  })),
  BuildUuidValidationError: class BuildUuidValidationError extends Error {},
  ServiceOverrideNotFoundError: class ServiceOverrideNotFoundError extends Error {},
  ServiceOverrideNotEditableError: class ServiceOverrideNotEditableError extends Error {},
}));
jest.mock('server/services/deployCleanup', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ destroyServiceDeployment: mockDestroyServiceDeployment })),
}));
jest.mock('server/services/buildMetadata', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ renderMetadataForBuildUUID: jest.fn() })),
  BuildMetadataError: class BuildMetadataError extends Error {},
}));
jest.mock('server/services/logStreaming', () => ({
  __esModule: true,
  LogStreamingService: jest.fn().mockImplementation(() => ({ getLogStreamInfo: jest.fn() })),
}));
jest.mock('server/services/sites', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getSite: mockGetSite,
    deleteSite: mockDeleteSite,
    extendSite: mockExtendSite,
  })),
}));
jest.mock('server/services/repository', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    onboardRepository: mockOnboardRepository,
    removeRepository: mockRemoveRepository,
    listOnboardedRepositories: mockListOnboardedRepositories,
    listInstalledRepositories: mockListInstalledRepositories,
    parseOnboardedParam: () => undefined,
  })),
}));
jest.mock('server/services/telemetry', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ insertEvent: mockInsertEvent, getStats: mockGetStats })),
}));
jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getEffectiveConfig: jest.fn(), listRepoConfigs: jest.fn().mockResolvedValue([]) }),
  },
}));
jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getEffectiveConfig: jest.fn() }) },
}));
jest.mock('server/services/agentRuntime/mcp/presets', () => ({ listMcpPresets: jest.fn(() => []) }));
jest.mock('server/services/agent/providerConfig', () => ({
  getProviderEnvVarCandidates: jest.fn(() => []),
  normalizeStoredAgentProviderName: jest.fn(() => 'anthropic'),
}));
jest.mock('server/lib/kubernetes/getEnvironmentPods', () => ({ getEnvironmentPods: jest.fn() }));
jest.mock('server/lib/kubernetes/getDeploymentJobs', () => ({ getDeploymentJobs: jest.fn() }));
jest.mock('server/lib/kubernetes/getDeploymentPods', () => ({ getDeploymentPods: jest.fn() }));
jest.mock('server/lib/kubernetes/getNativeBuildJobs', () => ({ getNativeBuildJobs: jest.fn() }));

import { NextRequest, NextResponse } from 'next/server';
import ApiTokenService from 'server/services/apiToken';
import { verifyAuth } from 'server/lib/auth';
import { authMiddleware } from 'server/middlewares/auth';

import { GET as repositoriesGET, POST as repositoriesPOST } from 'src/app/api/v2/repositories/route';
import { DELETE as repositoryDELETE } from 'src/app/api/v2/repositories/[...fullName]/route';
import { GET as buildGET, PATCH as buildPATCH } from 'src/app/api/v2/builds/[uuid]/route';
import { PUT as buildDestroyPUT } from 'src/app/api/v2/builds/[uuid]/destroy/route';
import { GET as buildPodsGET } from 'src/app/api/v2/builds/[uuid]/pods/route';
import { GET as buildMetadataGET } from 'src/app/api/v2/builds/[uuid]/metadata/route';
import { PUT as buildRedeployPUT } from 'src/app/api/v2/builds/[uuid]/redeploy/route';
import { GET as buildWebhooksGET, PUT as buildWebhooksPUT } from 'src/app/api/v2/builds/[uuid]/webhooks/route';
import { PATCH as buildServicesPATCH } from 'src/app/api/v2/builds/[uuid]/services/route';
import { PUT as serviceDestroyPUT } from 'src/app/api/v2/builds/[uuid]/services/[name]/destroy/route';
import { GET as deployJobsGET } from 'src/app/api/v2/builds/[uuid]/services/[name]/deploy-jobs/route';
import { GET as deployJobGET } from 'src/app/api/v2/builds/[uuid]/services/[name]/deploy-jobs/[jobName]/route';
import { GET as servicePodsGET } from 'src/app/api/v2/builds/[uuid]/services/[name]/pods/route';
import { GET as buildJobsGET } from 'src/app/api/v2/builds/[uuid]/services/[name]/build-jobs/route';
import { GET as buildJobGET } from 'src/app/api/v2/builds/[uuid]/services/[name]/build-jobs/[jobName]/route';
import { PUT as serviceRedeployPUT } from 'src/app/api/v2/builds/[uuid]/services/[name]/redeploy/route';
import { GET as schemaValidateGET } from 'src/app/api/v2/schema/validate/route';
import { GET as siteGET, DELETE as siteDELETE } from 'src/app/api/v2/sites/[siteId]/route';
import { POST as siteExtendPOST } from 'src/app/api/v2/sites/[siteId]/extend/route';
import { GET as aiConfigGET } from 'src/app/api/v2/ai/config/route';
import { GET as aiConfigEffectiveGET } from 'src/app/api/v2/ai/config/agent-session/effective/route';
import { GET as aiConfigMcpPresetsGET } from 'src/app/api/v2/ai/config/mcp-presets/route';
import { GET as runtimeConfigReposGET } from 'src/app/api/v2/ai/agent/runtime-config/repos/route';
import { POST as telemetryEventsPOST } from 'src/app/api/v2/telemetry/events/route';
import { GET as telemetryStatsGET } from 'src/app/api/v2/telemetry/stats/route';

const verifyToken = ApiTokenService.verifyToken as jest.Mock;
const verifyAuthMock = verifyAuth as jest.Mock;
const getAllConfigs = (jest.requireMock('server/services/globalConfig') as any).__getAllConfigs as jest.Mock;
const getConfig = (jest.requireMock('server/services/globalConfig') as any).__getConfig as jest.Mock;

const KEY = `lfc_${'a'.repeat(40)}`;
const originalEnableAuth = process.env.ENABLE_AUTH;

// eslint-disable-next-line no-unused-vars
type RouteMethod = (req: NextRequest, ctx?: any) => Promise<NextResponse>;

interface RouteCase {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  run: RouteMethod;
  policy: 'principal' | 'session';
  scope: string | null;
  params?: Record<string, string | string[]>;
}

interface DestructiveCase extends RouteCase {
  policy: 'principal';
  service: jest.Mock;
  insufficientScope: string;
}

const CASES: readonly RouteCase[] = [
  { path: '/api/v2/repositories', method: 'GET', run: repositoriesGET, policy: 'principal', scope: 'repos:read' },
  { path: '/api/v2/repositories', method: 'POST', run: repositoriesPOST, policy: 'principal', scope: 'repos:write' },
  {
    path: '/api/v2/repositories/org/repo',
    method: 'DELETE',
    run: repositoryDELETE,
    policy: 'principal',
    scope: 'repos:write',
    params: { fullName: ['org', 'repo'] },
  },
  {
    path: '/api/v2/builds/x',
    method: 'GET',
    run: buildGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x',
    method: 'PATCH',
    run: buildPATCH,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/destroy',
    method: 'PUT',
    run: buildDestroyPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/pods',
    method: 'GET',
    run: buildPodsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/metadata',
    method: 'GET',
    run: buildMetadataGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/redeploy',
    method: 'PUT',
    run: buildRedeployPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/webhooks',
    method: 'GET',
    run: buildWebhooksGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/webhooks',
    method: 'PUT',
    run: buildWebhooksPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/services',
    method: 'PATCH',
    run: buildServicesPATCH,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x' },
  },
  {
    path: '/api/v2/builds/x/services/web/destroy',
    method: 'PUT',
    run: serviceDestroyPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x', name: 'web' },
  },
  {
    path: '/api/v2/builds/x/services/web/deploy-jobs',
    method: 'GET',
    run: deployJobsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web' },
  },
  {
    path: '/api/v2/builds/x/services/web/deploy-jobs/j',
    method: 'GET',
    run: deployJobGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web', jobName: 'j' },
  },
  {
    path: '/api/v2/builds/x/services/web/pods',
    method: 'GET',
    run: servicePodsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web' },
  },
  {
    path: '/api/v2/builds/x/services/web/build-jobs',
    method: 'GET',
    run: buildJobsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web' },
  },
  {
    path: '/api/v2/builds/x/services/web/build-jobs/j',
    method: 'GET',
    run: buildJobGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web', jobName: 'j' },
  },
  {
    path: '/api/v2/builds/x/services/web/redeploy',
    method: 'PUT',
    run: serviceRedeployPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x', name: 'web' },
  },
  {
    path: '/api/v2/schema/validate?repo=org/repo&branch=main',
    method: 'GET',
    run: schemaValidateGET,
    policy: 'principal',
    scope: 'repos:read',
  },
  {
    path: '/api/v2/sites/s1',
    method: 'GET',
    run: siteGET,
    policy: 'principal',
    scope: 'sites:read',
    params: { siteId: 's1' },
  },
  {
    path: '/api/v2/sites/s1',
    method: 'DELETE',
    run: siteDELETE,
    policy: 'principal',
    scope: 'sites:write',
    params: { siteId: 's1' },
  },
  {
    path: '/api/v2/sites/s1/extend',
    method: 'POST',
    run: siteExtendPOST,
    policy: 'principal',
    scope: 'sites:write',
    params: { siteId: 's1' },
  },
  { path: '/api/v2/ai/config', method: 'GET', run: aiConfigGET, policy: 'session', scope: null },
  {
    path: '/api/v2/ai/config/agent-session/effective',
    method: 'GET',
    run: aiConfigEffectiveGET,
    policy: 'session',
    scope: null,
  },
  { path: '/api/v2/ai/config/mcp-presets', method: 'GET', run: aiConfigMcpPresetsGET, policy: 'session', scope: null },
  {
    path: '/api/v2/ai/agent/runtime-config/repos',
    method: 'GET',
    run: runtimeConfigReposGET,
    policy: 'session',
    scope: null,
  },
  { path: '/api/v2/telemetry/events', method: 'POST', run: telemetryEventsPOST, policy: 'session', scope: null },
  { path: '/api/v2/telemetry/stats', method: 'GET', run: telemetryStatsGET, policy: 'session', scope: null },
];

const DESTRUCTIVE_CASES: readonly DestructiveCase[] = [
  {
    path: '/api/v2/repositories',
    method: 'POST',
    run: repositoriesPOST,
    policy: 'principal',
    scope: 'repos:write',
    service: mockOnboardRepository,
    insufficientScope: 'repos:read',
  },
  {
    path: '/api/v2/repositories/org/repo',
    method: 'DELETE',
    run: repositoryDELETE,
    policy: 'principal',
    scope: 'repos:write',
    params: { fullName: ['org', 'repo'] },
    service: mockRemoveRepository,
    insufficientScope: 'repos:read',
  },
  {
    path: '/api/v2/builds/x/destroy',
    method: 'PUT',
    run: buildDestroyPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x' },
    service: mockDestroyBuildEnvironment,
    insufficientScope: 'env:read',
  },
  {
    path: '/api/v2/builds/x/redeploy',
    method: 'PUT',
    run: buildRedeployPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x' },
    service: mockRedeployBuild,
    insufficientScope: 'env:read',
  },
  {
    path: '/api/v2/builds/x/services/web/destroy',
    method: 'PUT',
    run: serviceDestroyPUT,
    policy: 'principal',
    scope: 'env:write',
    params: { uuid: 'x', name: 'web' },
    service: mockDestroyServiceDeployment,
    insufficientScope: 'env:read',
  },
  {
    path: '/api/v2/sites/s1',
    method: 'DELETE',
    run: siteDELETE,
    policy: 'principal',
    scope: 'sites:write',
    params: { siteId: 's1' },
    service: mockDeleteSite,
    insufficientScope: 'sites:read',
  },
];

const url = (c: Pick<RouteCase, 'path'>) => `http://localhost${c.path}`;
const context = (c: RouteCase) => (c.params ? { params: Promise.resolve(c.params) } : undefined);
const invoke = (c: RouteCase, req: NextRequest) => c.run(req, context(c));
const noAuthRequest = (c: RouteCase) => new NextRequest(url(c), { method: c.method });
const keyRequest = (c: RouteCase) =>
  new NextRequest(url(c), { method: c.method, headers: { authorization: `Bearer ${KEY}` } });

const serviceKey = (scopes: string[]) => ({
  id: 7,
  name: 'ci',
  kind: 'service',
  scopes,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
});

beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  verifyToken.mockResolvedValue(null);
  getAllConfigs.mockResolvedValue({ api_keys: { serviceAuthEnabled: true, personalAuthEnabled: true } });
  getConfig.mockResolvedValue({ serviceAuthEnabled: true, personalAuthEnabled: true });
});

describe('GET /api/v2/schema/validate repository authorization', () => {
  const route = CASES.find((entry) => entry.path.startsWith('/api/v2/schema/validate')) as RouteCase;

  it('requires repos:read before fetching repository content', async () => {
    verifyToken.mockResolvedValue(serviceKey(['env:read']));

    const response = await invoke(route, keyRequest(route));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden_scope');
    expect(mockValidateLifecycleSchema).not.toHaveBeenCalled();
  });

  it('enforces a key repository allowlist before fetching repository content', async () => {
    verifyToken.mockResolvedValue({
      ...serviceKey(['repos:read']),
      repositoryAllowlist: ['org/other'],
    });

    const response = await invoke(route, keyRequest(route));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden_repository');
    expect(mockValidateLifecycleSchema).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
  else process.env.ENABLE_AUTH = originalEnableAuth;
});

describe('coverage of the 25 unwrapped-legacy v2 route files', () => {
  it('exercises every listed file and method exactly once', () => {
    expect(CASES).toHaveLength(29);
    expect(new Set(CASES.map((c) => c.path)).size).toBe(25);
    expect(DESTRUCTIVE_CASES).toHaveLength(6);
  });
});

describe.each(CASES)('$method $path', (c) => {
  it('is guarded by the expected route-policy wrapper', () => {
    const marker = (c.run as any).__routePolicy;
    expect(marker).toBeDefined();
    expect(marker.policy).toBe(c.policy);
    if (c.policy === 'principal') {
      expect(marker.scope).toBe(c.scope);
    }
  });

  it('401 authentication_required (with WWW-Authenticate) when unauthenticated', async () => {
    const res = await invoke(c, noAuthRequest(c));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('authentication_required');
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('rejects an unknown lfc_ bearer without leaking through', async () => {
    verifyToken.mockResolvedValue(null);

    const res = await invoke(c, keyRequest(c));
    const body = await res.json();

    if (c.policy === 'session') {
      expect(res.status).toBe(403);
      expect(body.error.code).toBe('interactive_auth_required');
      // Shape-reject MUST happen before any DB work: the token is never verified.
      expect(verifyToken).not.toHaveBeenCalled();
    } else {
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('invalid_credential');
      expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
      expect(verifyToken).toHaveBeenCalledTimes(1);
    }
  });
});

describe.each(DESTRUCTIVE_CASES)('destructive route $method $path', (c) => {
  it('403 forbidden_scope for an under-scoped key and never calls the service', async () => {
    verifyToken.mockResolvedValue(serviceKey([c.insufficientScope]));

    const res = await invoke(c, keyRequest(c));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden_scope');
    expect(res.headers.get('WWW-Authenticate')).toContain('insufficient_scope');
    expect(c.service).not.toHaveBeenCalled();
  });
});

interface K8sListCase extends RouteCase {
  k8sList: jest.Mock;
}

const { getEnvironmentPods } = jest.requireMock('server/lib/kubernetes/getEnvironmentPods');
const { getDeploymentPods } = jest.requireMock('server/lib/kubernetes/getDeploymentPods');
const { getNativeBuildJobs } = jest.requireMock('server/lib/kubernetes/getNativeBuildJobs');
const { getDeploymentJobs } = jest.requireMock('server/lib/kubernetes/getDeploymentJobs');

const K8S_LIST_CASES: readonly K8sListCase[] = [
  {
    path: '/api/v2/builds/x/pods',
    method: 'GET',
    run: buildPodsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x' },
    k8sList: getEnvironmentPods,
  },
  {
    path: '/api/v2/builds/x/services/web/pods',
    method: 'GET',
    run: servicePodsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web' },
    k8sList: getDeploymentPods,
  },
  {
    path: '/api/v2/builds/x/services/web/build-jobs',
    method: 'GET',
    run: buildJobsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web' },
    k8sList: getNativeBuildJobs,
  },
  {
    path: '/api/v2/builds/x/services/web/deploy-jobs',
    method: 'GET',
    run: deployJobsGET,
    policy: 'principal',
    scope: 'env:read',
    params: { uuid: 'x', name: 'web' },
    k8sList: getDeploymentJobs,
  },
];

// These routes derive the namespace env-<uuid> from the path, so a missing build row must 404 before
// any cluster access — an orphaned namespace would otherwise be listable by any env:read key,
// bypassing the repository allowlist.
describe.each(K8S_LIST_CASES)('k8s list route $method $path', (c) => {
  afterEach(() => {
    mockGetBuildByUUID.mockReset();
    c.k8sList.mockClear();
  });

  it('404s an orphaned namespace (no build row) and never queries the cluster', async () => {
    verifyToken.mockResolvedValue(serviceKey(['env:read']));
    mockGetBuildByUUID.mockResolvedValue(null);

    const res = await invoke(c, keyRequest(c));

    expect(res.status).toBe(404);
    expect(c.k8sList).not.toHaveBeenCalled();
  });

  it('403 forbidden_repository for a disallowed repository, without listing cluster resources', async () => {
    verifyToken.mockResolvedValue({ ...serviceKey(['env:read']), repositoryAllowlistRepoIds: [123] });
    mockGetBuildByUUID.mockResolvedValue({ id: 1, uuid: 'x', githubRepositoryId: 999 });

    const res = await invoke(c, keyRequest(c));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden_repository');
    expect(c.k8sList).not.toHaveBeenCalled();
  });
});

describe('by-design: handlers trust x-user; the Edge middleware is what strips a spoofed one', () => {
  // getRequestUserIdentity parses x-user unconditionally, so a directly-invoked handler WILL honor a
  // crafted x-user. That is safe only because authMiddleware deletes x-user before forwarding. These
  // cases prove the middleware never lets a spoofed x-user survive to `next` on representative paths.
  const spoofedAdmin = Buffer.from(
    JSON.stringify({ sub: 'evil', realm_access: { roles: ['admin'] } }),
    'utf8'
  ).toString('base64url');

  const REPRESENTATIVE_PATHS = [
    '/api/v2/repositories',
    '/api/v2/builds/x/destroy',
    '/api/v2/sites/s1',
    '/api/v2/telemetry/events',
    '/api/v2/schema/validate',
  ];

  beforeEach(() => {
    process.env.ENABLE_AUTH = 'true';
    verifyAuthMock.mockResolvedValue({ success: false, error: { message: 'unverifiable' } });
  });

  it.each(REPRESENTATIVE_PATHS)('forwards an lfc_ key on %s but deletes the spoofed x-user', async (path) => {
    const req = new NextRequest(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${KEY}`, 'x-user': spoofedAdmin },
    });
    const next = jest.fn().mockResolvedValue(NextResponse.json({ ok: true }));

    await authMiddleware(req, next);

    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0][0] as NextRequest;
    expect(forwarded.headers.get('x-user')).toBeNull();
    expect(forwarded.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(verifyAuthMock).not.toHaveBeenCalled();
  });

  it.each(REPRESENTATIVE_PATHS)('rejects a bare spoofed x-user (no bearer) with 401 on %s', async (path) => {
    const req = new NextRequest(`http://localhost${path}`, { headers: { 'x-user': spoofedAdmin } });
    const next = jest.fn().mockResolvedValue(NextResponse.json({ ok: true }));

    const res = await authMiddleware(req, next);

    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
