import type { NextRequest } from 'next/server';
import type { Principal } from 'server/lib/principal';

const mockResolvePrincipal = jest.fn();
const mockScopeSatisfies = jest.fn();
const mockCheckApiKeyRateLimit = jest.fn();
const mockRecordAuthAuditEvent = jest.fn();
const mockListSites = jest.fn();
const mockCreateSite = jest.fn();
const mockGetSite = jest.fn();
const mockDeleteSite = jest.fn();
const mockReplaceSiteContent = jest.fn();
const mockExtendSite = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

jest.mock('server/lib/principal', () => ({
  resolvePrincipal: (...args: unknown[]) => mockResolvePrincipal(...args),
}));

jest.mock('server/services/apiToken', () => ({
  scopeSatisfies: (...args: unknown[]) => mockScopeSatisfies(...args),
}));

jest.mock('server/services/authRateLimit', () => ({
  checkApiKeyRateLimit: (...args: unknown[]) => mockCheckApiKeyRateLimit(...args),
}));

jest.mock('server/services/authAudit', () => ({
  recordAuthAuditEvent: (...args: unknown[]) => mockRecordAuthAuditEvent(...args),
}));

jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('server/services/sites', () => {
  class SitesServiceError extends Error {
    constructor(message: string, public statusCode = 500) {
      super(message);
      this.name = 'SitesServiceError';
    }
  }

  return {
    __esModule: true,
    SitesServiceError,
    default: jest.fn(() => ({
      listSites: (...args: unknown[]) => mockListSites(...args),
      createSite: (...args: unknown[]) => mockCreateSite(...args),
      getSite: (...args: unknown[]) => mockGetSite(...args),
      deleteSite: (...args: unknown[]) => mockDeleteSite(...args),
      replaceSiteContent: (...args: unknown[]) => mockReplaceSiteContent(...args),
      extendSite: (...args: unknown[]) => mockExtendSite(...args),
    })),
  };
});

import { SitesServiceError } from 'server/services/sites';
import { GET as listSites, POST as createSite } from './route';
import { DELETE as deleteSite, GET as getSite } from './[siteId]/route';
import { PUT as replaceContent } from './[siteId]/content/route';
import { POST as extendSite } from './[siteId]/extend/route';

const identity: NonNullable<Principal['identity']> = {
  userId: 'user-1',
  githubUsername: 'octocat',
  preferredUsername: 'octo',
  email: 'octo@example.com',
  firstName: 'Octo',
  lastName: 'Cat',
  displayName: 'Octo Cat',
  gitUserName: 'Octo Cat',
  gitUserEmail: 'octo@example.com',
  roles: ['user'],
};

const sessionPrincipal: Principal = {
  kind: 'user',
  authMethod: 'session',
  userId: 'user-1',
  actor: 'user-1',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity,
};

const serviceKeyPrincipal: Principal = {
  kind: 'service_key',
  authMethod: 'api_key',
  userId: null,
  actor: 'token:sites-ci',
  roles: [],
  scopes: [],
  tokenId: 42,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
};

const site = {
  id: 'docs-abc123',
  name: 'Docs',
  url: 'https://docs-abc123.sites.example.com',
  createdBy: 'octo@example.com',
};

function request(url: string, options: { method?: string; file?: unknown; name?: unknown } = {}): NextRequest {
  const values: Record<string, unknown> = {
    ...(options.file === undefined ? {} : { file: options.file }),
    ...(options.name === undefined ? {} : { name: options.name }),
  };
  return {
    method: options.method ?? 'GET',
    headers: new Headers([['x-request-id', 'req-sites']]),
    nextUrl: new URL(url),
    formData: jest.fn().mockResolvedValue({
      get: jest.fn((key: string) => values[key] ?? null),
    }),
  } as unknown as NextRequest;
}

const context = (siteId = 'docs-abc123') => ({ params: Promise.resolve({ siteId }) });

const uploadFile = (name = 'site.zip', bytes = new Uint8Array([80, 75, 3, 4])) => ({
  name,
  arrayBuffer: jest.fn().mockResolvedValue(bytes.buffer),
});

describe('hosted sites API routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvePrincipal.mockResolvedValue(sessionPrincipal);
    mockScopeSatisfies.mockImplementation((granted: string[], required: string) => granted.includes(required));
    mockCheckApiKeyRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mockRecordAuthAuditEvent.mockResolvedValue(undefined);
    mockListSites.mockResolvedValue({
      sites: [site],
      pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
    });
    mockCreateSite.mockResolvedValue(site);
    mockGetSite.mockResolvedValue(site);
    mockDeleteSite.mockResolvedValue({ ...site, deletedAt: '2026-08-27T00:00:00.000Z' });
    mockReplaceSiteContent.mockResolvedValue({ ...site, contentVersion: 2 });
    mockExtendSite.mockResolvedValue({ ...site, expiresAt: '2026-09-03T00:00:00.000Z' });
  });

  it.each([
    ['list', listSites, 'sites:read', undefined],
    ['create', createSite, 'sites:write', undefined],
    ['get', getSite, 'sites:read', context()],
    ['delete', deleteSite, 'sites:write', context()],
    ['replace content', replaceContent, 'sites:write', context()],
    ['extend', extendSite, 'sites:write', context()],
  ])('denies insufficient scope before the %s operation reaches the service', async (_label, handler, scope, ctx) => {
    mockResolvePrincipal.mockResolvedValue(serviceKeyPrincipal);

    const response = await handler(
      request('http://localhost/api/v2/sites/docs-abc123', { method: 'POST' }),
      ctx as never
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual(
      expect.objectContaining({ code: 'forbidden_scope', details: { requiredScope: scope, grantedScopes: [] } })
    );
    expect(mockScopeSatisfies).toHaveBeenCalledWith([], scope);
    expect(mockListSites).not.toHaveBeenCalled();
    expect(mockCreateSite).not.toHaveBeenCalled();
    expect(mockGetSite).not.toHaveBeenCalled();
    expect(mockDeleteSite).not.toHaveBeenCalled();
    expect(mockReplaceSiteContent).not.toHaveBeenCalled();
    expect(mockExtendSite).not.toHaveBeenCalled();
  });

  it('lists filtered sites with pagination metadata', async () => {
    const response = await listSites(
      request('http://localhost/api/v2/sites?user=%20octo%40example.com%20&page=2&limit=10')
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListSites).toHaveBeenCalledWith({ user: 'octo@example.com', page: 2, limit: 10 });
    expect(body.data).toEqual({ sites: [site] });
    expect(body.metadata).toEqual({ pagination: { page: 2, limit: 10, total: 21, totalPages: 3 } });
  });

  it('omits blank and invalid list filters instead of forwarding sentinel values', async () => {
    const response = await listSites(request('http://localhost/api/v2/sites?user=%20%20&page=nope&limit='));

    expect(response.status).toBe(200);
    expect(mockListSites).toHaveBeenCalledWith({});
  });

  it.each([
    ['hosting disabled', new SitesServiceError('Sites hosting is disabled.', 404), 404],
    ['unexpected storage failure', new Error('object store unavailable'), 500],
  ])('maps list failure: %s', async (_label, error, expectedStatus) => {
    mockListSites.mockRejectedValue(error);

    const response = await listSites(request('http://localhost/api/v2/sites'));

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.message).toBe(error.message);
  });

  it('creates a site from uploaded bytes and the authenticated identity', async () => {
    const file = uploadFile();

    const response = await createSite(request('http://localhost/api/v2/sites', { method: 'POST', file, name: 'Docs' }));

    expect(response.status).toBe(201);
    expect((await response.json()).data).toEqual({ site });
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(mockCreateSite).toHaveBeenCalledWith({
      fileName: 'site.zip',
      content: Buffer.from([80, 75, 3, 4]),
      name: 'Docs',
      user: identity,
    });
  });

  it('rejects a create request with no file before constructing site content', async () => {
    const response = await createSite(request('http://localhost/api/v2/sites', { method: 'POST' }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('A file upload is required.');
    expect(mockCreateSite).not.toHaveBeenCalled();
  });

  it('maps create service failures through the sites error contract', async () => {
    mockCreateSite.mockRejectedValue(new SitesServiceError('Upload is too large.', 400));

    const response = await createSite(request('http://localhost/api/v2/sites', { method: 'POST', file: uploadFile() }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('Upload is too large.');
  });

  it('gets a site by route id', async () => {
    const response = await getSite(request('http://localhost/api/v2/sites/docs-abc123'), context());

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ site });
    expect(mockGetSite).toHaveBeenCalledWith('docs-abc123');
  });

  it('deletes a site by route id and returns its tombstoned representation', async () => {
    const response = await deleteSite(
      request('http://localhost/api/v2/sites/docs-abc123', { method: 'DELETE' }),
      context()
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.site).toEqual(
      expect.objectContaining({ id: site.id, deletedAt: expect.any(String) })
    );
    expect(mockDeleteSite).toHaveBeenCalledWith('docs-abc123');
  });

  it.each([
    ['get', getSite, mockGetSite],
    ['delete', deleteSite, mockDeleteSite],
  ])('maps a missing site from %s to 404', async (_label, handler, service) => {
    service.mockRejectedValue(new SitesServiceError('Site not found.', 404));

    const response = await handler(request('http://localhost/api/v2/sites/missing'), context('missing'));

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('Site not found.');
  });

  it('replaces site content with uploaded bytes and the authenticated identity', async () => {
    const file = uploadFile('index.html', new TextEncoder().encode('<h1>Docs</h1>'));

    const response = await replaceContent(
      request('http://localhost/api/v2/sites/docs-abc123/content', { method: 'PUT', file }),
      context()
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.site).toEqual(expect.objectContaining({ id: site.id, contentVersion: 2 }));
    expect(mockReplaceSiteContent).toHaveBeenCalledWith('docs-abc123', {
      fileName: 'index.html',
      content: Buffer.from('<h1>Docs</h1>'),
      name: undefined,
      user: identity,
    });
  });

  it('rejects content replacement without an uploaded file', async () => {
    const response = await replaceContent(
      request('http://localhost/api/v2/sites/docs-abc123/content', { method: 'PUT' }),
      context()
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('A file upload is required.');
    expect(mockReplaceSiteContent).not.toHaveBeenCalled();
  });

  it('maps a content replacement service failure', async () => {
    mockReplaceSiteContent.mockRejectedValue(new SitesServiceError('Site not found.', 404));

    const response = await replaceContent(
      request('http://localhost/api/v2/sites/missing/content', { method: 'PUT', file: uploadFile() }),
      context('missing')
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('Site not found.');
  });

  it('extends a site by route id', async () => {
    const response = await extendSite(
      request('http://localhost/api/v2/sites/docs-abc123/extend', { method: 'POST' }),
      context()
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.site).toEqual(
      expect.objectContaining({ id: site.id, expiresAt: expect.any(String) })
    );
    expect(mockExtendSite).toHaveBeenCalledWith('docs-abc123');
  });

  it('maps an extension failure when TTL is disabled', async () => {
    mockExtendSite.mockRejectedValue(new SitesServiceError('TTL is disabled for hosted sites.', 400));

    const response = await extendSite(
      request('http://localhost/api/v2/sites/docs-abc123/extend', { method: 'POST' }),
      context()
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('TTL is disabled for hosted sites.');
  });
});
