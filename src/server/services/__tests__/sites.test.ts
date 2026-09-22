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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';

mockRedisClient();

const mockGetAllConfigs = jest.fn();
const mockAudit = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock('server/services/authAudit', () => ({
  recordAuthAuditEventInTransaction: (...args: unknown[]) => mockAudit(...args),
}));

jest.mock('shared/config', () => ({
  QUEUE_NAMES: {
    SITES_CLEANUP: 'sites-cleanup',
  },
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
    warn: jest.fn(),
  })),
}));

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {
    registerQueue: jest.fn(() => ({ add: jest.fn() })),
  },
  redisClient: {
    getConnection: jest.fn(() => ({
      duplicate: jest.fn(),
    })),
  },
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
    })),
  },
}));

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

import SitesService from 'server/services/sites';

type SiteRow = {
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
  fileCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
};

class SiteQuery {
  private filters: Array<(row: SiteRow) => boolean> = [];
  private sortBy: { field: keyof SiteRow; direction: string } | null = null;
  private single = false;

  constructor(private readonly rows: SiteRow[]) {}

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
  where(scope: Partial<SiteRow> | keyof SiteRow | ((query: SiteQuery) => unknown), value?: unknown) {
    if (typeof scope === 'function') {
      const group = new SiteQuery(this.rows);
      scope(group);
      this.filters.push((row) => group.filters.every((f) => f(row)));
    } else if (typeof scope === 'string') this.filters.push((row) => row[scope] === value);
    else this.filters.push((row) => Object.entries(scope).every(([key, value]) => row[key as keyof SiteRow] === value));
    return this;
  }
  whereNull(field: keyof SiteRow) {
    this.filters.push((row) => row[field] == null);
    return this;
  }

  whereRaw(sql: string, values: string[]) {
    if (sql.includes('createdBy') && sql.includes('updatedBy')) {
      const user = values[0];
      this.filters.push((row) => row.createdBy?.toLowerCase() === user || row.updatedBy?.toLowerCase() === user);
    }
    return this;
  }

  findOne(scope: Partial<SiteRow>) {
    this.single = true;
    this.filters.push((row) => Object.entries(scope).every(([key, value]) => row[key as keyof SiteRow] === value));
    return this;
  }

  orderBy(field: keyof SiteRow, direction: string) {
    if (!this.sortBy) this.sortBy = { field, direction };
    return this;
  }

  async page(pageIndex: number, pageSize: number) {
    const rows = this.filteredRows();
    const start = pageIndex * pageSize;
    return {
      results: rows.slice(start, start + pageSize),
      total: rows.length,
    };
  }

  then(resolve: (value: SiteRow[] | SiteRow | undefined) => unknown, reject?: (reason: unknown) => unknown) {
    const rows = this.filteredRows();
    return Promise.resolve(this.single ? rows[0] : rows).then(resolve, reject);
  }

  private filteredRows() {
    const rows = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (!this.sortBy) return rows;

    const sortBy = this.sortBy;
    return [...rows].sort((a, b) => {
      const compared = String(a[sortBy.field] || '').localeCompare(String(b[sortBy.field] || ''));
      return sortBy.direction === 'desc' ? -compared : compared;
    });
  }
}

function createSiteRow(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
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
    fileCount: 1,
    sizeBytes: 128,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    expiresAt: null,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('SitesService', () => {
  let rows: SiteRow[];
  let service: SitesService;

  beforeEach(() => {
    rows = [];
    mockGetAllConfigs.mockResolvedValue({
      sites: {
        enabled: true,
        domain: 'sites.example.com',
        hostPrefix: 'site',
      },
    });

    service = new SitesService(
      {
        models: {
          Site: {
            query: jest.fn(() => new SiteQuery(rows)),
          },
        },
      } as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn() })) } as any
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('listSites', () => {
    it('returns all non-deleted sites without a user filter', async () => {
      rows.push(
        createSiteRow({ siteId: 'old', createdAt: '2026-05-01T00:00:00.000Z' }),
        createSiteRow({
          siteId: 'deleted',
          createdAt: '2026-05-03T00:00:00.000Z',
          deletedAt: '2026-05-04T00:00:00.000Z',
        }),
        createSiteRow({ siteId: 'new', createdAt: '2026-05-02T00:00:00.000Z' })
      );

      await expect(service.listSites({}, principal)).resolves.toMatchObject({
        sites: [{ id: 'new' }, { id: 'old' }],
        pagination: {
          current: 1,
          total: 1,
          items: 2,
          limit: 25,
        },
      });
    });

    it('rejects legacy email filters instead of treating mutable attribution as ownership', async () => {
      await expect(service.listSites({ user: 'Alice@Example.com' }, principal)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('paginates sites after sorting and filtering', async () => {
      rows.push(
        createSiteRow({ siteId: 'oldest', createdAt: '2026-05-01T00:00:00.000Z' }),
        createSiteRow({ siteId: 'middle', createdAt: '2026-05-02T00:00:00.000Z' }),
        createSiteRow({ siteId: 'newest', createdAt: '2026-05-03T00:00:00.000Z' })
      );

      await expect(service.listSites({ page: 2, limit: 1 }, principal)).resolves.toMatchObject({
        sites: [{ id: 'middle' }],
        pagination: {
          current: 2,
          total: 3,
          items: 3,
          limit: 1,
        },
      });
    });

    it('reports an active row as expired at the exact TTL boundary before cleanup runs', async () => {
      const expiresAt = '2026-05-10T00:00:00.000Z';
      const now = jest.spyOn(Date, 'now').mockReturnValue(new Date(expiresAt).getTime());
      rows.push(createSiteRow({ expiresAt }));

      await expect(service.listSites({}, principal)).resolves.toMatchObject({
        sites: [{ id: 'site-1', status: 'expired', expiresAt }],
      });
      await expect(service.getSite('site-1', principal)).resolves.toMatchObject({
        id: 'site-1',
        status: 'expired',
        expiresAt,
      });
      now.mockRestore();
    });

    it('does not resurrect elapsed sites when TTL defaults are disabled', async () => {
      mockGetAllConfigs.mockResolvedValue({
        sites: {
          enabled: true,
          domain: 'sites.example.com',
          hostPrefix: 'site',
          ttl: { enabled: false },
        },
      });
      rows.push(createSiteRow({ expiresAt: '2000-01-01T00:00:00.000Z' }));

      await expect(service.listSites({}, principal)).resolves.toMatchObject({
        sites: [{ id: 'site-1', status: 'expired' }],
      });
      await expect(service.getSite('site-1', principal)).resolves.toMatchObject({
        id: 'site-1',
        status: 'expired',
      });
    });
  });
});
