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

import type { McpJsonObject } from '../../contracts';
import { normalizeMcpDateTime } from '../../dateTime';
import { McpExecutionError } from '../../errors';
import SitesService, {
  SitesServiceError,
  type ListSitesFilters,
  type ListSitesResult,
  type SiteResponse,
} from 'server/services/sites';
import { safeCoreText } from '../core/listRepositories';

export interface SiteToolService {
  listSites(filters?: ListSitesFilters): Promise<ListSitesResult>;
  getSite(siteId: string): Promise<SiteResponse>;
}

export interface SiteToolDependencies {
  service?: SiteToolService;
  nowSeconds?: () => number;
}

export interface ResolvedSiteToolDependencies {
  service: () => SiteToolService;
  nowSeconds: () => number;
}

export function resolveSiteToolDependencies(dependencies: SiteToolDependencies = {}): ResolvedSiteToolDependencies {
  let defaultService: SiteToolService | undefined;
  return {
    service: () => dependencies.service ?? (defaultService ??= new SitesService()),
    nowSeconds: dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
  };
}

export function mapSiteServiceError(error: unknown): McpExecutionError {
  if (error instanceof McpExecutionError) return error;
  if (error instanceof SitesServiceError) {
    const statusCode = Number(error.statusCode);
    if (statusCode === 404 || statusCode === 403) {
      return new McpExecutionError('site_not_found', 'That hosted site was not found.');
    }
    if (statusCode === 502 || statusCode === 503) {
      return new McpExecutionError('upstream_unavailable', 'Site storage is temporarily unavailable.');
    }
  }
  return new McpExecutionError(
    'internal_error',
    'Lifecycle could not complete the site request. Ask an administrator to review the server logs.'
  );
}

function requiredString(value: string | null | undefined, maxBytes: number): string {
  const safe = safeCoreText(value, maxBytes);
  if (!safe) {
    throw new McpExecutionError('internal_error', 'Lifecycle returned incomplete hosted-site data.');
  }
  return safe;
}

function optionalString(value: string | null | undefined, maxBytes: number): string | undefined {
  const safe = safeCoreText(value, maxBytes);
  return safe || undefined;
}

function requiredDateTime(value: unknown): string {
  const normalized = normalizeMcpDateTime(value);
  if (!normalized) {
    throw new McpExecutionError('internal_error', 'Lifecycle returned incomplete hosted-site data.');
  }
  return normalized;
}

export function siteSummary(site: SiteResponse): McpJsonObject {
  const createdBy = optionalString(site.createdBy, 512);
  const updatedBy = optionalString(site.updatedBy, 512);
  const expiresAt = normalizeMcpDateTime(site.expiresAt);
  return {
    siteId: requiredString(site.id, 100),
    name: requiredString(site.name, 200),
    url: requiredString(site.url, 2048),
    status: requiredString(site.status, 50),
    createdAt: requiredDateTime(site.createdAt),
    updatedAt: requiredDateTime(site.updatedAt),
    ...(expiresAt ? { expiresAt } : {}),
    fileCount: site.fileCount,
    sizeBytes: site.sizeBytes,
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}
