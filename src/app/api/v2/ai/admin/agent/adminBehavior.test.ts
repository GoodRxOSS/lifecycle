import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockListRules = jest.fn();
const mockReplaceRules = jest.fn();
const mockSeedSystemTemplates = jest.fn();
const mockGetTemplate = jest.fn();
const mockGetGlobalConfig = jest.fn();
const mockGetRepoConfig = jest.fn();
const mockGetEffectiveConfig = jest.fn();
const mockResolveForRun = jest.fn();
const mockRenderRulesBlock = jest.fn();
const mockBuildSystemPrompt = jest.fn();
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
}));

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('server/services/agent/InstructionRuleService', () => {
  const actual = jest.requireActual('server/services/agent/InstructionRuleService');
  return {
    __esModule: true,
    ...actual,
    default: {
      listRules: (...args: unknown[]) => mockListRules(...args),
      replaceRules: (...args: unknown[]) => mockReplaceRules(...args),
      resolveForRun: (...args: unknown[]) => mockResolveForRun(...args),
    },
  };
});

jest.mock('server/services/agent/InstructionTemplateService', () => {
  const actual = jest.requireActual('server/services/agent/InstructionTemplateService');
  return {
    __esModule: true,
    ...actual,
    default: {
      seedSystemTemplates: (...args: unknown[]) => mockSeedSystemTemplates(...args),
      getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
    },
  };
});

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getGlobalConfig: (...args: unknown[]) => mockGetGlobalConfig(...args),
      getRepoConfig: (...args: unknown[]) => mockGetRepoConfig(...args),
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args),
    }),
  },
}));

jest.mock('server/services/agent/promptAssembly', () => ({
  renderInstructionRulesBlock: (...args: unknown[]) => mockRenderRulesBlock(...args),
  buildSystemPrompt: (...args: unknown[]) => mockBuildSystemPrompt(...args),
}));

import { InstructionRuleServiceError } from 'server/services/agent/InstructionRuleService';
import { InstructionTemplateServiceError } from 'server/services/agent/InstructionTemplateService';
import { GET as getRules, PUT as putRules } from './instruction-rules/route';
import { GET as getPromptPreview } from './prompt-preview/route';

function request(url: string, body?: unknown, jsonError?: Error): NextRequest {
  return {
    method: body === undefined ? 'GET' : 'PUT',
    headers: new Headers([['x-request-id', 'req-admin-behavior']]),
    nextUrl: new URL(url),
    json: jsonError ? jest.fn().mockRejectedValue(jsonError) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const adminUser = {
  sub: 'admin-1',
  preferred_username: 'admin',
  realm_access: { roles: ['admin'] },
};

describe('agent admin instruction rule routes', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue(adminUser);
    mockListRules.mockResolvedValue([
      { id: 1, agentRef: 'all', repositoryFullName: null, content: 'Be concise.', position: 0 },
    ]);
    mockReplaceRules.mockResolvedValue([
      { id: 2, agentRef: 'system:debug', repositoryFullName: null, content: 'Inspect logs.', position: 0 },
    ]);
  });

  afterAll(() => {
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it.each([
    ['GET', getRules],
    ['PUT', putRules],
  ])('rejects a non-admin before %s calls the instruction rule service', async (_method, handler) => {
    mockGetUser.mockReturnValue({ sub: 'user-1', realm_access: { roles: ['user'] } });

    const response = await handler(request('http://localhost/api/v2/ai/admin/agent/instruction-rules', { rules: [] }));

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toBe('Forbidden: insufficient permissions');
    expect(mockListRules).not.toHaveBeenCalled();
    expect(mockReplaceRules).not.toHaveBeenCalled();
  });

  it.each([
    ['the global scope', '', null],
    ['a repository scope', '?repository=GoodRx%2FLifecycle', 'GoodRx/Lifecycle'],
  ])('lists rules for %s', async (_label, query, expectedRepository) => {
    const response = await getRules(request(`http://localhost/api/v2/ai/admin/agent/instruction-rules${query}`));

    expect(response.status).toBe(200);
    expect((await response.json()).data.rules).toEqual([expect.objectContaining({ id: 1, content: 'Be concise.' })]);
    expect(mockListRules).toHaveBeenCalledWith(expectedRepository);
  });

  it('returns a 500 response when listing rules fails unexpectedly', async () => {
    mockListRules.mockRejectedValue(new Error('database unavailable'));

    const response = await getRules(request('http://localhost/api/v2/ai/admin/agent/instruction-rules'));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('database unavailable');
  });

  it('replaces repository rules and records the authenticated actor', async () => {
    const rules = [
      { agentRef: 'all', content: 'Be concise.' },
      { agentRef: 'system:debug', content: 'Inspect logs.' },
    ];

    const response = await putRules(
      request('http://localhost/api/v2/ai/admin/agent/instruction-rules', {
        repository: 'GoodRx/Lifecycle',
        rules,
      })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.rules).toEqual([expect.objectContaining({ id: 2, content: 'Inspect logs.' })]);
    expect(mockReplaceRules).toHaveBeenCalledWith({
      repositoryFullName: 'GoodRx/Lifecycle',
      rules,
      updatedBy: 'admin-1',
    });
  });

  it.each([undefined, null, ''])('normalizes a %p repository value to the global scope', async (repository) => {
    const response = await putRules(
      request('http://localhost/api/v2/ai/admin/agent/instruction-rules', {
        ...(repository === undefined ? {} : { repository }),
        rules: [],
      })
    );

    expect(response.status).toBe(200);
    expect(mockReplaceRules).toHaveBeenCalledWith({
      repositoryFullName: null,
      rules: [],
      updatedBy: 'admin-1',
    });
  });

  it('returns 400 without calling the service when the request is not valid JSON', async () => {
    const response = await putRules(
      request(
        'http://localhost/api/v2/ai/admin/agent/instruction-rules',
        undefined,
        new SyntaxError('Unexpected token')
      )
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Invalid JSON in request body');
    expect(mockReplaceRules).not.toHaveBeenCalled();
  });

  it.each([
    ['null body', null, 'Request body must include a rules array.'],
    ['array body', [], 'Request body must include a rules array.'],
    ['primitive body', 'rules', 'Request body must include a rules array.'],
    ['missing rules', {}, 'Request body must include a rules array.'],
    ['non-array rules', { rules: {} }, 'Request body must include a rules array.'],
    ['numeric repository', { repository: 123, rules: [] }, 'repository must be a string when provided.'],
    ['null rule', { rules: [null] }, 'Each rule must include agentRef and content strings.'],
    ['array rule', { rules: [[]] }, 'Each rule must include agentRef and content strings.'],
    ['missing agent ref', { rules: [{ content: 'text' }] }, 'Each rule must include agentRef and content strings.'],
    ['missing content', { rules: [{ agentRef: 'all' }] }, 'Each rule must include agentRef and content strings.'],
  ])('rejects %s', async (_label, body, message) => {
    const response = await putRules(request('http://localhost/api/v2/ai/admin/agent/instruction-rules', body));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(message);
    expect(mockReplaceRules).not.toHaveBeenCalled();
  });

  it('maps instruction-rule validation errors to their service status and contract', async () => {
    mockReplaceRules.mockRejectedValue(
      new InstructionRuleServiceError('invalid_agent_ref', 'Unknown agent ref.', { agentRef: 'unknown' })
    );

    const response = await putRules(
      request('http://localhost/api/v2/ai/admin/agent/instruction-rules', {
        rules: [{ agentRef: 'unknown', content: 'text' }],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      message: 'Unknown agent ref.',
      code: 'instruction_rule_agent_ref_invalid',
      details: { ruleCode: 'invalid_agent_ref', agentRef: 'unknown' },
    });
  });

  it('lets the API wrapper map unexpected replacement failures to 500', async () => {
    mockReplaceRules.mockRejectedValue(new Error('write failed'));

    const response = await putRules(
      request('http://localhost/api/v2/ai/admin/agent/instruction-rules', {
        rules: [{ agentRef: 'all', content: 'text' }],
      })
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('write failed');
  });
});

describe('agent admin prompt preview route', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue(adminUser);
    mockSeedSystemTemplates.mockResolvedValue(undefined);
    mockGetTemplate.mockResolvedValue({
      ref: 'system:debug',
      name: 'Debug',
      effective: { source: 'system', content: 'Debug instructions' },
    });
    mockGetGlobalConfig.mockResolvedValue({
      systemPrompt: 'Global base',
      appendSystemPrompt: 'Global guidance',
    });
    mockGetRepoConfig.mockResolvedValue({
      systemPrompt: 'Repository base',
      appendSystemPrompt: '   ',
    });
    mockGetEffectiveConfig.mockResolvedValue({
      systemPrompt: 'Repository base',
      appendSystemPrompt: 'Global guidance',
    });
    mockResolveForRun.mockResolvedValue([{ id: 1, agentRef: 'all', repositoryFullName: null, content: 'Be concise.' }]);
    mockRenderRulesBlock.mockReturnValue('Rules:\n- Be concise.');
    mockBuildSystemPrompt.mockReturnValue('assembled prompt');
  });

  afterAll(() => {
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it('rejects non-admin users before loading prompt inputs', async () => {
    mockGetUser.mockReturnValue({ sub: 'user-1', realm_access: { roles: ['user'] } });

    const response = await getPromptPreview(
      request('http://localhost/api/v2/ai/admin/agent/prompt-preview?agent=system%3Adebug')
    );

    expect(response.status).toBe(403);
    expect(mockSeedSystemTemplates).not.toHaveBeenCalled();
    expect(mockGetTemplate).not.toHaveBeenCalled();
  });

  it('requires an agent ref before consulting configuration services', async () => {
    const response = await getPromptPreview(
      request('http://localhost/api/v2/ai/admin/agent/prompt-preview?repository=goodrx%2Flifecycle')
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('agent query parameter is required.');
    expect(mockSeedSystemTemplates).not.toHaveBeenCalled();
    expect(mockGetGlobalConfig).not.toHaveBeenCalled();
  });

  it('assembles repository-effective prompt parts and labels each source', async () => {
    const response = await getPromptPreview(
      request(
        'http://localhost/api/v2/ai/admin/agent/prompt-preview?agent=system%3Adebug&repository=GoodRx%2FLifecycle'
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(mockGetTemplate).toHaveBeenCalledWith('system:debug');
    expect(mockGetRepoConfig).toHaveBeenCalledWith('GoodRx/Lifecycle');
    expect(mockGetEffectiveConfig).toHaveBeenCalledWith('GoodRx/Lifecycle');
    expect(mockResolveForRun).toHaveBeenCalledWith({
      instructionRefs: ['system:debug'],
      repoFullName: 'GoodRx/Lifecycle',
    });
    expect(mockRenderRulesBlock).toHaveBeenCalledWith(['Be concise.']);
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith([
      'Repository base',
      'Debug instructions',
      'Rules:\n- Be concise.',
      'Global guidance',
    ]);
    expect(body.data).toEqual({
      agent: { ref: 'system:debug', name: 'Debug' },
      repository: 'GoodRx/Lifecycle',
      parts: [
        {
          key: 'base',
          label: 'Base prompt (all agents)',
          source: 'repository',
          content: 'Repository base',
        },
        {
          key: 'instructions',
          label: 'Debug instructions',
          source: 'system',
          content: 'Debug instructions',
        },
        {
          key: 'rules',
          label: 'Rules',
          source: 'configured',
          content: 'Rules:\n- Be concise.',
        },
        {
          key: 'appended',
          label: 'Response guidance (all agents)',
          source: 'global',
          content: 'Global guidance',
        },
      ],
      rules: [{ id: 1, agentRef: 'all', repositoryFullName: null, content: 'Be concise.' }],
      assembled: 'assembled prompt',
    });
  });

  it('uses default and empty-source labels when no repository, config text, rules, or assembled prompt exist', async () => {
    mockGetGlobalConfig.mockResolvedValue({ systemPrompt: '  ', appendSystemPrompt: null });
    mockGetEffectiveConfig.mockResolvedValue({ systemPrompt: '', appendSystemPrompt: '' });
    mockResolveForRun.mockResolvedValue([]);
    mockRenderRulesBlock.mockReturnValue(undefined);
    mockBuildSystemPrompt.mockReturnValue(undefined);

    const response = await getPromptPreview(
      request('http://localhost/api/v2/ai/admin/agent/prompt-preview?agent=system%3Adebug')
    );
    const data = (await response.json()).data;

    expect(response.status).toBe(200);
    expect(mockGetRepoConfig).not.toHaveBeenCalled();
    expect(mockGetEffectiveConfig).toHaveBeenCalledWith(undefined);
    expect(mockResolveForRun).toHaveBeenCalledWith({ instructionRefs: ['system:debug'], repoFullName: undefined });
    expect(data.repository).toBeNull();
    expect(data.parts[0].source).toBe('default');
    expect(data.parts[2]).toEqual(expect.objectContaining({ source: 'none', content: '' }));
    expect(data.parts[3].source).toBe('default');
    expect(data.assembled).toBe('');
  });

  it.each([
    {
      label: 'missing templates',
      error: new InstructionTemplateServiceError('unknown_ref', 'Template not found.'),
      expectedStatus: 404,
    },
    {
      label: 'invalid template input',
      error: new InstructionTemplateServiceError('invalid_ref', 'Invalid template ref.'),
      expectedStatus: 400,
    },
  ])('maps $label to status $expectedStatus', async ({ error, expectedStatus }) => {
    mockGetTemplate.mockRejectedValue(error);

    const response = await getPromptPreview(
      request('http://localhost/api/v2/ai/admin/agent/prompt-preview?agent=system%3Adebug')
    );

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.message).toBe(error.message);
  });

  it('lets the API wrapper map unexpected prompt assembly failures to 500', async () => {
    mockSeedSystemTemplates.mockRejectedValue(new Error('seed failed'));

    const response = await getPromptPreview(
      request('http://localhost/api/v2/ai/admin/agent/prompt-preview?agent=system%3Adebug')
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('seed failed');
    expect(mockGetTemplate).not.toHaveBeenCalled();
  });
});
