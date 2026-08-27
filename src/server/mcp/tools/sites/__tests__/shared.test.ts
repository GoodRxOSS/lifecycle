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

jest.mock('server/services/sites', () => {
  const actual = jest.requireActual('server/services/sites');
  return { ...actual, __esModule: true, default: jest.fn() };
});

import SitesService, { SitesServiceError, type SiteResponse } from 'server/services/sites';
import { McpExecutionError } from '../../../errors';
import { mapSiteServiceError, resolveSiteToolDependencies, siteSummary } from '../shared';

const MockSitesService = SitesService as unknown as jest.Mock;

function site(overrides: Partial<SiteResponse> = {}): SiteResponse {
  return {
    id: 'site-1',
    name: 'docs',
    url: 'https://docs.example.test',
    status: 'ready',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: null,
    fileCount: 3,
    sizeBytes: 1024,
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

describe('resolveSiteToolDependencies', () => {
  it('lazily reuses the default service and reads the current clock', () => {
    const service = { listSites: jest.fn(), getSite: jest.fn() };
    MockSitesService.mockImplementation(() => service);
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_750_000_123_000);
    const dependencies = resolveSiteToolDependencies();

    try {
      expect(dependencies.service()).toBe(service);
      expect(dependencies.service()).toBe(service);
      expect(dependencies.nowSeconds()).toBe(1_750_000_123);
      expect(MockSitesService).toHaveBeenCalledTimes(1);
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe('mapSiteServiceError', () => {
  it('preserves an existing MCP execution error', () => {
    const error = new McpExecutionError('site_not_found', 'Already mapped');

    expect(mapSiteServiceError(error)).toBe(error);
  });

  it.each([
    [403, 'site_not_found'],
    [404, 'site_not_found'],
    [502, 'upstream_unavailable'],
    [503, 'upstream_unavailable'],
    [500, 'internal_error'],
  ] as const)('maps a Sites service %s error to %s', (statusCode, expectedCode) => {
    expect(mapSiteServiceError(new SitesServiceError('service failure', statusCode))).toMatchObject({
      code: expectedCode,
    });
  });

  it('sanitizes an unknown dependency failure', () => {
    expect(mapSiteServiceError(new Error('storage credentials leaked here'))).toMatchObject({
      code: 'internal_error',
      message: 'Lifecycle could not complete the site request. Ask an administrator to review the server logs.',
    });
  });
});

describe('siteSummary', () => {
  it('rejects missing required text from the service boundary', () => {
    expect(() => siteSummary(site({ name: '' }))).toThrow('Lifecycle returned incomplete hosted-site data.');
  });

  it('rejects an invalid required timestamp from the service boundary', () => {
    expect(() => siteSummary(site({ updatedAt: 'not-a-date' }))).toThrow(
      'Lifecycle returned incomplete hosted-site data.'
    );
  });
});
