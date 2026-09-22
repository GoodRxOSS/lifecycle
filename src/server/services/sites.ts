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

import { Queue, Job } from 'bullmq';
import { customAlphabet } from 'nanoid';
import { Transaction } from 'objection';
import Service from './_service';
import GlobalConfigService from './globalConfig';
import { QUEUE_NAMES } from 'shared/config';
import { redisClient } from 'server/lib/dependencies';
import { getLogger } from 'server/lib/logger';
import { buildSiteUrl, parseSiteIdFromHost, resolveSitesConfig, ResolvedSitesConfig } from 'server/lib/sites/config';
import { SitesObjectNotFoundError, SitesStorage } from 'server/lib/sites/storage';
import {
  normalizeGatewayPath,
  SiteUploadValidationError,
  validateSiteUpload,
  ValidatedSiteUpload,
} from 'server/lib/sites/validation';
import { getContentType } from 'server/lib/sites/contentType';
import type Site from 'server/models/Site';
import type SiteVersion from 'server/models/SiteVersion';
import type { PaginationMetadata } from 'server/lib/paginate';
import type { RequestUserIdentity } from 'server/lib/get-user';
import type { Principal } from 'server/lib/principal';
import { recordAuthAuditEventInTransaction } from 'server/services/authAudit';
import { AppError } from 'server/lib/appError';
import { assertPrivateSitesReady } from 'server/lib/sites/browserAuth';
import { assertSitesPrincipal, assertSiteOwner, isSiteOwner, hasSitesScope } from 'server/lib/sites/policy';

const createSiteId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);
const createVersionId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIST_PAGE = 1;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
type SitesErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503;

export class SitesServiceError extends Error {
  readonly httpStatus?: number;
  readonly code?: string;
  constructor(message: string, public statusCode: SitesErrorStatusCode = 500) {
    super(message);
    // Match the ownership policy's not-found contract without changing other legacy errors.
    if (statusCode === 404) {
      this.httpStatus = 404;
      this.code = 'site_not_found';
    }
  }
}

export type CreateOrReplaceSiteInput = {
  fileName: string;
  content: Buffer;
  name?: string | null;
  user?: RequestUserIdentity | null;
  principal: Principal;
  visibility?: 'private' | 'public';
  expectedAccessRevision?: number;
  expectedContentRevision?: number;
};

export type ListSitesFilters = {
  user?: string;
  view?: 'mine' | 'public' | 'all';
  q?: string;
  page?: number;
  limit?: number;
};

export type ListSitesResult = {
  sites: SiteResponse[];
  pagination: PaginationMetadata;
};

export type SiteResponse = {
  id: string;
  name: string;
  url: string;
  status: string;
  visibility: 'private' | 'public';
  contentUrl: string;
  openUrl: string;
  accessRevision: number;
  contentRevision: number;
  currentRole: 'owner' | null;
  permissions: { canView: boolean; canEdit: boolean; canDelete: boolean; canChangeVisibility: boolean };
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  fileCount: number;
  sizeBytes: number;
  createdBy: string | null;
  updatedBy: string | null;
};

export type GatewayObjectResponse = {
  body: NodeJS.ReadableStream;
  contentType: string;
  contentLength?: number;
  statusCode: number;
};

export default class SitesService extends Service {
  sitesCleanupQueue: Queue = this.queueManager.registerQueue(QUEUE_NAMES.SITES_CLEANUP, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  private async getConfig(): Promise<ResolvedSitesConfig> {
    const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
    return resolveSitesConfig(globalConfig.sites);
  }

  private assertEnabled(config: ResolvedSitesConfig) {
    if (!config.enabled) {
      throw new SitesServiceError('Sites hosting is disabled.', 404);
    }
  }

  private serialize(site: Site, config: ResolvedSitesConfig, principal?: Principal): SiteResponse {
    const owner = isSiteOwner(site, principal);
    const writable = owner && Boolean(principal && hasSitesScope(principal, 'write'));
    const contentUrl = buildSiteUrl(site.siteId, config);
    const uiUrl = process.env.LIFECYCLE_UI_URL;
    const expiresAt = site.expiresAt ? new Date(site.expiresAt).getTime() : null;
    const status =
      site.status === 'active' && expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= Date.now()
        ? 'expired'
        : site.status;
    return {
      id: site.siteId,
      name: site.name,
      url: contentUrl,
      contentUrl,
      openUrl: uiUrl ? new URL(`/sites/open/${site.siteId}`, uiUrl).toString() : contentUrl,
      visibility: site.visibility,
      accessRevision: site.accessRevision,
      contentRevision: site.contentRevision,
      currentRole: owner ? 'owner' : null,
      permissions: {
        canView: true,
        canEdit: writable && status === 'active',
        canDelete: writable && !site.deletedAt && status !== 'deleted',
        canChangeVisibility: writable && status === 'active' && site.ownerKind === 'user',
      },
      status,
      createdAt: site.createdAt || null,
      updatedAt: site.updatedAt || null,
      expiresAt: site.expiresAt || null,
      fileCount: Number(site.fileCount || 0),
      sizeBytes: Number(site.sizeBytes || 0),
      createdBy: owner || site.visibility === 'public' ? site.createdBy || null : null,
      updatedBy: owner ? site.updatedBy || null : null,
    };
  }

  private defaultSiteName(siteId: string, config: ResolvedSitesConfig): string {
    return `${config.hostPrefix}-${siteId}`;
  }

  private expirationForNewSite(config: ResolvedSitesConfig): string | null {
    if (!config.ttl.enabled) {
      return null;
    }
    return new Date(Date.now() + config.ttl.defaultDays * DAY_MS).toISOString();
  }

  private async stageVersion(
    siteId: string,
    upload: ValidatedSiteUpload,
    config: ResolvedSitesConfig,
    uploadedStoragePrefixes: string[]
  ) {
    const versionId = createVersionId();
    const storage = new SitesStorage(config);
    const storagePrefix = storage.versionPrefix(siteId, versionId);
    uploadedStoragePrefixes.push(storagePrefix);
    await storage.putFiles(storagePrefix, upload.files);
    return {
      siteId,
      versionId,
      storagePrefix,
      entrypoint: upload.entrypoint,
      fileCount: upload.fileCount,
      sizeBytes: upload.sizeBytes,
      manifest: upload.files.map(({ path, sizeBytes, contentType }) => ({ path, sizeBytes, contentType })),
    };
  }

  private assertPrivateReady(config: ResolvedSitesConfig) {
    try {
      assertPrivateSitesReady(buildSiteUrl('readiness', config));
    } catch {
      throw new AppError({
        httpStatus: 503,
        code: 'private_sites_unavailable',
        message: 'Private Sites are not securely configured on this installation.',
      });
    }
  }

  private async audit(
    trx: Transaction,
    event: string,
    siteId: string,
    principal: Principal,
    meta: Record<string, unknown> = {}
  ) {
    await recordAuthAuditEventInTransaction(trx, {
      event: `sites.${event}`,
      principalKind: principal.kind,
      principalId: principal.userId,
      actorId: principal.actor,
      tokenId: principal.tokenId,
      outcome: 'success',
      meta: { siteId, issuer: principal.issuer ?? null, ...meta },
    });
  }

  private checkRevision(site: Site, access?: number, content?: number) {
    if (
      (access !== undefined && access !== site.accessRevision) ||
      (content !== undefined && content !== site.contentRevision)
    ) {
      throw new AppError({
        httpStatus: 409,
        code: 'site_changed',
        message: 'The site changed. Refresh it before trying again.',
      });
    }
  }

  async getCapabilities(principal: Principal) {
    await assertSitesPrincipal(principal);
    const config = await this.getConfig();
    const machine = principal.kind === 'service_key';
    let privateReady = false;
    try {
      this.assertPrivateReady(config);
      privateReady = true;
    } catch {
      /* Report unavailable, never silently publish. */
    }
    return {
      enabled: config.enabled,
      upload: config.upload,
      defaultVisibility: machine ? ('public' as const) : ('private' as const),
      allowedVisibilities:
        !config.enabled || !hasSitesScope(principal, 'write')
          ? []
          : machine
          ? ['public']
          : privateReady
          ? ['private', 'public']
          : [],
      canCreate: config.enabled && hasSitesScope(principal, 'write') && (machine || privateReady),
    };
  }

  private validateUpload(input: CreateOrReplaceSiteInput, config: ResolvedSitesConfig): ValidatedSiteUpload {
    try {
      return validateSiteUpload({
        fileName: input.fileName,
        content: input.content,
        maxUploadBytes: config.upload.maxUploadBytes,
        maxExtractedBytes: config.upload.maxExtractedBytes,
        maxFiles: config.upload.maxFiles,
        allowedExtensions: config.upload.allowedExtensions,
      });
    } catch (error) {
      if (error instanceof SiteUploadValidationError) {
        throw new SitesServiceError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private async cleanupStoragePrefixes(config: ResolvedSitesConfig, storagePrefixes: string[]) {
    await Promise.all(
      storagePrefixes.map((storagePrefix) =>
        new SitesStorage(config).deletePrefix(storagePrefix).catch((error) => {
          getLogger().warn({ error, storagePrefix }, 'Sites: failed to clean up uploaded prefix after error');
        })
      )
    );
  }

  private async withUploadRollback<T>(
    config: ResolvedSitesConfig,
    operation: (uploadedStoragePrefixes: string[]) => Promise<T>
  ): Promise<T> {
    const uploadedStoragePrefixes: string[] = [];
    try {
      return await operation(uploadedStoragePrefixes);
    } catch (error) {
      await this.cleanupStoragePrefixes(config, uploadedStoragePrefixes);
      throw error;
    }
  }

  private normalizePagination(filters: ListSitesFilters): { page: number; limit: number } {
    const page =
      Number.isFinite(filters.page) && Number(filters.page) > 0 ? Math.floor(Number(filters.page)) : DEFAULT_LIST_PAGE;
    const limit =
      Number.isFinite(filters.limit) && Number(filters.limit) > 0
        ? Math.min(Math.floor(Number(filters.limit)), MAX_LIST_LIMIT)
        : DEFAULT_LIST_LIMIT;

    return { page, limit };
  }

  private async cleanupSupersededVersions(config: ResolvedSitesConfig, siteId: string, versions: SiteVersion[]) {
    const deletedVersionIds: string[] = [];

    for (const version of versions) {
      try {
        await new SitesStorage(config).deletePrefix(version.storagePrefix);
        deletedVersionIds.push(version.versionId);
      } catch (error) {
        getLogger().warn(
          { error, siteId, versionId: version.versionId, storagePrefix: version.storagePrefix },
          'Sites: version cleanup deferred'
        );
      }
    }

    if (deletedVersionIds.length > 0) {
      await this.db.models.SiteVersion.query()
        .where({ siteId })
        .whereIn('versionId', deletedVersionIds)
        .patch({ deletedAt: new Date().toISOString() });
    }
  }

  async createSite(input: CreateOrReplaceSiteInput): Promise<SiteResponse> {
    await assertSitesPrincipal(input.principal, 'write');
    const config = await this.getConfig();
    this.assertEnabled(config);
    const principal = input.principal;
    const machine = principal.kind === 'service_key';
    const visibility = input.visibility ?? (machine ? 'public' : 'private');
    if (!['private', 'public'].includes(visibility) || (machine && visibility !== 'public')) {
      throw new SitesServiceError('Service-key sites must be public; visibility must be private or public.', 400);
    }
    if (principal.kind !== 'service_key' || visibility === 'private') this.assertPrivateReady(config);
    const upload = this.validateUpload(input, config);
    const siteId = createSiteId();
    const site = await this.withUploadRollback(config, async (prefixes) => {
      const version = await this.stageVersion(siteId, upload, config, prefixes);
      await assertSitesPrincipal(principal, 'write');
      return this.db.models.Site.transact(async (trx) => {
        await assertSitesPrincipal(principal, 'write', trx);
        const created = (await this.db.models.Site.query(trx).insert({
          siteId,
          name: input.name?.trim() || this.defaultSiteName(siteId, config),
          status: 'active',
          activeVersionId: null,
          fileCount: upload.fileCount,
          sizeBytes: upload.sizeBytes,
          expiresAt: this.expirationForNewSite(config),
          visibility,
          ownerKind: machine ? 'service_key' : 'user',
          ownerIssuer: machine ? null : principal.issuer,
          ownerSubject: machine ? null : principal.userId,
          creatorTokenId: machine ? principal.tokenId : null,
          accessRevision: 1,
          contentRevision: 1,
          createdBy: principal.identity?.email || null,
          updatedBy: principal.identity?.email || null,
        })) as Site;
        await this.db.models.SiteVersion.query(trx).insert(version);
        await this.audit(trx, 'created', siteId, principal, { visibility });
        return created.$query(trx).patchAndFetch({ activeVersionId: version.versionId }) as unknown as Promise<Site>;
      });
    });
    return this.serialize(site, config, principal);
  }

  async listSites(filters: ListSitesFilters = {}, principal: Principal): Promise<ListSitesResult> {
    await assertSitesPrincipal(principal);
    const config = await this.getConfig();
    this.assertEnabled(config);
    const { page, limit } = this.normalizePagination(filters);
    const view = filters.view ?? 'all';
    if (!['all', 'mine', 'public'].includes(view) || filters.user) {
      throw new SitesServiceError('Use view=mine, public, or all; email filters are not supported.', 400);
    }
    const owner =
      principal.kind === 'service_key'
        ? { ownerKind: 'service_key', creatorTokenId: principal.tokenId }
        : { ownerKind: 'user', ownerIssuer: principal.issuer, ownerSubject: principal.userId };
    const query = this.db.models.Site.query().whereNull('deletedAt');
    if (view === 'mine') query.where(owner);
    else if (view === 'public') query.where('visibility', 'public');
    else query.where((q) => q.where('visibility', 'public').orWhere(owner));
    const search = filters.q?.trim();
    if (search) {
      if (search.length > 200) throw new SitesServiceError('Search is too long.', 400);
      // Literal substring matching: user input never controls SQL wildcards.
      query.whereRaw('(strpos(lower("name"), lower(?)) > 0 or strpos(lower("siteId"), lower(?)) > 0)', [
        search,
        search,
      ]);
    }
    const result = await query
      .orderBy('createdAt', 'desc')
      .orderBy('siteId', 'asc')
      .page(page - 1, limit);
    return {
      sites: (result.results as Site[]).map((site) => this.serialize(site, config, principal)),
      pagination: { current: page, total: Math.max(Math.ceil(result.total / limit), 1), items: result.total, limit },
    };
  }

  async getSite(siteId: string, principal: Principal): Promise<SiteResponse> {
    await assertSitesPrincipal(principal);
    const config = await this.getConfig();
    this.assertEnabled(config);
    const site = (await this.db.models.Site.query().findOne({ siteId }).whereNull('deletedAt')) as Site | undefined;
    if (!site) throw new SitesServiceError('Site not found.', 404);
    // Internal tool: 403 here (not 404) so a denied teammate knows to ask the owner.
    if (site.visibility !== 'public' && !isSiteOwner(site, principal))
      throw new SitesServiceError('You do not have access to this Site.', 403);
    return this.serialize(site, config, principal);
  }

  private async getActiveSite(siteId: string, trx?: Transaction): Promise<{ site: Site; config: ResolvedSitesConfig }> {
    const config = await this.getConfig();
    this.assertEnabled(config);
    const query = this.db.models.Site.query(trx).findOne({ siteId }).whereNull('deletedAt');
    if (trx) query.forUpdate();
    const site = (await query) as Site | undefined;
    if (
      !site ||
      site.status !== 'active' ||
      !site.activeVersionId ||
      (site.expiresAt && new Date(site.expiresAt).getTime() <= Date.now())
    ) {
      throw new SitesServiceError('Site not found.', 404);
    }
    return { site, config };
  }

  async replaceSiteContent(siteId: string, input: CreateOrReplaceSiteInput): Promise<SiteResponse> {
    await assertSitesPrincipal(input.principal, 'write');
    const { site, config } = await this.getActiveSite(siteId);
    assertSiteOwner(site, input.principal);
    this.checkRevision(site, input.expectedAccessRevision, input.expectedContentRevision);
    const expectedAccess = input.expectedAccessRevision ?? site.accessRevision;
    const expectedContent = input.expectedContentRevision ?? site.contentRevision;
    const upload = this.validateUpload(input, config);
    let previousVersions: SiteVersion[] = [];
    const updated = await this.withUploadRollback(config, async (prefixes) => {
      const version = await this.stageVersion(siteId, upload, config, prefixes);
      await assertSitesPrincipal(input.principal, 'write');
      return this.db.models.Site.transact(async (trx) => {
        const { site: current } = await this.getActiveSite(siteId, trx);
        await assertSitesPrincipal(input.principal, 'write', trx);
        assertSiteOwner(current, input.principal);
        // Even old clients cannot overwrite a concurrent mutation after a long upload.
        this.checkRevision(current, expectedAccess, expectedContent);
        previousVersions = (await this.db.models.SiteVersion.query(trx)
          .where({ siteId })
          .whereNull('deletedAt')) as SiteVersion[];
        await this.db.models.SiteVersion.query(trx).insert(version);
        await this.audit(trx, 'content_replaced', siteId, input.principal, {
          accessRevision: current.accessRevision + 1,
          contentRevision: current.contentRevision + 1,
        });
        return current.$query(trx).patchAndFetch({
          activeVersionId: version.versionId,
          fileCount: upload.fileCount,
          sizeBytes: upload.sizeBytes,
          // Publishing/deleting must conflict if the content changed after confirmation was prepared.
          accessRevision: current.accessRevision + 1,
          contentRevision: current.contentRevision + 1,
          updatedBy: input.principal.identity?.email || null,
        }) as unknown as Promise<Site>;
      });
    });
    await this.cleanupSupersededVersions(config, siteId, previousVersions);
    return this.serialize(updated, config, input.principal);
  }

  async extendSite(siteId: string, principal: Principal, expectedAccessRevision?: number): Promise<SiteResponse> {
    await assertSitesPrincipal(principal, 'write');
    const result = await this.db.models.Site.transact(async (trx) => {
      const { site, config } = await this.getActiveSite(siteId, trx);
      await assertSitesPrincipal(principal, 'write', trx);
      assertSiteOwner(site, principal);
      this.checkRevision(site, expectedAccessRevision);
      if (!config.ttl.enabled) throw new SitesServiceError('TTL is disabled for hosted sites.', 400);
      const base = site.expiresAt ? Math.max(new Date(site.expiresAt).getTime(), Date.now()) : Date.now();
      await this.audit(trx, 'extended', siteId, principal, { accessRevision: site.accessRevision + 1 });
      const updated = await site.$query(trx).patchAndFetch({
        expiresAt: new Date(base + config.ttl.extensionDays * DAY_MS).toISOString(),
        accessRevision: site.accessRevision + 1,
      });
      return this.serialize(updated as Site, config, principal);
    });
    return result;
  }

  async setVisibility(
    siteId: string,
    visibility: 'private' | 'public',
    principal: Principal,
    expectedAccessRevision: number
  ): Promise<SiteResponse> {
    await assertSitesPrincipal(principal, 'write');
    if (
      !['private', 'public'].includes(visibility) ||
      !Number.isSafeInteger(expectedAccessRevision) ||
      expectedAccessRevision < 1
    ) {
      throw new SitesServiceError('Visibility and expectedAccessRevision are required.', 400);
    }
    if (visibility === 'private') this.assertPrivateReady(await this.getConfig());
    return this.db.models.Site.transact(async (trx) => {
      const { site, config } = await this.getActiveSite(siteId, trx);
      await assertSitesPrincipal(principal, 'write', trx);
      assertSiteOwner(site, principal);
      if (site.ownerKind !== 'user') throw new SitesServiceError('Only human-owned sites can change visibility.', 403);
      this.checkRevision(site, expectedAccessRevision);
      if (site.visibility === visibility) return this.serialize(site, config, principal);
      await this.audit(trx, 'visibility_changed', siteId, principal, {
        from: site.visibility,
        to: visibility,
        accessRevision: site.accessRevision + 1,
      });
      const updated = await site.$query(trx).patchAndFetch({
        visibility,
        accessRevision: site.accessRevision + 1,
      });
      return this.serialize(updated as Site, config, principal);
    });
  }

  async deleteSite(siteId: string, principal: Principal, expectedAccessRevision?: number): Promise<SiteResponse> {
    await assertSitesPrincipal(principal, 'write');
    const config = await this.getConfig();
    this.assertEnabled(config);
    const deleted = await this.db.models.Site.transact(async (trx) => {
      const site = (await this.db.models.Site.query(trx).findOne({ siteId }).whereNull('deletedAt').forUpdate()) as
        | Site
        | undefined;
      if (!site) throw new SitesServiceError('Site not found.', 404);
      await assertSitesPrincipal(principal, 'write', trx);
      assertSiteOwner(site, principal);
      this.checkRevision(site, expectedAccessRevision);
      await this.audit(trx, 'deleted', siteId, principal, { accessRevision: site.accessRevision + 1 });
      return site.$query(trx).patchAndFetch({
        status: 'deleted',
        deletedAt: new Date().toISOString(),
        accessRevision: site.accessRevision + 1,
      }) as unknown as Promise<Site>;
    });
    // Authorization is removed before storage. Failed cleanup is retried by the job.
    const versions = (await this.db.models.SiteVersion.query()
      .where({ siteId })
      .whereNull('deletedAt')) as SiteVersion[];
    await this.cleanupSupersededVersions(config, siteId, versions);
    return this.serialize(deleted, config, principal);
  }

  /** Anonymous stable-link resolver exposes only a currently public content URL. */
  async resolvePublicSiteUrl(siteId: string): Promise<string | null> {
    try {
      const { site, config } = await this.getActiveSite(siteId);
      return site.visibility === 'public' ? buildSiteUrl(siteId, config) : null;
    } catch (error) {
      if (error instanceof SitesServiceError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async getGatewayLocator(hostHeader: string | undefined): Promise<Pick<Site, 'siteId'>> {
    const config = await this.getConfig();
    const siteId = parseSiteIdFromHost(hostHeader, config);
    if (!config.enabled || !siteId) throw new SitesServiceError('Site not found.', 404);
    const expected = new URL(buildSiteUrl(siteId, config));
    const requested = new URL(`${expected.protocol}//${hostHeader}`);
    if (requested.host.toLowerCase() !== expected.host.toLowerCase())
      throw new SitesServiceError('Site not found.', 404);
    this.assertPrivateReady(config);
    return { siteId };
  }

  async getGatewaySite(hostHeader: string | undefined): Promise<{ site: Site; config: ResolvedSitesConfig }> {
    const config = await this.getConfig();
    const siteId = parseSiteIdFromHost(hostHeader, config);
    if (!siteId) throw new SitesServiceError('Site not found.', 404);
    const result = await this.getActiveSite(siteId);
    const expectedHost = new URL(buildSiteUrl(siteId, result.config)).host.toLowerCase();
    let requestedHost: string;
    try {
      requestedHost = new URL(
        `${new URL(buildSiteUrl(siteId, result.config)).protocol}//${hostHeader}`
      ).host.toLowerCase();
    } catch {
      throw new SitesServiceError('Site not found.', 404);
    }
    if (requestedHost !== expectedHost) throw new SitesServiceError('Site not found.', 404);
    if (result.site.visibility === 'private') this.assertPrivateReady(result.config);
    return result;
  }

  async getGatewayObject(
    hostHeader: string | undefined,
    pathname: string,
    authorize?: (site: Site) => Promise<void>
  ): Promise<GatewayObjectResponse> {
    const { site, config } = await this.getGatewaySite(hostHeader);
    const siteId = site.siteId;
    if (site.visibility === 'private') {
      if (!authorize) throw new SitesServiceError('Site not found.', 404);
      await authorize(site);
    }
    const version = (await this.db.models.SiteVersion.query().findOne({
      siteId,
      versionId: site.activeVersionId,
    })) as unknown as SiteVersion | undefined;

    if (!version) {
      throw new SitesServiceError('Site not found.', 404);
    }

    const storage = new SitesStorage(config);
    let requestedPath: string;
    try {
      requestedPath =
        pathname === '/' || pathname === '' ? version.entrypoint || 'index.html' : normalizeGatewayPath(pathname);
    } catch (error) {
      if (error instanceof SiteUploadValidationError || error instanceof URIError) {
        throw new SitesServiceError('Site not found.', 404);
      }
      throw error;
    }

    try {
      const object = await storage.getObject(version.storagePrefix, requestedPath);
      return {
        body: object.body,
        contentType: object.contentType || getContentType(requestedPath),
        contentLength: object.contentLength,
        statusCode: 200,
      };
    } catch (error) {
      throw error instanceof SitesObjectNotFoundError ? new SitesServiceError('Site not found.', 404) : error;
    }
  }

  async matchesGatewayHost(hostHeader: string | undefined): Promise<boolean> {
    const config = await this.getConfig();
    const host = hostHeader?.split(':')[0].toLowerCase();
    return Boolean(host && host.endsWith(`.${config.domain.toLowerCase()}`));
  }

  async cleanupExpiredSites(): Promise<{ expired: number; cleaned: number; errors: number }> {
    const config = await this.getConfig();
    if (!config.enabled || !config.cleanup.enabled) return { expired: 0, cleaned: 0, errors: 0 };
    const now = new Date().toISOString();
    // Atomic predicate cannot expire an extension that won the row lock first.
    const expired = await this.db.models.Site.query()
      .whereNull('deletedAt')
      .where('status', 'active')
      .whereNotNull('expiresAt')
      .where('expiresAt', '<=', now)
      .patch({ status: 'expired', deletedAt: now });
    const pending = (await this.db.models.SiteVersion.query()
      .whereNull('site_versions.deletedAt')
      .join('sites', 'sites.siteId', 'site_versions.siteId')
      .whereRaw('(sites.status IN (?, ?) OR sites."activeVersionId" IS DISTINCT FROM site_versions."versionId")', [
        'deleted',
        'expired',
      ])
      .select('site_versions.*')
      .limit(100)) as SiteVersion[];
    let cleaned = 0;
    let errors = 0;
    for (const version of pending) {
      try {
        await new SitesStorage(config).deletePrefix(version.storagePrefix);
        await version.$query().patch({ deletedAt: now });
        cleaned++;
      } catch (error) {
        errors++;
        getLogger().warn({ error, siteId: version.siteId }, 'Sites: terminal storage cleanup deferred');
      }
    }
    return { expired, cleaned, errors };
  }

  processSitesCleanupQueue = async (_job: Job) => {
    const result = await this.cleanupExpiredSites();
    getLogger().info(
      `Sites: cleanup complete expired=${result.expired} cleaned=${result.cleaned} errors=${result.errors}`
    );
    return result;
  };

  async setupSitesCleanupJob() {
    const config = await this.getConfig();
    if (!config.enabled || !config.cleanup.enabled) {
      getLogger().debug('Sites: cleanup disabled');
      return;
    }

    await this.sitesCleanupQueue.add(
      'sites-cleanup',
      {},
      {
        jobId: 'sites-cleanup',
        repeat: {
          every: config.cleanup.intervalMinutes * 60 * 1000,
        },
      }
    );
  }
}
