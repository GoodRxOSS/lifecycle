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

import { Readable } from 'stream';

const mockGetAllConfigs = jest.fn();
const mockTokenState = { id: 7, kind: 'service', scopes: ['sites:write'], revokedAt: null as string | null };
jest.mock('server/models/ApiToken', () => ({
  __esModule: true,
  default: {
    query: () => ({
      findById: (id: number) => ({
        forShare() {
          return this;
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(id === mockTokenState.id ? mockTokenState : undefined).then(resolve);
        },
      }),
    }),
  },
}));
const mockAudit = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock('server/services/authAudit', () => ({
  recordAuthAuditEventInTransaction: (...args: unknown[]) => mockAudit(...args),
}));
const mockPutFiles = jest.fn();
const mockDeletePrefix = jest.fn();
const mockGetObject = jest.fn();
const mockValidateSiteUpload = jest.fn();
const mockNormalizeGatewayPath = jest.fn();
const mockCreateSiteId = jest.fn();
const mockCreateVersionId = jest.fn();
const mockWarn = jest.fn();
const mockError = jest.fn();
const mockInfo = jest.fn();
const mockDebug = jest.fn();

jest.mock('nanoid', () => ({
  customAlphabet: jest.fn((_alphabet: string, size: number) =>
    size === 10 ? () => mockCreateSiteId() : () => mockCreateVersionId()
  ),
}));

jest.mock('shared/config', () => ({
  QUEUE_NAMES: { SITES_CLEANUP: 'sites-cleanup' },
  OBJECT_STORE_ACCESS_KEY: 'minio',
  OBJECT_STORE_ENDPOINT: 'localhost',
  OBJECT_STORE_PORT: '9000',
  OBJECT_STORE_REGION: 'us-west-2',
  OBJECT_STORE_SECRET_KEY: 'minio',
  OBJECT_STORE_TYPE: 'minio',
  OBJECT_STORE_USE_SSL: 'false',
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    warn: mockWarn,
    error: mockError,
    info: mockInfo,
    debug: mockDebug,
  })),
}));

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: { registerQueue: jest.fn(() => ({ add: jest.fn() })) },
  redisClient: { getConnection: jest.fn(() => ({ duplicate: jest.fn() })) },
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
      getConfig: async () => ({ personalAuthEnabled: true, serviceAuthEnabled: true }),
    })),
  },
}));

jest.mock('server/lib/sites/storage', () => {
  class SitesObjectNotFoundError extends Error {
    statusCode = 404;
  }

  return {
    SitesObjectNotFoundError,
    SitesStorage: jest.fn(() => ({
      versionPrefix: (siteId: string, versionId: string) => `sites/${siteId}/versions/${versionId}`,
      putFiles: (...args: unknown[]) => mockPutFiles(...args),
      deletePrefix: (...args: unknown[]) => mockDeletePrefix(...args),
      getObject: (...args: unknown[]) => mockGetObject(...args),
    })),
  };
});

jest.mock('server/lib/sites/validation', () => {
  const actual = jest.requireActual('server/lib/sites/validation');
  return {
    ...actual,
    validateSiteUpload: (...args: unknown[]) => mockValidateSiteUpload(...args),
    normalizeGatewayPath: (...args: unknown[]) => mockNormalizeGatewayPath(...args),
  };
});

import type { Principal } from 'server/lib/principal';
const principal: Principal = {
  kind: 'user',
  authMethod: 'session',
  userId: 'owner',
  issuer: 'https://identity.example/realms/lifecycle',
  actor: 'owner',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
  oauth: { sessionId: 'session', tokenId: 'jwt', clientId: 'cli', expiresAt: 1e12 },
};
jest.mock('server/services/keycloak/principalStatus', () => ({
  getUserStatus: jest.fn(async () => 'active'),
  getUserSessionStatus: jest.fn(async () => 'active'),
  getOAuthTokenStatus: jest.fn(async () => 'active'),
}));
jest.mock('server/lib/verifiedOAuthBearer', () => ({ getVerifiedOAuthBearer: jest.fn(() => 'fixture-bearer') }));
jest.mock('server/lib/sites/browserAuth', () => ({
  ...jest.requireActual('server/lib/sites/browserAuth'),
}));
const originalSitesEnv = { ...process.env };
beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = principal.issuer!;
  process.env.LIFECYCLE_UI_URL = 'https://lifecycle.example.net';
});
afterEach(() => {
  process.env = { ...originalSitesEnv };
});

import SitesService, { SitesServiceError } from 'server/services/sites';
import { SitesObjectNotFoundError } from 'server/lib/sites/storage';
import { SiteUploadValidationError } from 'server/lib/sites/validation';

type SiteData = {
  visibility: 'private' | 'public';
  ownerKind: 'user' | 'service_key' | 'unresolved';
  ownerIssuer: string | null;
  ownerSubject: string | null;
  creatorTokenId: number | null;
  accessRevision: number;
  contentRevision: number;
  siteId: string;
  name: string;
  status: string;
  activeVersionId: string | null;
  fileCount: number | string;
  sizeBytes: number | string;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
};

type SiteRow = SiteData & {
  $query: jest.Mock;
};

type VersionData = {
  siteId: string;
  versionId: string;
  storagePrefix: string;
  entrypoint: string;
  fileCount: number;
  sizeBytes: number;
  manifest: Array<{ path: string; sizeBytes: number; contentType: string }>;
  deletedAt: string | null;
};

type VersionRow = VersionData & { $query: jest.Mock };

type FakeState = {
  sites: SiteRow[];
  versions: VersionRow[];
  siteInsertError?: unknown;
  versionInsertError?: unknown;
  sitePatchAndFetchError?: unknown;
  sitePatchError?: unknown;
};

const CREATED_AT = '2026-06-01T00:00:00.000Z';
const UPDATED_AT = '2026-06-02T00:00:00.000Z';

function siteData(row: SiteRow): SiteData {
  const { $query: _query, ...data } = row;
  return { ...data };
}

function attachSite(state: FakeState, data: SiteData): SiteRow {
  const row = { ...data } as SiteRow;
  row.$query = jest.fn(() => ({
    patchAndFetch: async (patch: Partial<SiteData>) => {
      if (state.sitePatchAndFetchError) throw state.sitePatchAndFetchError;
      Object.assign(row, patch, { updatedAt: UPDATED_AT });
      return row;
    },
    patch: async (patch: Partial<SiteData>) => {
      if (state.sitePatchError) throw state.sitePatchError;
      Object.assign(row, patch, { updatedAt: UPDATED_AT });
      return 1;
    },
  }));
  return row;
}

function addSite(state: FakeState, overrides: Partial<SiteData> = {}): SiteRow {
  const row = attachSite(state, {
    visibility: 'public',
    ownerKind: 'user',
    ownerIssuer: principal.issuer!,
    ownerSubject: principal.userId,
    creatorTokenId: null,
    accessRevision: 1,
    contentRevision: 1,
    siteId: 'site-1',
    name: 'site',
    status: 'active',
    activeVersionId: 'version-1',
    fileCount: 1,
    sizeBytes: 128,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: null,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ...overrides,
  });
  state.sites.push(row);
  return row;
}

function addVersion(state: FakeState, overrides: Partial<VersionData> = {}): VersionRow {
  const version = {
    siteId: 'site-1',
    versionId: 'version-1',
    storagePrefix: 'sites/site-1/versions/version-1',
    entrypoint: 'index.html',
    fileCount: 1,
    sizeBytes: 128,
    manifest: [{ path: 'index.html', sizeBytes: 128, contentType: 'text/html' }],
    deletedAt: null,
    ...overrides,
  };
  const row = version as VersionRow;
  row.$query = jest.fn(() => ({
    patch: async (patch: Partial<VersionData>) => {
      Object.assign(row, patch);
      return 1;
    },
  }));
  state.versions.push(row);
  return row;
}

class SiteQuery {
  private filters: Array<(row: SiteRow) => boolean> = [];
  private sortBy: { field: keyof SiteData; direction: string } | null = null;
  private single = false;
  private maximum?: number;

  constructor(private readonly state: FakeState) {}

  forUpdate() {
    return this;
  }
  orWhere(scope: Partial<SiteRow>) {
    const existing = [...this.filters];
    this.filters = [
      (row) =>
        existing.every((f) => f(row)) ||
        Object.entries(scope).every(([key, value]) => row[key as keyof SiteRow] === value),
    ];
    return this;
  }
  whereNull(field: keyof SiteData) {
    this.filters.push((row) => row[field] == null);
    return this;
  }

  whereNotNull(field: keyof SiteData) {
    this.filters.push((row) => row[field] != null);
    return this;
  }

  where(
    scopeOrField: Partial<SiteData> | keyof SiteData | ((query: SiteQuery) => unknown),
    operationOrValue?: unknown,
    expectedValue?: unknown
  ) {
    if (typeof scopeOrField === 'function') {
      const group = new SiteQuery(this.state);
      scopeOrField(group);
      this.filters.push((row) => group.filters.every((f) => f(row)));
      return this;
    }
    if (typeof scopeOrField === 'object') {
      this.filters.push((row) =>
        Object.entries(scopeOrField).every(([key, value]) => row[key as keyof SiteData] === value)
      );
      return this;
    }

    if (expectedValue !== undefined) {
      this.filters.push((row) => operationOrValue === '<=' && String(row[scopeOrField]) <= String(expectedValue));
    } else {
      this.filters.push((row) => row[scopeOrField] === operationOrValue);
    }
    return this;
  }

  whereRaw(sql: string, values: string[]) {
    if (sql.includes('createdBy') && sql.includes('updatedBy')) {
      const user = values[0];
      this.filters.push((row) => row.createdBy?.toLowerCase() === user || row.updatedBy?.toLowerCase() === user);
    }
    return this;
  }

  findOne(scope: Partial<SiteData>) {
    this.single = true;
    return this.where(scope);
  }

  orderBy(field: keyof SiteData, direction: string) {
    if (!this.sortBy) this.sortBy = { field, direction };
    return this;
  }

  limit(maximum: number) {
    this.maximum = maximum;
    return this;
  }

  async page(pageIndex: number, pageSize: number) {
    const rows = this.filteredRows();
    const start = pageIndex * pageSize;
    return { results: rows.slice(start, start + pageSize), total: rows.length };
  }

  async patch(patch: Partial<SiteData>) {
    const rows = this.filteredRows();
    rows.forEach((row) => Object.assign(row, patch));
    return rows.length;
  }
  async insert(input: Partial<SiteData>) {
    if (this.state.siteInsertError) throw this.state.siteInsertError;
    return addSite(this.state, {
      ...input,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      deletedAt: null,
    });
  }

  then(resolve: (value: SiteRow[] | SiteRow | undefined) => unknown, reject?: (reason: unknown) => unknown) {
    const rows = this.filteredRows();
    return Promise.resolve(this.single ? rows[0] : rows).then(resolve, reject);
  }

  private filteredRows() {
    let rows = this.state.sites.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.sortBy) {
      const sortBy = this.sortBy;
      rows = [...rows].sort((a, b) => {
        const compared = String(a[sortBy.field] || '').localeCompare(String(b[sortBy.field] || ''));
        return sortBy.direction === 'desc' ? -compared : compared;
      });
    }
    return this.maximum === undefined ? rows : rows.slice(0, this.maximum);
  }
}

class VersionQuery {
  private filters: Array<(row: VersionRow) => boolean> = [];
  private single = false;

  constructor(private readonly state: FakeState) {}

  whereRaw() {
    this.filters.push((version) => {
      const site = this.state.sites.find((site) => site.siteId === version.siteId);
      return Boolean(
        site && (['deleted', 'expired'].includes(site.status) || site.activeVersionId !== version.versionId)
      );
    });
    return this;
  }
  join() {
    return this;
  }
  select() {
    return this;
  }
  limit() {
    return this;
  }
  where(scope: Partial<VersionData>) {
    this.filters.push((row) => Object.entries(scope).every(([key, value]) => row[key as keyof VersionData] === value));
    return this;
  }

  whereNull(field: keyof VersionData | 'site_versions.deletedAt') {
    this.filters.push((row) => row[field === 'site_versions.deletedAt' ? 'deletedAt' : field] == null);
    return this;
  }

  whereIn(field: keyof VersionData | 'sites.status', values: unknown[]) {
    this.filters.push((row) =>
      values.includes(
        field === 'sites.status' ? this.state.sites.find((site) => site.siteId === row.siteId)?.status : row[field]
      )
    );
    return this;
  }

  findOne(scope: Partial<VersionData>) {
    this.single = true;
    return this.where(scope);
  }

  async insert(input: Omit<VersionData, 'deletedAt'>) {
    if (this.state.versionInsertError) throw this.state.versionInsertError;
    return addVersion(this.state, { ...input, deletedAt: null });
  }

  async patch(patch: Partial<VersionData>) {
    const rows = this.filteredRows();
    rows.forEach((row) => Object.assign(row, patch));
    return rows.length;
  }

  then(resolve: (value: VersionRow[] | VersionRow | undefined) => unknown, reject?: (reason: unknown) => unknown) {
    const rows = this.filteredRows();
    return Promise.resolve(this.single ? rows[0] : rows).then(resolve, reject);
  }

  private filteredRows() {
    return this.state.versions.filter((row) => this.filters.every((filter) => filter(row)));
  }
}

function createDatabase(state: FakeState) {
  const transaction = jest.fn(async (operation: (trx: object) => Promise<unknown>) => {
    const sitesBefore = state.sites.map(siteData);
    const versionsBefore = state.versions.map((version) => ({ ...version, manifest: [...version.manifest] }));
    try {
      return await operation({ transaction: true });
    } catch (error) {
      state.sites.splice(0, state.sites.length, ...sitesBefore.map((site) => attachSite(state, site)));
      state.versions.splice(0, state.versions.length, ...versionsBefore);
      throw error;
    }
  });
  const siteQuery = jest.fn(() => new SiteQuery(state));
  const versionQuery = jest.fn(() => new VersionQuery(state));
  return {
    models: {
      Site: { query: siteQuery, transact: transaction },
      SiteVersion: { query: versionQuery },
    },
  };
}

function enabledConfig(overrides: Record<string, unknown> = {}) {
  mockGetAllConfigs.mockResolvedValue({
    sites: {
      enabled: true,
      domain: 'sites.example.com',
      hostPrefix: 'site',
      ...overrides,
    },
  });
}

const validatedUpload = {
  files: [
    {
      path: 'index.html',
      content: Buffer.from('<h1>Hello</h1>'),
      sizeBytes: 14,
      contentType: 'text/html',
    },
  ],
  fileCount: 1,
  sizeBytes: 14,
  entrypoint: 'index.html',
};

describe('SitesService behavior', () => {
  let state: FakeState;
  let database: ReturnType<typeof createDatabase>;
  let queueAdd: jest.Mock;
  let queueManager: { registerQueue: jest.Mock };
  let service: SitesService;

  beforeEach(() => {
    state = { sites: [], versions: [] };
    mockAudit.mockReset().mockResolvedValue(undefined);
    mockTokenState.revokedAt = null;
    database = createDatabase(state);
    queueAdd = jest.fn();
    queueManager = { registerQueue: jest.fn(() => ({ add: queueAdd })) };
    mockGetAllConfigs.mockReset();
    enabledConfig();
    mockCreateSiteId.mockReset().mockReturnValue('site000001');
    mockCreateVersionId.mockReset().mockReturnValue('version00001');
    mockPutFiles.mockReset().mockResolvedValue(undefined);
    mockDeletePrefix.mockReset().mockResolvedValue(undefined);
    mockGetObject.mockReset();
    mockValidateSiteUpload.mockReset().mockReturnValue(validatedUpload);
    mockNormalizeGatewayPath.mockReset().mockImplementation((pathname: string) => pathname.replace(/^\/+/, ''));
    mockWarn.mockReset();
    mockError.mockReset();
    mockInfo.mockReset();
    mockDebug.mockReset();
    service = new SitesService(database as any, {} as any, {} as any, queueManager as any);
  });

  afterEach(() => {
    if (jest.isMockFunction(Date.now)) (Date.now as jest.Mock).mockRestore();
    if (jest.isMockFunction(Date.prototype.toISOString)) {
      (Date.prototype.toISOString as jest.Mock).mockRestore();
    }
  });

  it('defaults service errors to an internal-error status', () => {
    expect(new SitesServiceError('unexpected')).toMatchObject({ message: 'unexpected', statusCode: 500 });
  });

  it('fails closed when Sites is disabled without touching validation, storage, or the database', async () => {
    mockGetAllConfigs.mockResolvedValue({ sites: { enabled: false } });

    await expect(
      service.createSite({ principal, visibility: 'public', fileName: 'index.html', content: Buffer.from('site') })
    ).rejects.toMatchObject({
      message: 'Sites hosting is disabled.',
      statusCode: 404,
    });
    expect(mockValidateSiteUpload).not.toHaveBeenCalled();
    expect(mockPutFiles).not.toHaveBeenCalled();
    expect(database.models.Site.query).not.toHaveBeenCalled();
  });

  describe('createSite', () => {
    it('uploads a version and commits an attributed, expiring site', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-10T00:00:00.000Z'));

      await expect(
        service.createSite({
          principal: { ...principal, identity: { email: 'author@example.com' } as any },
          visibility: 'public',
          fileName: 'docs.html',
          content: Buffer.from('source upload'),
          name: '  Product docs  ',
          user: { email: 'author@example.com' } as any,
        })
      ).resolves.toMatchObject({
        id: 'site000001',
        name: 'Product docs',
        url: 'https://site-site000001.sites.example.com',
        status: 'active',
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        expiresAt: '2026-06-17T00:00:00.000Z',
        fileCount: 1,
        sizeBytes: 14,
        createdBy: 'author@example.com',
        updatedBy: 'author@example.com',
      });

      expect(mockValidateSiteUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: 'docs.html',
          content: Buffer.from('source upload'),
          maxUploadBytes: 10 * 1024 * 1024,
          maxExtractedBytes: 10 * 1024 * 1024,
          maxFiles: 500,
        })
      );
      expect(mockPutFiles).toHaveBeenCalledWith('sites/site000001/versions/version00001', validatedUpload.files);
      expect(state.sites.map(siteData)).toEqual([
        expect.objectContaining({
          siteId: 'site000001',
          name: 'Product docs',
          activeVersionId: 'version00001',
          expiresAt: '2026-06-17T00:00:00.000Z',
          createdBy: 'author@example.com',
          updatedBy: 'author@example.com',
        }),
      ]);
      expect(state.versions).toEqual([
        expect.objectContaining({
          siteId: 'site000001',
          versionId: 'version00001',
          storagePrefix: 'sites/site000001/versions/version00001',
          entrypoint: 'index.html',
          fileCount: 1,
          sizeBytes: 14,
          manifest: [{ path: 'index.html', sizeBytes: 14, contentType: 'text/html' }],
        }),
      ]);
      now.mockRestore();
    });

    it('uses the generated default name and no expiry or actor when TTL is disabled', async () => {
      enabledConfig({ ttl: { enabled: false } });

      const result = await service.createSite({
        principal,
        visibility: 'public',
        fileName: 'index.html',
        content: Buffer.from('site'),
        name: '   ',
      });

      expect(result).toMatchObject({
        id: 'site000001',
        name: 'site-site000001',
        expiresAt: null,
        createdBy: null,
        updatedBy: null,
      });
      expect(state.sites[0]).toMatchObject({ name: 'site-site000001', expiresAt: null });
    });

    it('turns upload validation failures into the service error contract before persistence', async () => {
      mockValidateSiteUpload.mockImplementationOnce(() => {
        throw new SiteUploadValidationError('Only HTML uploads are supported.');
      });

      await expect(
        service.createSite({ principal, visibility: 'public', fileName: 'site.exe', content: Buffer.from('bad') })
      ).rejects.toMatchObject({
        message: 'Only HTML uploads are supported.',
        statusCode: 400,
      });
      expect(database.models.Site.transact).not.toHaveBeenCalled();
      expect(mockPutFiles).not.toHaveBeenCalled();
    });

    it('does not disguise an unexpected validation failure', async () => {
      const unexpected = new Error('validator crashed');
      mockValidateSiteUpload.mockImplementationOnce(() => {
        throw unexpected;
      });

      await expect(
        service.createSite({ principal, visibility: 'public', fileName: 'site.html', content: Buffer.from('site') })
      ).rejects.toBe(unexpected);
      expect(database.models.Site.transact).not.toHaveBeenCalled();
    });

    it('removes uploaded objects when version persistence fails and leaves no database rows', async () => {
      const insertError = new Error('version insert failed');
      state.versionInsertError = insertError;

      await expect(
        service.createSite({ principal, visibility: 'public', fileName: 'site.html', content: Buffer.from('site') })
      ).rejects.toBe(insertError);

      expect(mockDeletePrefix).toHaveBeenCalledWith('sites/site000001/versions/version00001');
      expect(state.sites).toEqual([]);
      expect(state.versions).toEqual([]);
    });

    it('preserves the original upload failure when rollback cleanup also fails', async () => {
      const uploadError = new Error('upload failed');
      const cleanupError = new Error('cleanup failed');
      mockPutFiles.mockRejectedValueOnce(uploadError);
      mockDeletePrefix.mockRejectedValueOnce(cleanupError);

      await expect(
        service.createSite({ principal, visibility: 'public', fileName: 'site.html', content: Buffer.from('site') })
      ).rejects.toBe(uploadError);

      expect(state.sites).toEqual([]);
      expect(mockWarn).toHaveBeenCalledWith(
        { error: cleanupError, storagePrefix: 'sites/site000001/versions/version00001' },
        'Sites: failed to clean up uploaded prefix after error'
      );
    });
  });

  describe('listing and lookup', () => {
    it('normalizes invalid pagination and caps a fractional oversized limit', async () => {
      for (let index = 0; index < 105; index++) {
        addSite(state, { siteId: `site-${String(index).padStart(3, '0')}`, updatedAt: `2026-06-${index}` });
      }

      const defaults = await service.listSites({ page: Number.NaN, limit: -1 }, principal);
      const capped = await service.listSites({ page: 1.9, limit: 101.8 }, principal);

      expect(defaults.pagination).toEqual({ current: 1, total: 5, items: 105, limit: 25 });
      expect(defaults.sites).toHaveLength(25);
      expect(capped.pagination).toEqual({ current: 1, total: 2, items: 105, limit: 100 });
      expect(capped.sites).toHaveLength(100);
    });

    it('returns the full public shape and normalizes nullable and numeric database values', async () => {
      addSite(state, {
        siteId: 'site-nullables',
        name: 'Nullable row',
        fileCount: '2',
        sizeBytes: '64',
        createdAt: null,
        updatedAt: null,
        createdBy: '',
        updatedBy: '',
      });

      await expect(service.getSite('site-nullables', principal)).resolves.toMatchObject({
        id: 'site-nullables',
        name: 'Nullable row',
        url: 'https://site-site-nullables.sites.example.com',
        status: 'active',
        createdAt: null,
        updatedAt: null,
        expiresAt: null,
        fileCount: 2,
        sizeBytes: 64,
        createdBy: null,
        updatedBy: null,
      });
    });

    it('returns not found for a missing or soft-deleted site', async () => {
      addSite(state, { siteId: 'deleted', deletedAt: UPDATED_AT });

      await expect(service.getSite('missing', principal)).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
      await expect(service.getSite('deleted', principal)).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
    });

    it('does not classify an invalid expiry timestamp as elapsed', async () => {
      addSite(state, { expiresAt: 'not-a-date' });

      await expect(service.getSite('site-1', principal)).resolves.toMatchObject({
        status: 'active',
        expiresAt: 'not-a-date',
      });
    });

    it('reports zero counters for a new empty site record', async () => {
      addSite(state, { fileCount: 0, sizeBytes: 0 });

      await expect(service.getSite('site-1', principal)).resolves.toMatchObject({ fileCount: 0, sizeBytes: 0 });
    });
  });

  describe('replaceSiteContent', () => {
    it.each([
      ['missing site', undefined],
      ['non-active site', { status: 'deleted' }],
      ['site without an active version', { activeVersionId: null }],
      ['expired site', { expiresAt: '2020-01-01T00:00:00.000Z' }],
    ])('rejects a %s before validating or uploading', async (_case, overrides) => {
      if (overrides) addSite(state, overrides);

      await expect(
        service.replaceSiteContent('site-1', { principal, fileName: 'site.html', content: Buffer.from('site') })
      ).rejects.toMatchObject({ message: 'Site not found.', statusCode: 404 });
      expect(mockValidateSiteUpload).not.toHaveBeenCalled();
      expect(mockPutFiles).not.toHaveBeenCalled();
    });

    it('activates the new version and cleans up each prior version independently', async () => {
      const site = addSite(state, { updatedBy: 'previous@example.com' });
      addVersion(state, { versionId: 'old-1', storagePrefix: 'prefix/old-1' });
      addVersion(state, { versionId: 'old-2', storagePrefix: 'prefix/old-2' });
      const cleanupError = new Error('object store unavailable');
      mockDeletePrefix.mockImplementation(async (prefix: string) => {
        if (prefix === 'prefix/old-2') throw cleanupError;
      });

      const result = await service.replaceSiteContent('site-1', {
        principal,
        fileName: 'replacement.html',
        content: Buffer.from('replacement'),
      });

      expect(result).toMatchObject({
        id: 'site-1',
        fileCount: 1,
        sizeBytes: 14,
        updatedBy: null,
      });
      expect(site.activeVersionId).toBe('version00001');
      expect(state.versions.find((version) => version.versionId === 'old-1')?.deletedAt).toEqual(expect.any(String));
      expect(state.versions.find((version) => version.versionId === 'old-2')?.deletedAt).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        {
          error: cleanupError,
          siteId: 'site-1',
          versionId: 'old-2',
          storagePrefix: 'prefix/old-2',
        },
        'Sites: version cleanup deferred'
      );
    });

    it('attributes a replacement to the supplied user', async () => {
      addSite(state, { updatedBy: null });

      const result = await service.replaceSiteContent('site-1', {
        principal: { ...principal, identity: { email: 'editor@example.com' } as any },
        fileName: 'replacement.html',
        content: Buffer.from('replacement'),
      });

      expect(result.updatedBy).toBe('editor@example.com');
      expect(state.sites[0].updatedBy).toBe('editor@example.com');
    });

    it('keeps a null updater and succeeds when no historical version row exists', async () => {
      addSite(state, { updatedBy: null });

      const result = await service.replaceSiteContent('site-1', {
        principal,
        fileName: 'replacement.html',
        content: Buffer.from('replacement'),
      });

      expect(result.updatedBy).toBeNull();
      expect(state.versions).toHaveLength(1);
      expect(mockDeletePrefix).not.toHaveBeenCalled();
    });

    it('removes the new upload and preserves the active version when replacement persistence fails', async () => {
      addSite(state, { activeVersionId: 'version-1' });
      addVersion(state, { versionId: 'version-1', storagePrefix: 'prefix/version-1' });
      const patchError = new Error('site update failed');
      state.sitePatchAndFetchError = patchError;

      await expect(
        service.replaceSiteContent('site-1', {
          principal,
          fileName: 'replacement.html',
          content: Buffer.from('replacement'),
        })
      ).rejects.toBe(patchError);

      expect(mockDeletePrefix).toHaveBeenCalledWith('sites/site-1/versions/version00001');
      expect(mockDeletePrefix).not.toHaveBeenCalledWith('prefix/version-1');
      expect(state.sites).toHaveLength(1);
      expect(state.sites[0].activeVersionId).toBe('version-1');
      expect(state.versions).toEqual([
        expect.objectContaining({ versionId: 'version-1', storagePrefix: 'prefix/version-1', deletedAt: null }),
      ]);
    });
  });

  describe('extendSite', () => {
    it('extends from an existing future expiry', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-10T00:00:00.000Z'));
      addSite(state, { expiresAt: '2026-06-20T00:00:00.000Z' });

      const result = await service.extendSite('site-1', principal);

      expect(result.expiresAt).toBe('2026-06-27T00:00:00.000Z');
      expect(state.sites[0].expiresAt).toBe('2026-06-27T00:00:00.000Z');
      now.mockRestore();
    });

    it('extends a site without an expiry from the current time', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-10T00:00:00.000Z'));
      addSite(state, { expiresAt: null });

      await expect(service.extendSite('site-1', principal)).resolves.toMatchObject({
        expiresAt: '2026-06-17T00:00:00.000Z',
      });
      now.mockRestore();
    });

    it('rejects extension when TTL is disabled', async () => {
      enabledConfig({ ttl: { enabled: false } });
      addSite(state, { expiresAt: null });

      await expect(service.extendSite('site-1', principal)).rejects.toMatchObject({
        message: 'TTL is disabled for hosted sites.',
        statusCode: 400,
      });
    });
  });

  describe('deleteSite', () => {
    it('tombstones the site before cleaning remaining versions', async () => {
      addSite(state);
      addVersion(state, { versionId: 'version-1', storagePrefix: 'prefix/version-1' });
      addVersion(state, { versionId: 'version-2', storagePrefix: 'prefix/version-2', deletedAt: CREATED_AT });

      const result = await service.deleteSite('site-1', principal);

      expect(mockDeletePrefix.mock.calls).toEqual([['prefix/version-1']]);
      expect(result).toMatchObject({ id: 'site-1', status: 'deleted' });
      expect(state.sites[0]).toMatchObject({ status: 'deleted', deletedAt: expect.any(String) });
      expect(state.versions[0].deletedAt).not.toBeNull();
      expect(state.versions[1].deletedAt).toBe(CREATED_AT);
    });

    it('returns not found without touching storage for an unknown site', async () => {
      await expect(service.deleteSite('missing', principal)).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
      expect(mockDeletePrefix).not.toHaveBeenCalled();
    });

    it('keeps access tombstoned and leaves storage for retry when cleanup fails', async () => {
      const site = addSite(state);
      const version = addVersion(state, { storagePrefix: 'prefix/version-1' });
      const deleteError = new Error('delete failed');
      mockDeletePrefix.mockRejectedValueOnce(deleteError);

      await expect(service.deleteSite('site-1', principal)).resolves.toMatchObject({ status: 'deleted' });
      expect(site.status).toBe('deleted');
      expect(site.deletedAt).not.toBeNull();
      expect(version.deletedAt).toBeNull();
    });
  });

  describe('gateway behavior', () => {
    it('serves the configured entrypoint for the root path', async () => {
      addSite(state);
      addVersion(state, { entrypoint: 'home.html', storagePrefix: 'prefix/current' });
      const body = Readable.from('home');
      mockGetObject.mockResolvedValue({ body, contentType: 'text/custom', contentLength: 4 });

      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/')).resolves.toEqual({
        body,
        contentType: 'text/custom',
        contentLength: 4,
        statusCode: 200,
      });
      expect(mockGetObject).toHaveBeenCalledWith('prefix/current', 'home.html');
      expect(mockNormalizeGatewayPath).not.toHaveBeenCalled();
    });

    it('falls back to index.html for an empty path and missing version entrypoint', async () => {
      addSite(state);
      addVersion(state, { entrypoint: '' });
      mockGetObject.mockResolvedValue({ body: Readable.from('home'), contentType: 'text/html' });

      await service.getGatewayObject('site-site-1.sites.example.com', '');

      expect(mockGetObject).toHaveBeenCalledWith('sites/site-1/versions/version-1', 'index.html');
    });

    it('normalizes a nested path and infers content type when storage metadata is blank', async () => {
      addSite(state);
      addVersion(state);
      const body = Readable.from('body {}');
      mockGetObject.mockResolvedValue({ body, contentType: '', contentLength: undefined });

      await expect(service.getGatewayObject('SITE-site-1.SITES.EXAMPLE.COM:443', '/assets/app.css')).resolves.toEqual({
        body,
        contentType: 'text/css; charset=utf-8',
        contentLength: undefined,
        statusCode: 200,
      });
      expect(mockNormalizeGatewayPath).toHaveBeenCalledWith('/assets/app.css');
      expect(mockGetObject).toHaveBeenCalledWith('sites/site-1/versions/version-1', 'assets/app.css');
    });

    it('returns not found for an unrelated host before database or storage lookup', async () => {
      await expect(service.getGatewayObject('example.com', '/')).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
      expect(database.models.Site.query).not.toHaveBeenCalled();
      expect(mockGetObject).not.toHaveBeenCalled();
    });

    it('returns not found when the active version row is missing', async () => {
      addSite(state);

      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/')).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
      expect(mockGetObject).not.toHaveBeenCalled();
    });

    it.each([
      ['an upload path error', () => new SiteUploadValidationError('invalid path')],
      ['a malformed URI', () => new URIError('malformed URI')],
    ])('hides %s as not found', async (_case, createError) => {
      addSite(state);
      addVersion(state);
      mockNormalizeGatewayPath.mockImplementationOnce(() => {
        throw createError();
      });

      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/bad-path')).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
      expect(mockGetObject).not.toHaveBeenCalled();
    });

    it('does not disguise an unexpected path-normalization failure', async () => {
      addSite(state);
      addVersion(state);
      const unexpected = new Error('normalizer crashed');
      mockNormalizeGatewayPath.mockImplementationOnce(() => {
        throw unexpected;
      });

      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/bad-path')).rejects.toBe(unexpected);
    });

    it('normalizes a missing object to the gateway not-found contract', async () => {
      addSite(state);
      addVersion(state);
      mockGetObject.mockRejectedValueOnce(new SitesObjectNotFoundError('missing'));

      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/missing.css')).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
    });

    it('does not hide an object-store outage', async () => {
      addSite(state);
      addVersion(state);
      const outage = new Error('object store unavailable');
      mockGetObject.mockRejectedValueOnce(outage);

      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/index.html')).rejects.toBe(outage);
    });

    it('intercepts the configured namespace, including unknown hosts', async () => {
      await expect(service.matchesGatewayHost('site-abc123.sites.example.com')).resolves.toBe(true);
      await expect(service.matchesGatewayHost('other-abc123.sites.example.com')).resolves.toBe(true);
      await expect(service.matchesGatewayHost(undefined)).resolves.toBe(false);

      mockGetAllConfigs.mockResolvedValue({ sites: { enabled: false } });
      await expect(service.matchesGatewayHost('site-abc123.sites.example.com')).resolves.toBe(false);
    });
  });

  describe('expiration cleanup', () => {
    it.each([
      ['Sites is disabled', { enabled: false }],
      ['cleanup is disabled', { enabled: true, ttl: { enabled: true }, cleanup: { enabled: false } }],
    ])('does no work when %s', async (_case, sites) => {
      mockGetAllConfigs.mockResolvedValue({ sites });

      await expect(service.cleanupExpiredSites()).resolves.toEqual({ expired: 0, cleaned: 0, errors: 0 });
      expect(database.models.Site.query).not.toHaveBeenCalled();
      expect(mockDeletePrefix).not.toHaveBeenCalled();
    });

    it('cleans eligible sites, continues after a per-site failure, and reports exact counts', async () => {
      const toISOString = jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-06-10T00:00:00.000Z');
      const cleanedSite = addSite(state, {
        siteId: 'expired-cleaned',
        activeVersionId: 'cleaned-version',
        expiresAt: '2026-06-01T00:00:00.000Z',
      });
      const failedSite = addSite(state, {
        siteId: 'expired-failed',
        activeVersionId: 'failed-version',
        expiresAt: '2026-06-02T00:00:00.000Z',
      });
      addSite(state, { siteId: 'future', expiresAt: '2026-07-01T00:00:00.000Z' });
      addSite(state, { siteId: 'no-expiry', expiresAt: null });
      addSite(state, { siteId: 'already-expired', status: 'expired', expiresAt: '2026-05-01T00:00:00.000Z' });
      addSite(state, { siteId: 'deleted', expiresAt: '2026-05-01T00:00:00.000Z', deletedAt: CREATED_AT });
      const cleanedVersion = addVersion(state, {
        siteId: 'expired-cleaned',
        versionId: 'cleaned-version',
        storagePrefix: 'prefix/cleaned',
      });
      const failedVersion = addVersion(state, {
        siteId: 'expired-failed',
        versionId: 'failed-version',
        storagePrefix: 'prefix/failed',
      });
      const cleanupError = new Error('delete failed');
      mockDeletePrefix.mockImplementation(async (prefix: string) => {
        if (prefix === 'prefix/failed') throw cleanupError;
      });

      await expect(service.cleanupExpiredSites()).resolves.toEqual({ expired: 2, cleaned: 1, errors: 1 });
      expect(cleanedSite).toMatchObject({ status: 'expired', deletedAt: '2026-06-10T00:00:00.000Z' });
      expect(cleanedVersion.deletedAt).toBe('2026-06-10T00:00:00.000Z');
      expect(failedSite).toMatchObject({ status: 'expired', deletedAt: '2026-06-10T00:00:00.000Z' });
      expect(failedVersion.deletedAt).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        { error: cleanupError, siteId: 'expired-failed' },
        'Sites: terminal storage cleanup deferred'
      );
      toISOString.mockRestore();
    });

    it('retries superseded storage cleanup even while the active site has no expiry', async () => {
      enabledConfig({ ttl: { enabled: false } });
      addSite(state);
      addVersion(state);
      mockDeletePrefix.mockRejectedValueOnce(new Error('storage unavailable'));
      await service.replaceSiteContent('site-1', { principal, fileName: 'index.html', content: Buffer.from('new') });
      expect(state.versions[0].deletedAt).toBeNull();
      await expect(service.cleanupExpiredSites()).resolves.toEqual({ expired: 0, cleaned: 1, errors: 0 });
      expect(state.versions[0].deletedAt).not.toBeNull();
      expect(state.versions[1].deletedAt).toBeNull();
    });

    it('returns zero counts when no active site has elapsed', async () => {
      addSite(state, { expiresAt: '2099-01-01T00:00:00.000Z' });

      await expect(service.cleanupExpiredSites()).resolves.toEqual({ expired: 0, cleaned: 0, errors: 0 });
      expect(mockDeletePrefix).not.toHaveBeenCalled();
    });
  });

  describe('V1 access enforcement', () => {
    const stranger = { ...principal, userId: 'stranger', actor: 'stranger', roles: ['admin'] } as Principal;
    it('creates user sites private by default with stable issuer ownership', async () => {
      const result = await service.createSite({ principal, fileName: 'index.html', content: Buffer.from('site') });
      expect(result).toMatchObject({
        visibility: 'private',
        currentRole: 'owner',
        accessRevision: 1,
        contentRevision: 1,
        permissions: { canEdit: true },
      });
      expect(result.url).toBe('https://site-site000001.sites.example.com');
      expect(result.openUrl).toBe('https://lifecycle.example.net/sites/open/site000001');
      expect(state.sites[0]).toMatchObject({ ownerKind: 'user', ownerSubject: 'owner', ownerIssuer: principal.issuer });
    });
    it('creates public service-key sites and binds writes to that token only', async () => {
      const machine = {
        ...principal,
        kind: 'service_key',
        userId: null,
        issuer: null,
        tokenId: 7,
        scopes: ['sites:write'],
      } as Principal;
      const result = await service.createSite({
        principal: machine,
        fileName: 'index.html',
        content: Buffer.from('site'),
      });
      expect(result).toMatchObject({
        visibility: 'public',
        currentRole: 'owner',
        permissions: { canEdit: true, canChangeVisibility: false },
      });
      expect(state.sites[0]).toMatchObject({
        ownerKind: 'service_key',
        creatorTokenId: 7,
        ownerSubject: null,
        ownerIssuer: null,
      });
      await expect(service.deleteSite(result.id, principal)).rejects.toMatchObject({ httpStatus: 404 });
      await expect(
        service.createSite({
          principal: machine,
          visibility: 'private',
          fileName: 'index.html',
          content: Buffer.from('site'),
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });
    it('does not commit a machine upload if its token was revoked during storage staging', async () => {
      const machine = {
        ...principal,
        kind: 'service_key',
        userId: null,
        issuer: null,
        tokenId: 7,
        scopes: ['sites:write'],
      } as Principal;
      mockPutFiles.mockImplementationOnce(async () => {
        mockTokenState.revokedAt = new Date().toISOString();
      });
      await expect(
        service.createSite({ principal: machine, fileName: 'index.html', content: Buffer.from('site') })
      ).rejects.toMatchObject({ code: 'invalid_credential' });
      expect(state.sites).toHaveLength(0);
      expect(mockDeletePrefix).toHaveBeenCalled();
    });
    it('commits visibility audit with the mutation and rolls back if auditing fails', async () => {
      addSite(state);
      mockAudit.mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(service.setVisibility('site-1', 'private', principal, 1)).rejects.toThrow('audit unavailable');
      expect(state.sites[0].visibility).toBe('public');
      await service.setVisibility('site-1', 'private', principal, 1);
      expect(mockAudit).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'sites.visibility_changed',
          meta: expect.objectContaining({ siteId: 'site-1', from: 'public', to: 'private' }),
        })
      );
    });
    it('advertises no uploads while the existing Sites setting is disabled', async () => {
      mockGetAllConfigs.mockResolvedValue({ sites: { enabled: false } });
      await expect(service.getCapabilities(principal)).resolves.toMatchObject({
        defaultVisibility: 'private',
        canCreate: false,
        allowedVisibilities: [],
      });
    });
    it('denies public and private gateway reads when the existing Sites setting is disabled', async () => {
      addSite(state, { siteId: 'private', visibility: 'private' });
      addSite(state, { siteId: 'public', visibility: 'public' });
      mockGetAllConfigs.mockResolvedValue({ sites: { enabled: false, domain: 'sites.example.com' } });
      for (const id of ['private', 'public']) {
        const host = `site-${id}.sites.example.com`;
        await expect(service.getGatewaySite(host)).rejects.toMatchObject({ statusCode: 404 });
        await expect(service.getGatewayLocator(host)).rejects.toMatchObject({ statusCode: 404 });
        await expect(service.getGatewayObject(host, '/index.html', async () => {})).rejects.toMatchObject({
          statusCode: 404,
        });
      }
      expect(mockGetObject).not.toHaveBeenCalled();
    });
    it('resolves valid missing host locators without a database Site for the anonymous bootstrap', async () => {
      await expect(service.getGatewayLocator('site-missing.sites.example.com')).resolves.toEqual({ siteId: 'missing' });
      await expect(service.getGatewayLocator('site-missing.sites.example.com:443')).resolves.toEqual({
        siteId: 'missing',
      });
      await expect(service.getGatewayLocator('site-missing--g-abcdef012345.sites.example.com')).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(service.getGatewayLocator('site-missing.sites.example.com:9443')).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(service.getGatewayLocator('site-missing.other.example.com')).rejects.toMatchObject({
        statusCode: 404,
      });
    });
    it.each([undefined, 'public'] as const)(
      'refuses human creation (%s) before storage if the existing Sites setting is disabled',
      async (visibility) => {
        mockGetAllConfigs.mockResolvedValue({ sites: { enabled: false } });
        await expect(
          service.createSite({ principal, visibility, fileName: 'index.html', content: Buffer.from('site') })
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(mockPutFiles).not.toHaveBeenCalled();
      }
    );
    it('returns the same missing/private deletion error contract to a nonowner', async () => {
      addSite(state, { visibility: 'private', ownerSubject: 'other' });
      const errors = [];
      for (const id of ['site-1', 'missing']) {
        try {
          await service.deleteSite(id, principal, 1);
        } catch (error) {
          errors.push({
            message: (error as Error).message,
            code: (error as { code?: string }).code,
            status: (error as { httpStatus?: number }).httpStatus,
          });
        }
      }
      expect(errors).toHaveLength(2);
      expect(errors[0]).toEqual(errors[1]);
      expect(errors[0]).toEqual({ message: 'Site not found.', code: 'site_not_found', status: 404 });
    });
    it('filters unauthorized private rows before page totals and shows public creator attribution', async () => {
      addSite(state, { siteId: 'secret', visibility: 'private', ownerSubject: 'other' });
      addSite(state, { siteId: 'public', ownerSubject: 'other', createdBy: 'private-email@example.com' });
      addSite(state, { siteId: 'mine', visibility: 'private' });
      const result = await service.listSites({}, principal);
      expect(result.pagination.items).toBe(2);
      expect(result.sites.map((site) => site.id).sort()).toEqual(['mine', 'public']);
      expect(result.sites.find((site) => site.id === 'public')).toMatchObject({
        createdBy: 'private-email@example.com',
        updatedBy: null,
        currentRole: null,
        permissions: { canEdit: false },
      });
      const mine = await service.listSites({ view: 'mine' }, principal);
      expect(mine.sites.map((site) => site.id)).toEqual(['mine']);
    });
    it('denies all nonowner mutations including realm admins before storage', async () => {
      addSite(state, { visibility: 'private' });
      await expect(service.getSite('site-1', stranger)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        service.replaceSiteContent('site-1', {
          principal: stranger,
          fileName: 'index.html',
          content: Buffer.from('bad'),
        })
      ).rejects.toMatchObject({ httpStatus: 403 });
      await expect(service.extendSite('site-1', stranger)).rejects.toMatchObject({ httpStatus: 403 });
      await expect(service.setVisibility('site-1', 'public', stranger, 1)).rejects.toMatchObject({ httpStatus: 403 });
      await expect(service.deleteSite('site-1', stranger)).rejects.toMatchObject({ httpStatus: 403 });
      expect(mockPutFiles).not.toHaveBeenCalled();
      expect(mockDeletePrefix).not.toHaveBeenCalled();
    });
    it('requires a gateway authorizer for every private object before any storage call', async () => {
      addSite(state, { visibility: 'private' });
      addVersion(state);
      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/')).rejects.toMatchObject({
        statusCode: 404,
      });
      const authorize = jest.fn(async () => {
        throw new Error('denied');
      });
      await expect(service.getGatewayObject('site-site-1.sites.example.com', '/asset.css', authorize)).rejects.toThrow(
        'denied'
      );
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(mockGetObject).not.toHaveBeenCalled();
    });
    it('keeps the content URL and Site ID while changing visibility', async () => {
      addSite(state);
      addVersion(state);
      const hidden = await service.setVisibility('site-1', 'private', principal, 1);
      expect(hidden.url).toBe('https://site-site-1.sites.example.com');
      expect(hidden.openUrl).toBe('https://lifecycle.example.net/sites/open/site-1');
      await expect(service.getGatewaySite('site-site-1.sites.example.com')).resolves.toMatchObject({
        site: expect.objectContaining({ visibility: 'private' }),
      });
      const published = await service.setVisibility('site-1', 'public', principal, 2);
      expect(published.url).toBe(hidden.url);
      expect(published.openUrl).toBe(hidden.openUrl);
    });
    it('rejects a stale visibility revision without modifying the site', async () => {
      const row = addSite(state);
      await expect(service.setVisibility('site-1', 'private', principal, 2)).rejects.toMatchObject({
        code: 'site_changed',
      });
      expect(state.sites[0].visibility).toBe(row.visibility);
    });
    it('does not resurrect content deleted while its replacement uploads', async () => {
      addSite(state);
      addVersion(state);
      mockPutFiles.mockImplementationOnce(async () => {
        await service.deleteSite('site-1', principal);
      });
      await expect(
        service.replaceSiteContent('site-1', { principal, fileName: 'index.html', content: Buffer.from('replacement') })
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(state.sites[0].status).toBe('deleted');
      expect(mockDeletePrefix).toHaveBeenCalledWith('sites/site-1/versions/version00001');
    });
    it('rejects publishing or deleting content replaced since the owner prepared the action', async () => {
      addSite(state, { visibility: 'private' });
      addVersion(state);
      const before = await service.getSite('site-1', principal);
      const replaced = await service.replaceSiteContent('site-1', {
        principal,
        fileName: 'index.html',
        content: Buffer.from('new private content'),
        expectedAccessRevision: before.accessRevision,
        expectedContentRevision: before.contentRevision,
      });
      expect(replaced).toMatchObject({ visibility: 'private', accessRevision: 2, contentRevision: 2 });
      expect(replaced.url).toBe(before.url);
      await expect(service.setVisibility('site-1', 'public', principal, before.accessRevision)).rejects.toMatchObject({
        code: 'site_changed',
      });
      await expect(service.deleteSite('site-1', principal, before.accessRevision)).rejects.toMatchObject({
        code: 'site_changed',
      });
      expect(state.sites[0]).toMatchObject({ visibility: 'private', status: 'active', deletedAt: null });
      const published = await service.setVisibility('site-1', 'public', principal, replaced.accessRevision);
      expect(published).toMatchObject({ visibility: 'public', accessRevision: 3, contentRevision: 2 });
    });
    it('rejects replacement when a private site is published during the upload', async () => {
      addSite(state, { visibility: 'private' });
      addVersion(state);
      mockPutFiles.mockImplementationOnce(async () => {
        await service.setVisibility('site-1', 'public', principal, 1);
      });
      await expect(
        service.replaceSiteContent('site-1', {
          principal,
          fileName: 'index.html',
          content: Buffer.from('private draft'),
        })
      ).rejects.toMatchObject({ code: 'site_changed' });
      expect(state.sites[0]).toMatchObject({ activeVersionId: 'version-1', visibility: 'public', contentRevision: 1 });
    });
    it('rejects replacement after visibility changed during upload', async () => {
      addSite(state);
      addVersion(state);
      mockPutFiles.mockImplementationOnce(async () => {
        await service.setVisibility('site-1', 'private', principal, 1);
      });
      await expect(
        service.replaceSiteContent('site-1', { principal, fileName: 'index.html', content: Buffer.from('replacement') })
      ).rejects.toMatchObject({ code: 'site_changed' });
      expect(state.sites[0].activeVersionId).toBe('version-1');
      expect(state.sites[0].visibility).toBe('private');
    });
  });

  describe('cleanup queue wiring', () => {
    it('processes cleanup jobs and logs the result', async () => {
      const result = { expired: 3, cleaned: 2, errors: 1 };
      jest.spyOn(service, 'cleanupExpiredSites').mockResolvedValue(result);

      await expect(service.processSitesCleanupQueue({} as any)).resolves.toEqual(result);
      expect(mockInfo).toHaveBeenCalledWith('Sites: cleanup complete expired=3 cleaned=2 errors=1');
    });

    it.each([
      ['Sites is disabled', { enabled: false }],
      ['cleanup is disabled', { enabled: true, ttl: { enabled: true }, cleanup: { enabled: false } }],
    ])('does not schedule when %s', async (_case, sites) => {
      mockGetAllConfigs.mockResolvedValue({ sites });

      await service.setupSitesCleanupJob();

      expect(queueAdd).not.toHaveBeenCalled();
      expect(mockDebug).toHaveBeenCalledWith('Sites: cleanup disabled');
    });

    it('schedules storage retries even when new sites have no expiry', async () => {
      enabledConfig({ ttl: { enabled: false } });
      await service.setupSitesCleanupJob();
      expect(queueAdd).toHaveBeenCalledWith('sites-cleanup', {}, expect.objectContaining({ jobId: 'sites-cleanup' }));
    });

    it('schedules one stable repeating cleanup job at the configured interval', async () => {
      enabledConfig({ cleanup: { enabled: true, intervalMinutes: 12 } });

      await service.setupSitesCleanupJob();

      expect(queueAdd).toHaveBeenCalledWith(
        'sites-cleanup',
        {},
        {
          jobId: 'sites-cleanup',
          repeat: { every: 12 * 60 * 1000 },
        }
      );
    });
  });
});
