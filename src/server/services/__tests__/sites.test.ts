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

import SitesService from 'server/services/sites';

type SiteRow = {
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

  constructor(private readonly rows: SiteRow[]) {}

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

  orderBy(field: keyof SiteRow, direction: string) {
    this.sortBy = { field, direction };
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

  then(resolve: (value: SiteRow[]) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.filteredRows()).then(resolve, reject);
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
        createSiteRow({ siteId: 'old', updatedAt: '2026-05-01T00:00:00.000Z' }),
        createSiteRow({
          siteId: 'deleted',
          updatedAt: '2026-05-03T00:00:00.000Z',
          deletedAt: '2026-05-04T00:00:00.000Z',
        }),
        createSiteRow({ siteId: 'new', updatedAt: '2026-05-02T00:00:00.000Z' })
      );

      await expect(service.listSites()).resolves.toMatchObject({
        sites: [{ id: 'new' }, { id: 'old' }],
        pagination: {
          current: 1,
          total: 1,
          items: 2,
          limit: 25,
        },
      });
    });

    it('filters to sites created or last updated by the supplied user email', async () => {
      rows.push(
        createSiteRow({
          siteId: 'created-by-user',
          createdBy: 'ALICE@example.com',
          updatedBy: 'other@example.com',
          updatedAt: '2026-05-01T00:00:00.000Z',
        }),
        createSiteRow({
          siteId: 'updated-by-user',
          createdBy: 'other@example.com',
          updatedBy: 'alice@example.com',
          updatedAt: '2026-05-03T00:00:00.000Z',
        }),
        createSiteRow({
          siteId: 'not-touched-by-user',
          createdBy: 'other@example.com',
          updatedBy: 'other@example.com',
          updatedAt: '2026-05-04T00:00:00.000Z',
        })
      );

      await expect(service.listSites({ user: ' Alice@Example.com ' })).resolves.toMatchObject({
        sites: [{ id: 'updated-by-user' }, { id: 'created-by-user' }],
        pagination: {
          current: 1,
          total: 1,
          items: 2,
          limit: 25,
        },
      });
    });

    it('paginates sites after sorting and filtering', async () => {
      rows.push(
        createSiteRow({ siteId: 'oldest', updatedAt: '2026-05-01T00:00:00.000Z' }),
        createSiteRow({ siteId: 'middle', updatedAt: '2026-05-02T00:00:00.000Z' }),
        createSiteRow({ siteId: 'newest', updatedAt: '2026-05-03T00:00:00.000Z' })
      );

      await expect(service.listSites({ page: 2, limit: 1 })).resolves.toMatchObject({
        sites: [{ id: 'middle' }],
        pagination: {
          current: 2,
          total: 3,
          items: 3,
          limit: 1,
        },
      });
    });
  });
});
