import type { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockGetConfig = jest.fn();
const mockCreateLink = jest.fn();
const mockUpdateLink = jest.fn();
const mockDeleteLink = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    return user ? { userId: user.sub, roles: user.realm_access?.roles ?? [] } : null;
  },
}));

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('server/services/buildMetadata', () => {
  const actual = jest.requireActual('server/services/buildMetadata');
  return {
    __esModule: true,
    ...actual,
    default: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGetConfig(...args),
      createLink: (...args: unknown[]) => mockCreateLink(...args),
      updateLink: (...args: unknown[]) => mockUpdateLink(...args),
      deleteLink: (...args: unknown[]) => mockDeleteLink(...args),
    })),
  };
});

import { BuildMetadataError } from 'server/services/buildMetadata';
import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';

function request(url: string, body?: unknown, jsonError?: Error): NextRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: new Headers([['x-request-id', 'req-metadata']]),
    nextUrl: new URL(url),
    json: jsonError ? jest.fn().mockRejectedValue(jsonError) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const context = (id = 'buildkite') => ({ params: Promise.resolve({ id }) });

const metadata = {
  links: [
    {
      id: 'buildkite',
      label: 'Buildkite',
      urlTemplate: 'https://buildkite.example/builds/{{metadata.buildNumber}}',
      position: 0,
    },
  ],
};

describe('build metadata configuration routes', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin-1', realm_access: { roles: ['admin'] } });
    mockGetConfig.mockResolvedValue(metadata);
    mockCreateLink.mockResolvedValue(metadata);
    mockUpdateLink.mockResolvedValue(metadata);
    mockDeleteLink.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it.each([
    ['GET', GET, undefined],
    ['POST', POST, undefined],
    ['PATCH', PATCH, context()],
    ['DELETE', DELETE, context()],
  ])('rejects a non-admin before %s reaches the metadata service', async (_method, handler, routeContext) => {
    mockGetUser.mockReturnValue({ sub: 'user-1', realm_access: { roles: ['user'] } });

    const response = await handler(
      request('http://localhost/api/v2/config/metadata/buildkite', { label: 'Changed' }),
      routeContext as never
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toBe('Forbidden: insufficient permissions');
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(mockUpdateLink).not.toHaveBeenCalled();
    expect(mockDeleteLink).not.toHaveBeenCalled();
  });

  it('returns the current global metadata configuration', async () => {
    const response = await GET(request('http://localhost/api/v2/config/metadata'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(metadata);
    expect(mockGetConfig).toHaveBeenCalledTimes(1);
  });

  it('maps an unexpected configuration read failure to 500', async () => {
    mockGetConfig.mockRejectedValue(new Error('read failed'));

    const response = await GET(request('http://localhost/api/v2/config/metadata'));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('read failed');
  });

  it('creates a link from the parsed request body', async () => {
    const input = {
      id: 'buildkite',
      label: 'Buildkite',
      urlTemplate: 'https://buildkite.example/builds/{{metadata.buildNumber}}',
    };

    const response = await POST(request('http://localhost/api/v2/config/metadata', input));

    expect(response.status).toBe(201);
    expect((await response.json()).data).toEqual(metadata);
    expect(mockCreateLink).toHaveBeenCalledWith(input);
  });

  it('returns 400 and does not call createLink for invalid JSON', async () => {
    const response = await POST(
      request('http://localhost/api/v2/config/metadata', undefined, new SyntaxError('Unexpected token'))
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Invalid JSON in request body.');
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'invalid input',
      error: new BuildMetadataError('label must be a string.', 'invalid_input'),
      expectedStatus: 400,
    },
    {
      label: 'not found',
      error: new BuildMetadataError('Link does not exist.', 'not_found'),
      expectedStatus: 404,
    },
  ])('maps createLink $label failures to status $expectedStatus', async ({ error, expectedStatus }) => {
    mockCreateLink.mockRejectedValue(error);

    const response = await POST(request('http://localhost/api/v2/config/metadata', { label: 5 }));

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.message).toBe(error.message);
  });

  it('maps unexpected createLink failures to 500', async () => {
    mockCreateLink.mockRejectedValue(new Error('create failed'));

    const response = await POST(request('http://localhost/api/v2/config/metadata', {}));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('create failed');
  });

  it('updates the route id with the parsed patch body', async () => {
    const input = { label: 'Buildkite CI', position: 2 };

    const response = await PATCH(
      request('http://localhost/api/v2/config/metadata/buildkite', input),
      context('buildkite')
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(metadata);
    expect(mockUpdateLink).toHaveBeenCalledWith('buildkite', input);
  });

  it('returns 400 and does not call updateLink for invalid JSON', async () => {
    const response = await PATCH(
      request('http://localhost/api/v2/config/metadata/buildkite', undefined, new SyntaxError('Unexpected token')),
      context()
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Invalid JSON in request body.');
    expect(mockUpdateLink).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'invalid input',
      error: new BuildMetadataError('position must be an integer.', 'invalid_input'),
      expectedStatus: 400,
    },
    {
      label: 'missing link',
      error: new BuildMetadataError('Metadata link was not found.', 'not_found'),
      expectedStatus: 404,
    },
  ])('maps updateLink $label failures to status $expectedStatus', async ({ error, expectedStatus }) => {
    mockUpdateLink.mockRejectedValue(error);

    const response = await PATCH(
      request('http://localhost/api/v2/config/metadata/buildkite', { position: -1 }),
      context()
    );

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.message).toBe(error.message);
  });

  it('maps unexpected updateLink failures to 500', async () => {
    mockUpdateLink.mockRejectedValue(new Error('update failed'));

    const response = await PATCH(request('http://localhost/api/v2/config/metadata/buildkite', {}), context());

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('update failed');
  });

  it('deletes the route id and returns an empty 204 response', async () => {
    const response = await DELETE(request('http://localhost/api/v2/config/metadata/buildkite'), context());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockDeleteLink).toHaveBeenCalledWith('buildkite');
  });

  it.each([
    {
      label: 'invalid id',
      error: new BuildMetadataError('id is invalid.', 'invalid_input'),
      expectedStatus: 400,
    },
    {
      label: 'missing link',
      error: new BuildMetadataError('Metadata link was not found.', 'not_found'),
      expectedStatus: 404,
    },
  ])('maps deleteLink $label failures to status $expectedStatus', async ({ error, expectedStatus }) => {
    mockDeleteLink.mockRejectedValue(error);

    const response = await DELETE(request('http://localhost/api/v2/config/metadata/buildkite'), context());

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.message).toBe(error.message);
  });

  it('maps unexpected deleteLink failures to 500', async () => {
    mockDeleteLink.mockRejectedValue(new Error('delete failed'));

    const response = await DELETE(request('http://localhost/api/v2/config/metadata/buildkite'), context());

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('delete failed');
  });
});
