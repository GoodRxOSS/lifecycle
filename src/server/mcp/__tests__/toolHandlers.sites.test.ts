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

import type { Principal } from 'server/lib/principal';
import { SitesServiceError, type SiteResponse } from 'server/services/sites';
import type { McpJsonObject, McpRuntimePolicy, McpToolInvocationContext } from '../contracts';
import type { McpExecutionErrorEnvelope } from '../errors';
import { McpToolRegistry } from '../registry';
import { createSiteToolDefinitions, type SiteToolService } from '../tools/sites';

const SITE: SiteResponse = {
  id: 'site_abc123',
  name: 'launch-page',
  url: 'https://sites.example.com/launch-page',
  status: 'active',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  expiresAt: '2026-08-01T00:00:00.000Z',
  fileCount: 4,
  sizeBytes: 2048,
  createdBy: 'user@example.com',
  updatedBy: 'user@example.com',
} as SiteResponse;

const originalEncryptionKey = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '7'.repeat(64);
});

afterAll(() => {
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

const PRINCIPAL = {
  kind: 'user',
  authMethod: 'oauth',
  userId: 'user-1',
  actor: 'user-1',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: { userId: 'user-1', email: 'user@example.com' },
} as unknown as Principal;

function harness(service: Partial<SiteToolService>) {
  const registry = new McpToolRegistry(
    createSiteToolDefinitions({
      service: {
        listSites: () => Promise.reject(new Error('listSites not stubbed')),
        getSite: () => Promise.reject(new Error('getSite not stubbed')),
        ...service,
      },
      nowSeconds: () => 1_000,
    }),
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    { record: jest.fn() }
  );
  const policy: McpRuntimePolicy = { enabled: true, allowChanges: true, sitesAvailable: true };
  return {
    call: async (name: string, input: McpJsonObject, principal: Principal = PRINCIPAL) => {
      const context: McpToolInvocationContext = {
        principal,
        requestId: 'request-1',
        signal: new AbortController().signal,
      };
      const result = await registry.callTool(name, input, context, policy);
      if (result.isError) {
        const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text) as McpExecutionErrorEnvelope;
        return { error: envelope.error as unknown as McpJsonObject };
      }
      return { output: result.structuredContent as McpJsonObject };
    },
  };
}

describe('list_sites', () => {
  it('lists sites with a continuation cursor', async () => {
    const listSites = jest.fn().mockResolvedValue({
      sites: [SITE],
      pagination: { current: 1, total: 2, items: 1, limit: 25 },
    });
    const { call } = harness({ listSites });
    const { output } = await call('list_sites', {});
    expect(output!.sites).toEqual([
      expect.objectContaining({
        siteId: 'site_abc123',
        name: 'launch-page',
        url: 'https://sites.example.com/launch-page',
        fileCount: 4,
        sizeBytes: 2048,
      }),
    ]);
    expect(typeof output!.nextCursor).toBe('string');
    expect(listSites.mock.calls[0][0]).toEqual({ page: 1, limit: 25 });
  });

  it('filters to the signed-in user for mineOnly', async () => {
    const listSites = jest.fn().mockResolvedValue({
      sites: [],
      pagination: { current: 1, total: 1, items: 0, limit: 25 },
    });
    const { call } = harness({ listSites });
    await call('list_sites', { mineOnly: true });
    expect(listSites.mock.calls[0][0]).toMatchObject({ user: 'user@example.com' });
  });

  it('returns nothing for mineOnly without a known email', async () => {
    const listSites = jest.fn();
    const { call } = harness({ listSites });
    const { output } = await call('list_sites', { mineOnly: true }, {
      ...PRINCIPAL,
      identity: null,
    } as unknown as Principal);
    expect(output).toMatchObject({ sites: [] });
    expect(listSites.mock.calls).toHaveLength(0);
  });

  it('reports storage outages as retryable', async () => {
    const { call } = harness({
      listSites: () => Promise.reject(new SitesServiceError('s3 down', 503)),
    });
    const { error } = await call('list_sites', {});
    expect(error).toMatchObject({ code: 'upstream_unavailable', retryable: true });
  });
});

describe('get_site', () => {
  it('returns one site', async () => {
    const { call } = harness({ getSite: async () => SITE });
    const { output } = await call('get_site', { siteId: 'site_abc123' });
    expect(output!.site).toMatchObject({ siteId: 'site_abc123', status: 'active' });
  });

  it('normalizes Date-backed site timestamps before output validation', async () => {
    const dateBackedSite = {
      ...SITE,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-02T00:00:00.000Z'),
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    } as unknown as SiteResponse;
    const { call } = harness({ getSite: async () => dateBackedSite });

    const { output } = await call('get_site', { siteId: 'site_abc123' });

    expect(output!.site).toMatchObject({
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('hides authorization detail behind site_not_found', async () => {
    const { call } = harness({
      getSite: () => Promise.reject(new SitesServiceError('forbidden', 403)),
    });
    const { error } = await call('get_site', { siteId: 'site_abc123' });
    expect(error).toMatchObject({ code: 'site_not_found' });
  });

  it('rejects a malformed site id at the schema layer', async () => {
    const getSite = jest.fn();
    const { call } = harness({ getSite });
    const { error } = await call('get_site', { siteId: 'not a site id!' });
    expect(error).toMatchObject({ code: 'invalid_body' });
    expect(getSite.mock.calls).toHaveLength(0);
  });
});
