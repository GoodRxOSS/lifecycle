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

import SitesService, { SitesServiceError } from 'server/services/sites';
import { SitesObjectNotFoundError } from 'server/lib/sites/storage';
import { SiteUploadValidationError } from 'server/lib/sites/validation';

type SiteData = {
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

type VersionRow = VersionData;

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
  state.versions.push(version);
  return version;
}

class SiteQuery {
  private filters: Array<(row: SiteRow) => boolean> = [];
  private sortBy: { field: keyof SiteData; direction: string } | null = null;
  private single = false;
  private maximum?: number;

  constructor(private readonly state: FakeState) {}

  whereNull(field: keyof SiteData) {
    this.filters.push((row) => row[field] == null);
    return this;
  }

  whereNotNull(field: keyof SiteData) {
    this.filters.push((row) => row[field] != null);
    return this;
  }

  where(scopeOrField: Partial<SiteData> | keyof SiteData, operationOrValue?: unknown, expectedValue?: unknown) {
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
    this.sortBy = { field, direction };
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

  where(scope: Partial<VersionData>) {
    this.filters.push((row) => Object.entries(scope).every(([key, value]) => row[key as keyof VersionData] === value));
    return this;
  }

  whereNull(field: keyof VersionData) {
    this.filters.push((row) => row[field] == null);
    return this;
  }

  whereIn(field: keyof VersionData, values: unknown[]) {
    this.filters.push((row) => values.includes(row[field]));
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

    await expect(service.createSite({ fileName: 'index.html', content: Buffer.from('site') })).rejects.toMatchObject({
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
          fileName: 'docs.html',
          content: Buffer.from('source upload'),
          name: '  Product docs  ',
          user: { email: 'author@example.com' } as any,
        })
      ).resolves.toEqual({
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

      await expect(service.createSite({ fileName: 'site.exe', content: Buffer.from('bad') })).rejects.toMatchObject({
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

      await expect(service.createSite({ fileName: 'site.html', content: Buffer.from('site') })).rejects.toBe(
        unexpected
      );
      expect(database.models.Site.transact).not.toHaveBeenCalled();
    });

    it('removes uploaded objects when version persistence fails and leaves no database rows', async () => {
      const insertError = new Error('version insert failed');
      state.versionInsertError = insertError;

      await expect(service.createSite({ fileName: 'site.html', content: Buffer.from('site') })).rejects.toBe(
        insertError
      );

      expect(mockDeletePrefix).toHaveBeenCalledWith('sites/site000001/versions/version00001');
      expect(state.sites).toEqual([]);
      expect(state.versions).toEqual([]);
    });

    it('preserves the original upload failure when rollback cleanup also fails', async () => {
      const uploadError = new Error('upload failed');
      const cleanupError = new Error('cleanup failed');
      mockPutFiles.mockRejectedValueOnce(uploadError);
      mockDeletePrefix.mockRejectedValueOnce(cleanupError);

      await expect(service.createSite({ fileName: 'site.html', content: Buffer.from('site') })).rejects.toBe(
        uploadError
      );

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

      const defaults = await service.listSites({ page: Number.NaN, limit: -1 });
      const capped = await service.listSites({ page: 1.9, limit: 101.8 });

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

      await expect(service.getSite('site-nullables')).resolves.toEqual({
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

      await expect(service.getSite('missing')).rejects.toMatchObject({ message: 'Site not found.', statusCode: 404 });
      await expect(service.getSite('deleted')).rejects.toMatchObject({ message: 'Site not found.', statusCode: 404 });
    });

    it('does not classify an invalid expiry timestamp as elapsed', async () => {
      addSite(state, { expiresAt: 'not-a-date' });

      await expect(service.getSite('site-1')).resolves.toMatchObject({ status: 'active', expiresAt: 'not-a-date' });
    });

    it('reports zero counters for a new empty site record', async () => {
      addSite(state, { fileCount: 0, sizeBytes: 0 });

      await expect(service.getSite('site-1')).resolves.toMatchObject({ fileCount: 0, sizeBytes: 0 });
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
        service.replaceSiteContent('site-1', { fileName: 'site.html', content: Buffer.from('site') })
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
        fileName: 'replacement.html',
        content: Buffer.from('replacement'),
      });

      expect(result).toMatchObject({
        id: 'site-1',
        fileCount: 1,
        sizeBytes: 14,
        updatedBy: 'previous@example.com',
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
        fileName: 'replacement.html',
        content: Buffer.from('replacement'),
        user: { email: 'editor@example.com' } as any,
      });

      expect(result.updatedBy).toBe('editor@example.com');
      expect(state.sites[0].updatedBy).toBe('editor@example.com');
    });

    it('keeps a null updater and succeeds when no historical version row exists', async () => {
      addSite(state, { updatedBy: null });

      const result = await service.replaceSiteContent('site-1', {
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
        service.replaceSiteContent('site-1', { fileName: 'replacement.html', content: Buffer.from('replacement') })
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

      const result = await service.extendSite('site-1');

      expect(result.expiresAt).toBe('2026-06-27T00:00:00.000Z');
      expect(state.sites[0].expiresAt).toBe('2026-06-27T00:00:00.000Z');
      now.mockRestore();
    });

    it('extends a site without an expiry from the current time', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-10T00:00:00.000Z'));
      addSite(state, { expiresAt: null });

      await expect(service.extendSite('site-1')).resolves.toMatchObject({
        expiresAt: '2026-06-17T00:00:00.000Z',
      });
      now.mockRestore();
    });

    it('rejects extension when TTL is disabled', async () => {
      enabledConfig({ ttl: { enabled: false } });
      addSite(state, { expiresAt: null });

      await expect(service.extendSite('site-1')).rejects.toMatchObject({
        message: 'TTL is disabled for hosted sites.',
        statusCode: 400,
      });
    });
  });

  describe('deleteSite', () => {
    it('deletes stored versions before atomically soft-deleting site records', async () => {
      addSite(state);
      addVersion(state, { versionId: 'version-1', storagePrefix: 'prefix/version-1' });
      addVersion(state, { versionId: 'version-2', storagePrefix: 'prefix/version-2', deletedAt: CREATED_AT });

      const result = await service.deleteSite('site-1');

      expect(mockDeletePrefix.mock.calls).toEqual([['prefix/version-1'], ['prefix/version-2']]);
      expect(result).toMatchObject({ id: 'site-1', status: 'deleted' });
      expect(state.sites[0]).toMatchObject({ status: 'deleted', deletedAt: expect.any(String) });
      expect(state.versions[0].deletedAt).toBe(state.sites[0].deletedAt);
      expect(state.versions[1].deletedAt).toBe(CREATED_AT);
    });

    it('returns not found without touching storage for an unknown site', async () => {
      await expect(service.deleteSite('missing')).rejects.toMatchObject({
        message: 'Site not found.',
        statusCode: 404,
      });
      expect(mockDeletePrefix).not.toHaveBeenCalled();
      expect(database.models.Site.transact).not.toHaveBeenCalled();
    });

    it('does not mark database rows deleted when object cleanup fails', async () => {
      const site = addSite(state);
      const version = addVersion(state, { storagePrefix: 'prefix/version-1' });
      const deleteError = new Error('delete failed');
      mockDeletePrefix.mockRejectedValueOnce(deleteError);

      await expect(service.deleteSite('site-1')).rejects.toBe(deleteError);
      expect(site.status).toBe('active');
      expect(site.deletedAt).toBeNull();
      expect(version.deletedAt).toBeNull();
      expect(database.models.Site.transact).not.toHaveBeenCalled();
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

    it('matches only configured gateway hosts while Sites is enabled', async () => {
      await expect(service.matchesGatewayHost('site-abc123.sites.example.com')).resolves.toBe(true);
      await expect(service.matchesGatewayHost('other-abc123.sites.example.com')).resolves.toBe(false);
      await expect(service.matchesGatewayHost(undefined)).resolves.toBe(false);

      mockGetAllConfigs.mockResolvedValue({ sites: { enabled: false } });
      await expect(service.matchesGatewayHost('site-abc123.sites.example.com')).resolves.toBe(false);
    });
  });

  describe('expiration cleanup', () => {
    it.each([
      ['Sites is disabled', { enabled: false }],
      ['TTL is disabled', { enabled: true, ttl: { enabled: false } }],
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
      expect(failedSite).toMatchObject({ status: 'active', deletedAt: null });
      expect(failedVersion.deletedAt).toBeNull();
      expect(mockError).toHaveBeenCalledWith(
        { error: cleanupError, siteId: 'expired-failed' },
        'Sites: cleanup failed'
      );
      toISOString.mockRestore();
    });

    it('returns zero counts when no active site has elapsed', async () => {
      addSite(state, { expiresAt: '2099-01-01T00:00:00.000Z' });

      await expect(service.cleanupExpiredSites()).resolves.toEqual({ expired: 0, cleaned: 0, errors: 0 });
      expect(mockDeletePrefix).not.toHaveBeenCalled();
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
      ['TTL is disabled', { enabled: true, ttl: { enabled: false } }],
      ['cleanup is disabled', { enabled: true, ttl: { enabled: true }, cleanup: { enabled: false } }],
    ])('does not schedule when %s', async (_case, sites) => {
      mockGetAllConfigs.mockResolvedValue({ sites });

      await service.setupSitesCleanupJob();

      expect(queueAdd).not.toHaveBeenCalled();
      expect(mockDebug).toHaveBeenCalledWith('Sites: cleanup disabled');
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
