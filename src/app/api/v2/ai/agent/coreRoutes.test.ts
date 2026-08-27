import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockLoadCandidates = jest.fn();
const mockGetEnvironmentActiveSession = jest.fn();
const mockGetEffectiveConfig = jest.fn();
const mockGetProviderEnvVarCandidates = jest.fn();
const mockNormalizeProviderName = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

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

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    getEnvironmentActiveSession: (...args: unknown[]) => mockGetEnvironmentActiveSession(...args),
  },
}));

jest.mock('server/services/agentSessionCandidates', () => ({
  loadAgentSessionServiceCandidates: (...args: unknown[]) => mockLoadCandidates(...args),
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args) }),
  },
}));

jest.mock('server/services/agent/providerConfig', () => ({
  getProviderEnvVarCandidates: (...args: unknown[]) => mockGetProviderEnvVarCandidates(...args),
  normalizeStoredAgentProviderName: (...args: unknown[]) => mockNormalizeProviderName(...args),
}));

import { GET as getSessionCandidates } from './session-candidates/route';
import { GET as getAiConfig } from '../config/route';

function request(url: string): NextRequest {
  return {
    method: 'GET',
    url,
    headers: new Headers([['x-request-id', 'req-agent-core']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/session-candidates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockReturnValue({
      sub: 'user-1',
      preferred_username: 'octocat',
      realm_access: { roles: ['user'] },
    });
    mockLoadCandidates.mockResolvedValue([]);
    mockGetEnvironmentActiveSession.mockResolvedValue(null);
  });

  it('requires a session identity before querying build candidates', async () => {
    mockGetUser.mockReturnValue(null);

    const response = await getSessionCandidates(
      request('http://localhost/api/v2/ai/agent/session-candidates?buildUuid=build-1')
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('authentication_required');
    expect(mockLoadCandidates).not.toHaveBeenCalled();
    expect(mockGetEnvironmentActiveSession).not.toHaveBeenCalled();
  });

  it('requires buildUuid before loading candidates or active-session state', async () => {
    const response = await getSessionCandidates(request('http://localhost/api/v2/ai/agent/session-candidates'));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('buildUuid is required');
    expect(mockLoadCandidates).not.toHaveBeenCalled();
    expect(mockGetEnvironmentActiveSession).not.toHaveBeenCalled();
  });

  it('returns a stable name/repository ordering and the current user active session', async () => {
    mockLoadCandidates.mockResolvedValue([
      {
        name: 'worker',
        type: 'deployment',
        detail: 'Worker',
        repo: 'goodrx/z-worker',
        branch: 'main',
        revision: null,
        ignoredInternalField: true,
      },
      {
        name: 'api',
        type: 'deployment',
        detail: 'API second',
        repo: 'goodrx/lifecycle',
        branch: 'z-feature',
        revision: 'def456',
      },
      {
        name: 'api',
        type: 'deployment',
        detail: 'API first',
        repo: 'goodrx/lifecycle',
        branch: 'main',
        revision: 'abc123',
      },
    ]);
    const activeSession = {
      id: 'session-1',
      status: 'active',
      ownerGithubUsername: 'octocat',
      ownedByCurrentUser: true,
    };
    mockGetEnvironmentActiveSession.mockResolvedValue(activeSession);

    const response = await getSessionCandidates(
      request('http://localhost/api/v2/ai/agent/session-candidates?buildUuid=build-1')
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockLoadCandidates).toHaveBeenCalledWith('build-1');
    expect(mockGetEnvironmentActiveSession).toHaveBeenCalledWith('build-1', 'user-1');
    expect(body.data).toEqual({
      services: [
        {
          name: 'api',
          type: 'deployment',
          detail: 'API first',
          repo: 'goodrx/lifecycle',
          branch: 'main',
          revision: 'abc123',
        },
        {
          name: 'api',
          type: 'deployment',
          detail: 'API second',
          repo: 'goodrx/lifecycle',
          branch: 'z-feature',
          revision: 'def456',
        },
        {
          name: 'worker',
          type: 'deployment',
          detail: 'Worker',
          repo: 'goodrx/z-worker',
          branch: 'main',
          revision: null,
        },
      ],
      activeSession,
    });
  });

  it('returns 404 when candidate loading reports a not-found error', async () => {
    mockLoadCandidates.mockRejectedValue(new Error('Build not found'));

    const response = await getSessionCandidates(
      request('http://localhost/api/v2/ai/agent/session-candidates?buildUuid=missing')
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('Build not found');
  });

  it('returns 400 for other candidate-loading errors', async () => {
    mockLoadCandidates.mockRejectedValue(new Error('Build is not eligible for dev mode'));

    const response = await getSessionCandidates(
      request('http://localhost/api/v2/ai/agent/session-candidates?buildUuid=build-1')
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Build is not eligible for dev mode');
  });

  it('returns the generic 400 error contract for a non-Error rejection', async () => {
    mockGetEnvironmentActiveSession.mockRejectedValue({ reason: 'invalid state' });

    const response = await getSessionCandidates(
      request('http://localhost/api/v2/ai/agent/session-candidates?buildUuid=build-1')
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('An unknown error occurred.');
  });
});

describe('GET /api/v2/ai/config', () => {
  const envKeys = ['TEST_AGENT_PRIMARY_KEY', 'TEST_AGENT_FALLBACK_KEY'] as const;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of envKeys) delete process.env[key];
    mockGetUser.mockReturnValue({ sub: 'user-1', realm_access: { roles: ['user'] } });
    mockGetEffectiveConfig.mockResolvedValue({ enabled: false });
    mockNormalizeProviderName.mockImplementation((name) => name);
    mockGetProviderEnvVarCandidates.mockReturnValue([...envKeys]);
  });

  afterAll(() => {
    for (const key of envKeys) delete process.env[key];
  });

  it('requires a session identity before loading runtime configuration', async () => {
    mockGetUser.mockReturnValue(null);

    const response = await getAiConfig(request('http://localhost/api/v2/ai/config'));

    expect(response.status).toBe(401);
    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['missing configuration', null],
    ['explicitly disabled configuration', { enabled: false }],
  ])('reports the agent runtime disabled for %s', async (_label, config) => {
    mockGetEffectiveConfig.mockResolvedValue(config);

    const response = await getAiConfig(request('http://localhost/api/v2/ai/config'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ enabled: false });
    expect(mockNormalizeProviderName).not.toHaveBeenCalled();
    expect(mockGetProviderEnvVarCandidates).not.toHaveBeenCalled();
  });

  it('selects the first non-disabled provider and reports a fallback environment key as configured', async () => {
    process.env.TEST_AGENT_FALLBACK_KEY = 'secret';
    mockGetEffectiveConfig.mockResolvedValue({
      enabled: true,
      providers: [
        { name: 'anthropic', enabled: false },
        { name: 'openai', enabled: true, apiKeyEnvVar: 'CUSTOM_OPENAI_KEY' },
      ],
    });

    const response = await getAiConfig(request('http://localhost/api/v2/ai/config'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ enabled: true, provider: 'openai', configured: true });
    expect(mockNormalizeProviderName).toHaveBeenCalledWith('openai');
    expect(mockGetProviderEnvVarCandidates).toHaveBeenCalledWith('openai', 'CUSTOM_OPENAI_KEY');
  });

  it('falls back to Anthropic and reports it unconfigured when no provider is enabled', async () => {
    mockGetEffectiveConfig.mockResolvedValue({
      enabled: true,
      providers: [{ name: 'openai', enabled: false }],
    });
    mockNormalizeProviderName.mockReturnValue(undefined);

    const response = await getAiConfig(request('http://localhost/api/v2/ai/config'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ enabled: true, provider: 'anthropic', configured: false });
    expect(mockNormalizeProviderName).toHaveBeenCalledWith(undefined);
    expect(mockGetProviderEnvVarCandidates).toHaveBeenCalledWith('anthropic', undefined);
  });

  it('falls back to Anthropic when an enabled runtime config omits providers', async () => {
    mockGetEffectiveConfig.mockResolvedValue({ enabled: true });
    mockNormalizeProviderName.mockReturnValue(undefined);

    const response = await getAiConfig(request('http://localhost/api/v2/ai/config'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ enabled: true, provider: 'anthropic', configured: false });
    expect(mockNormalizeProviderName).toHaveBeenCalledWith(undefined);
    expect(mockGetProviderEnvVarCandidates).toHaveBeenCalledWith('anthropic', undefined);
  });

  it('maps runtime configuration failures to 500', async () => {
    mockGetEffectiveConfig.mockRejectedValue(new Error('configuration store unavailable'));

    const response = await getAiConfig(request('http://localhost/api/v2/ai/config'));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('configuration store unavailable');
  });
});
