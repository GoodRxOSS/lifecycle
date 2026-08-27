import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockListUserDefinitions = jest.fn();
const mockCreateUserDefinition = jest.fn();
const mockGetUserDefinition = jest.fn();
const mockUpdateUserDefinition = jest.fn();
const mockArchiveUserDefinition = jest.fn();
const mockSerializeDefinition = jest.fn();
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

jest.mock('server/services/agent/CustomAgentDefinitionService', () => ({
  customAgentDefinitionService: {
    listUserDefinitions: (...args: unknown[]) => mockListUserDefinitions(...args),
    createUserDefinition: (...args: unknown[]) => mockCreateUserDefinition(...args),
    getUserDefinition: (...args: unknown[]) => mockGetUserDefinition(...args),
    updateUserDefinition: (...args: unknown[]) => mockUpdateUserDefinition(...args),
    archiveUserDefinition: (...args: unknown[]) => mockArchiveUserDefinition(...args),
  },
  serializeUserAgentDefinition: (...args: unknown[]) => mockSerializeDefinition(...args),
}));

import { DELETE, GET as getDefinition, PATCH } from './[definitionId]/route';
import { GET as listDefinitions, POST } from './route';

const identity = {
  userId: 'user-1',
  githubUsername: 'octocat',
  roles: ['user'],
};

const definition = {
  id: 'custom.release-helper',
  name: 'Release helper',
  instructionAddendum: 'Summarize releases.',
};

const publicDefinition = {
  id: 'custom.release-helper',
  name: 'Release helper',
  instructions: 'Summarize releases.',
};

function request(url: string, body?: unknown, jsonError?: Error): NextRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: new Headers([['x-request-id', 'req-definition-validation']]),
    nextUrl: new URL(url),
    json: jsonError ? jest.fn().mockRejectedValue(jsonError) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const detailContext = (definitionId = 'custom.release-helper') => ({
  params: Promise.resolve({ definitionId }),
});

const validBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Release helper',
  description: 'Summarizes releases.',
  instructions: 'Keep it concise.',
  capabilityIds: ['read_context'],
  modelPreference: { provider: 'openai', model: 'gpt-5' },
  resourceBehavior: 'chat_only',
  ...overrides,
});

type UpsertCall = (body?: unknown, jsonError?: Error) => Promise<Response>;

describe('custom agent definition request contracts', () => {
  const create: UpsertCall = (body, jsonError) =>
    POST(request('http://localhost/api/v2/ai/agent/definitions', body, jsonError)) as Promise<Response>;
  const update: UpsertCall = (body, jsonError) =>
    PATCH(
      request('http://localhost/api/v2/ai/agent/definitions/custom.release-helper', body, jsonError),
      detailContext()
    ) as Promise<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockReturnValue({
      sub: 'user-1',
      preferred_username: 'octocat',
      realm_access: { roles: ['user'] },
    });
    mockListUserDefinitions.mockResolvedValue([definition]);
    mockCreateUserDefinition.mockResolvedValue(definition);
    mockGetUserDefinition.mockResolvedValue(definition);
    mockUpdateUserDefinition.mockResolvedValue(definition);
    mockArchiveUserDefinition.mockResolvedValue({ ...definition, status: 'archived' });
    mockSerializeDefinition.mockImplementation((value) => ({
      ...publicDefinition,
      ...(value.status ? { status: value.status } : {}),
    }));
  });

  it.each([
    ['list', () => listDefinitions(request('http://localhost/api/v2/ai/agent/definitions'))],
    ['create', () => create(validBody())],
    [
      'get',
      () =>
        getDefinition(request('http://localhost/api/v2/ai/agent/definitions/custom.release-helper'), detailContext()),
    ],
    ['update', () => update(validBody())],
    [
      'archive',
      () => DELETE(request('http://localhost/api/v2/ai/agent/definitions/custom.release-helper'), detailContext()),
    ],
  ])('requires authentication before the %s operation reaches its service', async (_label, invoke) => {
    mockGetUser.mockReturnValue(null);

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(mockListUserDefinitions).not.toHaveBeenCalled();
    expect(mockCreateUserDefinition).not.toHaveBeenCalled();
    expect(mockGetUserDefinition).not.toHaveBeenCalled();
    expect(mockUpdateUserDefinition).not.toHaveBeenCalled();
    expect(mockArchiveUserDefinition).not.toHaveBeenCalled();
  });

  it('lists serialized definitions owned by the current user', async () => {
    const response = await listDefinitions(request('http://localhost/api/v2/ai/agent/definitions'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ definitions: [publicDefinition] });
    expect(mockListUserDefinitions).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(mockSerializeDefinition).toHaveBeenCalledWith(definition, 0, [definition]);
  });

  it('maps an unexpected definition-list failure to 500', async () => {
    mockListUserDefinitions.mockRejectedValue(new Error('definition store unavailable'));

    const response = await listDefinitions(request('http://localhost/api/v2/ai/agent/definitions'));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('definition store unavailable');
  });

  describe.each([
    ['create', create, mockCreateUserDefinition],
    ['update', update, mockUpdateUserDefinition],
  ])('%s validation', (_label, invoke: UpsertCall, service: jest.Mock) => {
    it('rejects invalid JSON', async () => {
      const response = await invoke(undefined, new SyntaxError('Unexpected token'));

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe('Invalid JSON in request body');
      expect(service).not.toHaveBeenCalled();
    });

    it.each([
      ['null body', null, 'Request body must be an object.'],
      ['array body', [], 'Request body must be an object.'],
      ['primitive body', 'definition', 'Request body must be an object.'],
      [
        'unsupported fields',
        validBody({ ownerUserId: 'other-user', readOnly: true }),
        'Unsupported agent definition fields: ownerUserId, readOnly',
      ],
      ['missing name', validBody({ name: undefined }), 'name must be a string.'],
      ['non-string name', validBody({ name: 42 }), 'name must be a string.'],
      ['missing instructions', validBody({ instructions: undefined }), 'instructions must be a string.'],
      ['non-string instructions', validBody({ instructions: [] }), 'instructions must be a string.'],
      ['non-string description', validBody({ description: 42 }), 'description must be a string.'],
      [
        'non-array capabilities',
        validBody({ capabilityIds: 'read_context' }),
        'capabilityIds must be an array of strings.',
      ],
      [
        'non-string capability',
        validBody({ capabilityIds: ['read_context', 42] }),
        'capabilityIds must be an array of strings.',
      ],
      [
        'primitive model preference',
        validBody({ modelPreference: 'openai/gpt-5' }),
        'modelPreference must be an object or null.',
      ],
      ['array model preference', validBody({ modelPreference: [] }), 'modelPreference must be an object or null.'],
      [
        'unknown model preference field',
        validBody({ modelPreference: { provider: 'openai', model: 'gpt-5', temperature: 0 } }),
        'Unsupported modelPreference fields: temperature',
      ],
      [
        'non-string model provider',
        validBody({ modelPreference: { provider: 42, model: 'gpt-5' } }),
        'modelPreference.provider must be a string.',
      ],
      [
        'non-string model id',
        validBody({ modelPreference: { provider: 'openai', model: 42 } }),
        'modelPreference.model must be a string.',
      ],
      [
        'non-string resource behavior',
        validBody({ resourceBehavior: 42 }),
        'resourceBehavior must be chat_only or current_workspace_when_available.',
      ],
      [
        'unknown resource behavior',
        validBody({ resourceBehavior: 'always_workspace' }),
        'resourceBehavior must be chat_only or current_workspace_when_available.',
      ],
    ])('rejects %s', async (_case, body, message) => {
      const response = await invoke(body);

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe(message);
      expect(service).not.toHaveBeenCalled();
    });
  });

  it('creates a definition with normalized nullable and defaulted optional fields', async () => {
    const response = await create({
      name: 'Release helper',
      instructions: 'Keep it concise.',
      description: null,
      modelPreference: { provider: null, model: null },
      resourceBehavior: 'chat_only',
    });

    expect(response.status).toBe(201);
    expect(mockCreateUserDefinition).toHaveBeenCalledWith(identity, {
      name: 'Release helper',
      description: null,
      instructionAddendum: 'Keep it concise.',
      capabilityRefs: [],
      modelPreference: { provider: null, model: null },
      resourceBehavior: 'chat_only',
    });
    expect((await response.json()).data).toEqual({ definition: publicDefinition });
  });

  it('updates a definition with the complete valid model and workspace behavior', async () => {
    const body = validBody({ resourceBehavior: 'current_workspace_when_available' });

    const response = await update(body);

    expect(response.status).toBe(200);
    expect(mockUpdateUserDefinition).toHaveBeenCalledWith('custom.release-helper', identity, {
      name: 'Release helper',
      description: 'Summarizes releases.',
      instructionAddendum: 'Keep it concise.',
      capabilityRefs: ['read_context'],
      modelPreference: { provider: 'openai', model: 'gpt-5' },
      resourceBehavior: 'current_workspace_when_available',
    });
  });

  it('defaults omitted capabilities to an empty list when updating', async () => {
    const response = await update(validBody({ capabilityIds: undefined }));

    expect(response.status).toBe(200);
    expect(mockUpdateUserDefinition).toHaveBeenCalledWith(
      'custom.release-helper',
      identity,
      expect.objectContaining({ capabilityRefs: [] })
    );
  });

  it('gets and serializes one owned definition', async () => {
    const response = await getDefinition(
      request('http://localhost/api/v2/ai/agent/definitions/custom.release-helper'),
      detailContext()
    );

    expect(response.status).toBe(200);
    expect(mockGetUserDefinition).toHaveBeenCalledWith('custom.release-helper', 'user-1');
    expect((await response.json()).data).toEqual({ definition: publicDefinition });
  });

  it('archives and returns one owned definition', async () => {
    const response = await DELETE(
      request('http://localhost/api/v2/ai/agent/definitions/custom.release-helper'),
      detailContext()
    );

    expect(response.status).toBe(200);
    expect(mockArchiveUserDefinition).toHaveBeenCalledWith('custom.release-helper', 'user-1');
    expect((await response.json()).data).toEqual({
      archived: true,
      definition: { ...publicDefinition, status: 'archived' },
    });
  });

  it.each([
    ['create', create, mockCreateUserDefinition],
    ['update', update, mockUpdateUserDefinition],
  ])('maps an unexpected %s service failure to 500', async (_label, invoke: UpsertCall, service: jest.Mock) => {
    service.mockRejectedValue(new Error('definition write failed'));

    const response = await invoke(validBody());

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('definition write failed');
  });
});
