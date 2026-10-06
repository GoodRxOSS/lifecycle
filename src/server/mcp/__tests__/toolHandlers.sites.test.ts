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
import { AppError } from 'server/lib/appError';
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
  visibility: 'public',
  contentUrl: 'https://sites.example.com/launch-page',
  openUrl: 'https://ui.example.com/sites/site_abc123',
  accessRevision: 1,
  contentRevision: 1,
  currentRole: 'owner',
  permissions: { canView: true, canEdit: true, canDelete: true, canChangeVisibility: true },
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

function harness(service: Partial<SiteToolService>, policyOverrides: Partial<McpRuntimePolicy> = {}) {
  const registry = new McpToolRegistry(
    createSiteToolDefinitions({
      service: {
        listSites: () => Promise.reject(new Error('listSites not stubbed')),
        getSite: () => Promise.reject(new Error('getSite not stubbed')),
        createSite: () => Promise.reject(new Error('createSite not stubbed')),
        replaceSiteContent: () => Promise.reject(new Error('replaceSiteContent not stubbed')),
        extendSite: () => Promise.reject(new Error('extendSite not stubbed')),
        setVisibility: () => Promise.reject(new Error('setVisibility not stubbed')),
        deleteSite: () => Promise.reject(new Error('deleteSite not stubbed')),
        ...service,
      },
      nowSeconds: () => 1_000,
    }),
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    { record: jest.fn() }
  );
  const policy: McpRuntimePolicy = { enabled: true, allowChanges: true, sitesAvailable: true, ...policyOverrides };
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
    expect(listSites.mock.calls[0][1]).toBe(PRINCIPAL);
    expect(listSites.mock.calls[0][0]).toEqual({ view: 'all', page: 1, limit: 25 });
  });

  it('filters to the signed-in user for mineOnly', async () => {
    const listSites = jest.fn().mockResolvedValue({
      sites: [],
      pagination: { current: 1, total: 1, items: 0, limit: 25 },
    });
    const { call } = harness({ listSites });
    await call('list_sites', { mineOnly: true });
    expect(listSites.mock.calls[0][0]).toMatchObject({ view: 'mine' });
  });

  it('delegates immutable ownership even without an email', async () => {
    const listSites = jest
      .fn()
      .mockResolvedValue({ sites: [], pagination: { current: 1, total: 1, items: 0, limit: 25 } });
    const { call } = harness({ listSites });
    const { output } = await call('list_sites', { mineOnly: true }, {
      ...PRINCIPAL,
      identity: null,
    } as unknown as Principal);
    expect(output).toMatchObject({ sites: [] });
    expect(listSites).toHaveBeenCalledWith(
      { view: 'mine', page: 1, limit: 25 },
      expect.objectContaining({ userId: 'user-1', identity: null })
    );
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
    const getSite = jest.fn().mockResolvedValue(SITE);
    const { call } = harness({ getSite });
    const { output } = await call('get_site', { siteId: 'site_abc123' });
    expect(output!.site).toMatchObject({ siteId: 'site_abc123', status: 'active' });
    expect(getSite).toHaveBeenCalledWith('site_abc123', PRINCIPAL);
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

const HTML = '<!doctype html><html><body><h1>Hi</h1></body></html>';

describe('create_site', () => {
  it('publishes a single HTML string as a private site by default', async () => {
    const createSite = jest.fn().mockResolvedValue(SITE);
    const { call } = harness({ createSite });
    const { output } = await call('create_site', { content: HTML, name: 'launch-page' });
    expect(output!.site).toMatchObject({ siteId: 'site_abc123' });
    const [input] = createSite.mock.calls[0];
    expect(input).toMatchObject({
      fileName: 'index.html',
      name: 'launch-page',
      visibility: 'private',
      principal: PRINCIPAL,
    });
    expect((input.content as Buffer).toString('utf8')).toBe(HTML);
  });

  it('accepts other single text files by extension', async () => {
    const createSite = jest.fn().mockResolvedValue(SITE);
    const { call } = harness({ createSite });
    await call('create_site', { content: '# Notes', filename: 'notes.md', visibility: 'public' });
    expect(createSite.mock.calls[0][0]).toMatchObject({ fileName: 'notes.md', visibility: 'public' });
  });

  it.each(['site.zip', 'logo.png', 'report.pdf', 'app.wasm', 'index'])(
    'rejects %s as unsupported without calling the service',
    async (filename) => {
      const createSite = jest.fn();
      const { call } = harness({ createSite });
      const { error } = await call('create_site', { content: 'PK', filename });
      expect(error).toMatchObject({ code: 'invalid_body', nextAction: 'fix_input' });
      expect(error!.message).toContain('ZIP archives and binary files are not supported.');
      expect(error!.message).not.toContain('lfc');
      expect(createSite).not.toHaveBeenCalled();
    }
  );

  it('surfaces upload validation failures as invalid input', async () => {
    const { call } = harness({
      createSite: () => Promise.reject(new SitesServiceError('Upload size must be 10 bytes or less.', 400)),
    });
    const { error } = await call('create_site', { content: HTML });
    expect(error).toMatchObject({
      code: 'invalid_body',
      message: 'Upload size must be 10 bytes or less.',
      details: { issues: [{ path: '/content', message: 'Upload size must be 10 bytes or less.' }] },
    });
  });

  it('reports unavailable private sites as an admin problem', async () => {
    const { call } = harness({
      createSite: () =>
        Promise.reject(new AppError({ httpStatus: 503, code: 'private_sites_unavailable', message: 'not configured' })),
    });
    const { error } = await call('create_site', { content: HTML });
    expect(error).toMatchObject({ code: 'toolset_disabled', retryable: false });
  });

  it('is hidden when MCP changes are disabled', async () => {
    const createSite = jest.fn();
    const { call } = harness({ createSite }, { allowChanges: false });
    const { error } = await call('create_site', { content: HTML });
    expect(error).toBeDefined();
    expect(createSite).not.toHaveBeenCalled();
  });
});

describe('update_site_content', () => {
  it('replaces content in place with an optional revision guard', async () => {
    const replaceSiteContent = jest.fn().mockResolvedValue({ ...SITE, contentRevision: 2 });
    const { call } = harness({ replaceSiteContent });
    const { output } = await call('update_site_content', {
      siteId: 'site_abc123',
      content: HTML,
      expectedContentRevision: 1,
    });
    expect(output!.site).toMatchObject({ contentRevision: 2 });
    expect(replaceSiteContent).toHaveBeenCalledWith(
      'site_abc123',
      expect.objectContaining({ fileName: 'index.html', expectedContentRevision: 1, principal: PRINCIPAL })
    );
  });

  it('rejects a zip upload', async () => {
    const replaceSiteContent = jest.fn();
    const { call } = harness({ replaceSiteContent });
    const { error } = await call('update_site_content', { siteId: 'site_abc123', content: 'PK', filename: 'a.zip' });
    expect(error).toMatchObject({ code: 'invalid_body' });
    expect(replaceSiteContent).not.toHaveBeenCalled();
  });

  it('maps a revision conflict to site_changed', async () => {
    const { call } = harness({
      replaceSiteContent: () =>
        Promise.reject(new AppError({ httpStatus: 409, code: 'site_changed', message: 'changed' })),
    });
    const { error } = await call('update_site_content', { siteId: 'site_abc123', content: HTML });
    expect(error).toMatchObject({ code: 'site_changed', nextAction: 'fix_input' });
  });

  it('tells a non-owner they cannot change the site', async () => {
    const { call } = harness({
      replaceSiteContent: () =>
        Promise.reject(new AppError({ httpStatus: 403, code: 'site_access_denied', message: 'denied' })),
    });
    const { error } = await call('update_site_content', { siteId: 'site_abc123', content: HTML });
    expect(error).toMatchObject({ code: 'forbidden_role', message: 'Only the owner of this site can change it.' });
  });
});

describe('set_site_visibility', () => {
  it('changes visibility with the required access revision', async () => {
    const setVisibility = jest.fn().mockResolvedValue({ ...SITE, visibility: 'private', accessRevision: 2 });
    const { call } = harness({ setVisibility });
    const { output } = await call('set_site_visibility', {
      siteId: 'site_abc123',
      visibility: 'private',
      expectedAccessRevision: 1,
    });
    expect(output!.site).toMatchObject({ visibility: 'private' });
    expect(setVisibility).toHaveBeenCalledWith('site_abc123', 'private', PRINCIPAL, 1);
  });

  it('requires expectedAccessRevision', async () => {
    const setVisibility = jest.fn();
    const { call } = harness({ setVisibility });
    const { error } = await call('set_site_visibility', { siteId: 'site_abc123', visibility: 'public' });
    expect(error).toMatchObject({ code: 'invalid_body' });
    expect(setVisibility).not.toHaveBeenCalled();
  });
});

describe('extend_site', () => {
  it('extends the expiry', async () => {
    const extendSite = jest.fn().mockResolvedValue({ ...SITE, expiresAt: '2026-08-08T00:00:00.000Z' });
    const { call } = harness({ extendSite });
    const { output } = await call('extend_site', { siteId: 'site_abc123' });
    expect(output!.site).toMatchObject({ expiresAt: '2026-08-08T00:00:00.000Z' });
    expect(extendSite).toHaveBeenCalledWith('site_abc123', PRINCIPAL, undefined);
  });

  it('reports disabled TTL as invalid input', async () => {
    const { call } = harness({
      extendSite: () => Promise.reject(new SitesServiceError('TTL is disabled for hosted sites.', 400)),
    });
    const { error } = await call('extend_site', { siteId: 'site_abc123', expectedAccessRevision: 1 });
    expect(error).toMatchObject({ code: 'invalid_body', message: 'TTL is disabled for hosted sites.' });
  });
});

describe('delete_site', () => {
  it('deletes with the required access revision', async () => {
    const deleteSite = jest.fn().mockResolvedValue({ ...SITE, status: 'deleted', accessRevision: 2 });
    const { call } = harness({ deleteSite });
    const { output } = await call('delete_site', { siteId: 'site_abc123', expectedAccessRevision: 1 });
    expect(output!.site).toMatchObject({ status: 'deleted' });
    expect(deleteSite).toHaveBeenCalledWith('site_abc123', PRINCIPAL, 1);
  });

  it('requires expectedAccessRevision so the caller has read the site first', async () => {
    const deleteSite = jest.fn();
    const { call } = harness({ deleteSite });
    const { error } = await call('delete_site', { siteId: 'site_abc123' });
    expect(error).toMatchObject({ code: 'invalid_body' });
    expect(deleteSite).not.toHaveBeenCalled();
  });
});
