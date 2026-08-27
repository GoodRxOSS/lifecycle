import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockGetGlobalConfig = jest.fn();
const mockSetGlobalConfig = jest.fn();
const mockUpdateGlobalApprovalPolicy = jest.fn();
const mockGetRepoConfig = jest.fn();
const mockGetEffectiveConfig = jest.fn();
const mockSetRepoConfig = jest.fn();
const mockDeleteRepoConfig = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    return user ? { userId: user.sub, roles: user.realm_access?.roles ?? [] } : null;
  },
}));

jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getGlobalConfig: (...args: unknown[]) => mockGetGlobalConfig(...args),
      setGlobalConfig: (...args: unknown[]) => mockSetGlobalConfig(...args),
      updateGlobalApprovalPolicy: (...args: unknown[]) => mockUpdateGlobalApprovalPolicy(...args),
      getRepoConfig: (...args: unknown[]) => mockGetRepoConfig(...args),
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args),
      setRepoConfig: (...args: unknown[]) => mockSetRepoConfig(...args),
      deleteRepoConfig: (...args: unknown[]) => mockDeleteRepoConfig(...args),
    }),
  },
}));

import { AgentRuntimeConfigValidationError } from 'server/lib/validation/agentRuntimeConfigValidator';
import { GET as getGlobal, PATCH as patchGlobal, PUT as putGlobal } from './route';
import { DELETE as deleteRepo, GET as getRepo, PUT as putRepo } from './repos/[...fullName]/route';

function request(url: string, body?: unknown, jsonError?: Error): NextRequest {
  return {
    method: body === undefined ? 'GET' : 'PUT',
    headers: new Headers([['x-request-id', 'req-runtime-config']]),
    nextUrl: new URL(url),
    json: jsonError ? jest.fn().mockRejectedValue(jsonError) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const repoContext = (fullName: string[]) => ({ params: Promise.resolve({ fullName }) });

const globalConfig = {
  enabled: true,
  providers: [],
  maxMessagesPerSession: 100,
  sessionTTL: 3600,
};

const repoConfig = {
  enabled: false,
  excludedFilePatterns: ['dist/**'],
};

describe('global agent runtime configuration route behavior', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin-1', realm_access: { roles: ['admin'] } });
    mockGetGlobalConfig.mockResolvedValue(globalConfig);
    mockSetGlobalConfig.mockResolvedValue(undefined);
    mockUpdateGlobalApprovalPolicy.mockResolvedValue({ ...globalConfig, approvalPolicy: { defaultMode: 'deny' } });
  });

  afterAll(() => {
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it('requires an authenticated session before reading global configuration', async () => {
    mockGetUser.mockReturnValue(null);

    const response = await getGlobal(request('http://localhost/api/v2/ai/agent/runtime-config'));

    expect(response.status).toBe(401);
    expect(mockGetGlobalConfig).not.toHaveBeenCalled();
  });

  it('returns and audits a global configuration read', async () => {
    const response = await getGlobal(request('http://localhost/api/v2/ai/agent/runtime-config'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(globalConfig);
    expect(mockGetGlobalConfig).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith('AgentRuntimeConfig: global config read via=api');
  });

  it('maps an unexpected global configuration read failure to 500', async () => {
    mockGetGlobalConfig.mockRejectedValue(new Error('read failed'));

    const response = await getGlobal(request('http://localhost/api/v2/ai/agent/runtime-config'));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('read failed');
  });

  it('replaces a schema-valid global configuration and returns the persisted value', async () => {
    const updated = { ...globalConfig, sessionTTL: 7200 };
    mockGetGlobalConfig.mockResolvedValue(updated);

    const response = await putGlobal(request('http://localhost/api/v2/ai/agent/runtime-config', updated));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(updated);
    expect(mockSetGlobalConfig).toHaveBeenCalledWith(updated);
    expect(mockGetGlobalConfig).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON before validating or replacing global configuration', async () => {
    const response = await putGlobal(
      request('http://localhost/api/v2/ai/agent/runtime-config', undefined, new SyntaxError('Unexpected token'))
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Invalid JSON in request body');
    expect(mockSetGlobalConfig).not.toHaveBeenCalled();
  });

  it('returns schema diagnostics without calling the global config service', async () => {
    const response = await putGlobal(request('http://localhost/api/v2/ai/agent/runtime-config', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed:');
    expect(body.error.message).toContain('requires property "enabled"');
    expect(mockSetGlobalConfig).not.toHaveBeenCalled();
  });

  it('maps semantic global validation errors to 400', async () => {
    mockSetGlobalConfig.mockRejectedValue(
      new AgentRuntimeConfigValidationError('Cannot exclude core tool: "workspace_exec".')
    );

    const response = await putGlobal(request('http://localhost/api/v2/ai/agent/runtime-config', globalConfig));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Cannot exclude core tool: "workspace_exec".');
  });

  it('maps unexpected global replacement failures to 500', async () => {
    mockSetGlobalConfig.mockRejectedValue(new Error('write failed'));

    const response = await putGlobal(request('http://localhost/api/v2/ai/agent/runtime-config', globalConfig));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('write failed');
  });

  it('patches only the approval policy and returns the updated configuration', async () => {
    const approvalPolicy = { defaultMode: 'deny', rules: { shell_exec: 'require_approval' } };

    const response = await patchGlobal(request('http://localhost/api/v2/ai/agent/runtime-config', { approvalPolicy }));

    expect(response.status).toBe(200);
    expect(mockUpdateGlobalApprovalPolicy).toHaveBeenCalledWith(approvalPolicy);
    expect((await response.json()).data).toEqual({ ...globalConfig, approvalPolicy: { defaultMode: 'deny' } });
  });

  it('rejects invalid JSON before patching global configuration', async () => {
    const response = await patchGlobal(
      request('http://localhost/api/v2/ai/agent/runtime-config', undefined, new SyntaxError('Unexpected token'))
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Invalid JSON in request body');
    expect(mockUpdateGlobalApprovalPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty patch', {}],
    ['an unsupported patch target', { enabled: false }],
    ['an invalid approval mode', { approvalPolicy: { defaultMode: 'sometimes' } }],
  ])('rejects %s at schema validation', async (_label, body) => {
    const response = await patchGlobal(request('http://localhost/api/v2/ai/agent/runtime-config', body));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('Validation failed:');
    expect(mockUpdateGlobalApprovalPolicy).not.toHaveBeenCalled();
  });

  it('maps semantic approval policy validation failures to 400', async () => {
    mockUpdateGlobalApprovalPolicy.mockRejectedValue(
      new AgentRuntimeConfigValidationError('Approval policy is invalid.')
    );

    const response = await patchGlobal(
      request('http://localhost/api/v2/ai/agent/runtime-config', {
        approvalPolicy: { defaultMode: 'deny' },
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Approval policy is invalid.');
  });

  it('maps unexpected approval policy update failures to 500', async () => {
    mockUpdateGlobalApprovalPolicy.mockRejectedValue(new Error('policy write failed'));

    const response = await patchGlobal(
      request('http://localhost/api/v2/ai/agent/runtime-config', {
        approvalPolicy: { defaultMode: 'deny' },
      })
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('policy write failed');
  });
});

describe('repository agent runtime configuration route behavior', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin-1', realm_access: { roles: ['admin'] } });
    mockGetRepoConfig.mockResolvedValue(repoConfig);
    mockGetEffectiveConfig.mockResolvedValue({ ...globalConfig, ...repoConfig });
    mockSetRepoConfig.mockResolvedValue(undefined);
    mockDeleteRepoConfig.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it('normalizes and returns a raw repository override', async () => {
    const response = await getRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/GoodRx/Lifecycle.git'),
      repoContext(['GoodRx', 'Lifecycle.git'])
    );

    expect(response.status).toBe(200);
    expect(mockGetRepoConfig).toHaveBeenCalledWith('goodrx/lifecycle');
    expect((await response.json()).data).toEqual({ repoFullName: 'goodrx/lifecycle', config: repoConfig });
    expect(mockLogger.info).toHaveBeenCalledWith('AgentRuntimeConfig: repo config read repo=goodrx/lifecycle via=api');
  });

  it('returns 404 when a repository has no raw override', async () => {
    mockGetRepoConfig.mockResolvedValue(null);

    const response = await getRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle'),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('No config override found for repository: goodrx/lifecycle');
  });

  it('returns the effective configuration from the effective suffix', async () => {
    const effective = { ...globalConfig, ...repoConfig };

    const response = await getRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle/effective'),
      repoContext(['goodrx', 'lifecycle', 'effective'])
    );

    expect(response.status).toBe(200);
    expect(mockGetEffectiveConfig).toHaveBeenCalledWith('goodrx/lifecycle');
    expect(mockGetRepoConfig).not.toHaveBeenCalled();
    expect((await response.json()).data).toEqual({
      repoFullName: 'goodrx/lifecycle',
      effectiveConfig: effective,
    });
  });

  it.each([
    ['one path segment', ['goodrx']],
    ['effective without a repository', ['goodrx', 'effective']],
    ['more than owner and repository', ['goodrx', 'lifecycle', 'extra']],
  ])('rejects %s as an invalid repository path', async (_label, fullName) => {
    const response = await getRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/invalid'),
      repoContext(fullName)
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Invalid repository fullName. Expected format: owner/repo');
    expect(mockGetRepoConfig).not.toHaveBeenCalled();
    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
  });

  it('maps unexpected repository reads to 500', async () => {
    mockGetRepoConfig.mockRejectedValue(new Error('repo read failed'));

    const response = await getRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle'),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('repo read failed');
  });

  it('upserts a schema-valid repository override and returns the persisted value', async () => {
    const response = await putRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle', repoConfig),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(200);
    expect(mockSetRepoConfig).toHaveBeenCalledWith('goodrx/lifecycle', repoConfig);
    expect(mockGetRepoConfig).toHaveBeenCalledWith('goodrx/lifecycle');
    expect((await response.json()).data).toEqual({ repoFullName: 'goodrx/lifecycle', config: repoConfig });
    expect(mockLogger.info).toHaveBeenCalledWith(
      'AgentRuntimeConfig: repo config updated repo=goodrx/lifecycle via=api'
    );
  });

  it('does not allow writes to the effective endpoint', async () => {
    const req = request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle/effective', repoConfig);

    const response = await putRepo(req, repoContext(['goodrx', 'lifecycle', 'effective']));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(
      'Cannot PUT to the effective config endpoint. Use the repo config endpoint instead.'
    );
    expect(req.json).not.toHaveBeenCalled();
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('rejects invalid repository path parameters before parsing a write body', async () => {
    const req = request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx', repoConfig);

    const response = await putRepo(req, repoContext(['goodrx']));

    expect(response.status).toBe(400);
    expect(req.json).not.toHaveBeenCalled();
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON before validating or writing a repository override', async () => {
    const response = await putRepo(
      request(
        'http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle',
        undefined,
        new SyntaxError('Unexpected token')
      ),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Invalid JSON in request body');
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('rejects a repository override with unsupported fields', async () => {
    const response = await putRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle', {
        providers: [],
      }),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('Validation failed:');
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('maps semantic repository validation failures to 400', async () => {
    mockSetRepoConfig.mockRejectedValue(new AgentRuntimeConfigValidationError('Repository override is too broad.'));

    const response = await putRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle', repoConfig),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Repository override is too broad.');
  });

  it('maps unexpected repository write failures to 500', async () => {
    mockSetRepoConfig.mockRejectedValue(new Error('repo write failed'));

    const response = await putRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle', repoConfig),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('repo write failed');
  });

  it('deletes a repository override by normalized full name', async () => {
    const response = await deleteRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/GoodRx/Lifecycle.git'),
      repoContext(['GoodRx', 'Lifecycle.git'])
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ repoFullName: 'goodrx/lifecycle', deleted: true });
    expect(mockDeleteRepoConfig).toHaveBeenCalledWith('goodrx/lifecycle');
    expect(mockLogger.info).toHaveBeenCalledWith(
      'AgentRuntimeConfig: repo config deleted repo=goodrx/lifecycle via=api'
    );
  });

  it('does not allow deletion through the effective endpoint', async () => {
    const response = await deleteRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle/effective'),
      repoContext(['goodrx', 'lifecycle', 'effective'])
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Cannot DELETE the effective config endpoint.');
    expect(mockDeleteRepoConfig).not.toHaveBeenCalled();
  });

  it('rejects invalid repository path parameters before deletion', async () => {
    const response = await deleteRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx'),
      repoContext(['goodrx'])
    );

    expect(response.status).toBe(400);
    expect(mockDeleteRepoConfig).not.toHaveBeenCalled();
  });

  it('maps unexpected repository deletion failures to 500', async () => {
    mockDeleteRepoConfig.mockRejectedValue(new Error('repo delete failed'));

    const response = await deleteRepo(
      request('http://localhost/api/v2/ai/agent/runtime-config/repos/goodrx/lifecycle'),
      repoContext(['goodrx', 'lifecycle'])
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('repo delete failed');
  });
});
