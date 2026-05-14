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
import type { RequestUserIdentity } from 'server/lib/get-user';

const createSiteId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);
const createVersionId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const DAY_MS = 24 * 60 * 60 * 1000;
type SitesErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503;

export class SitesServiceError extends Error {
  constructor(message: string, public statusCode: SitesErrorStatusCode = 500) {
    super(message);
  }
}

export type CreateOrReplaceSiteInput = {
  fileName: string;
  content: Buffer;
  name?: string | null;
  user?: RequestUserIdentity | null;
};

export type SiteResponse = {
  id: string;
  name: string;
  url: string;
  status: string;
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

  private serialize(site: Site, config: ResolvedSitesConfig): SiteResponse {
    return {
      id: site.siteId,
      name: site.name,
      url: buildSiteUrl(site.siteId, config),
      status: site.status,
      createdAt: site.createdAt || null,
      updatedAt: site.updatedAt || null,
      expiresAt: site.expiresAt || null,
      fileCount: Number(site.fileCount || 0),
      sizeBytes: Number(site.sizeBytes || 0),
      createdBy: site.createdBy || null,
      updatedBy: site.updatedBy || null,
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

  private async createVersion(
    siteId: string,
    upload: ValidatedSiteUpload,
    config: ResolvedSitesConfig,
    uploadedStoragePrefixes: string[],
    trx?: Transaction
  ): Promise<SiteVersion> {
    const versionId = createVersionId();
    const storage = new SitesStorage(config);
    const storagePrefix = storage.versionPrefix(siteId, versionId);

    uploadedStoragePrefixes.push(storagePrefix);
    await storage.putFiles(storagePrefix, upload.files);

    return this.db.models.SiteVersion.query(trx).insert({
      siteId,
      versionId,
      storagePrefix,
      entrypoint: upload.entrypoint,
      fileCount: upload.fileCount,
      sizeBytes: upload.sizeBytes,
      manifest: upload.files.map(({ path, sizeBytes, contentType }) => ({ path, sizeBytes, contentType })),
    }) as unknown as Promise<SiteVersion>;
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
    const config = await this.getConfig();
    this.assertEnabled(config);
    const upload = this.validateUpload(input, config);
    const siteId = createSiteId();
    const siteName = input.name?.trim() || this.defaultSiteName(siteId, config);
    const expiresAt = this.expirationForNewSite(config);

    const site = await this.withUploadRollback(config, (uploadedStoragePrefixes) =>
      this.db.models.Site.transact(async (trx) => {
        const created = (await this.db.models.Site.query(trx).insert({
          siteId,
          name: siteName,
          status: 'active',
          activeVersionId: null,
          fileCount: 0,
          sizeBytes: 0,
          expiresAt,
          createdBy: input.user?.email || null,
          updatedBy: input.user?.email || null,
        })) as Site;

        const version = await this.createVersion(siteId, upload, config, uploadedStoragePrefixes, trx);
        return created.$query(trx).patchAndFetch({
          activeVersionId: version.versionId,
          fileCount: upload.fileCount,
          sizeBytes: upload.sizeBytes,
        }) as unknown as Promise<Site>;
      })
    );

    return this.serialize(site, config);
  }

  async listSites(): Promise<SiteResponse[]> {
    const config = await this.getConfig();
    this.assertEnabled(config);

    const sites = (await this.db.models.Site.query()
      .whereNull('deletedAt')
      .orderBy('updatedAt', 'desc')) as unknown as Site[];
    return sites.map((site) => this.serialize(site, config));
  }

  async getSite(siteId: string): Promise<SiteResponse> {
    const config = await this.getConfig();
    this.assertEnabled(config);

    const site = (await this.db.models.Site.query().findOne({ siteId }).whereNull('deletedAt')) as unknown as
      | Site
      | undefined;
    if (!site) {
      throw new SitesServiceError('Site not found.', 404);
    }

    return this.serialize(site, config);
  }

  private async getActiveSite(siteId: string): Promise<{ site: Site; config: ResolvedSitesConfig }> {
    const config = await this.getConfig();
    this.assertEnabled(config);

    const site = (await this.db.models.Site.query().findOne({ siteId }).whereNull('deletedAt')) as unknown as
      | Site
      | undefined;
    if (!site || site.status !== 'active' || !site.activeVersionId) {
      throw new SitesServiceError('Site not found.', 404);
    }

    if (config.ttl.enabled && site.expiresAt && new Date(site.expiresAt).getTime() <= Date.now()) {
      throw new SitesServiceError('Site not found.', 404);
    }

    return { site, config };
  }

  async replaceSiteContent(siteId: string, input: CreateOrReplaceSiteInput): Promise<SiteResponse> {
    const { site, config } = await this.getActiveSite(siteId);
    const upload = this.validateUpload(input, config);

    let previousVersions: SiteVersion[] = [];
    const updated = await this.withUploadRollback(config, (uploadedStoragePrefixes) =>
      this.db.models.Site.transact(async (trx) => {
        previousVersions = (await this.db.models.SiteVersion.query(trx)
          .where({ siteId })
          .whereNull('deletedAt')) as unknown as SiteVersion[];
        const version = await this.createVersion(siteId, upload, config, uploadedStoragePrefixes, trx);
        const patched = (await site.$query(trx).patchAndFetch({
          activeVersionId: version.versionId,
          fileCount: upload.fileCount,
          sizeBytes: upload.sizeBytes,
          updatedBy: input.user?.email || site.updatedBy || null,
        })) as Site;

        return patched;
      })
    );

    await this.cleanupSupersededVersions(config, siteId, previousVersions);

    return this.serialize(updated, config);
  }

  async extendSite(siteId: string): Promise<SiteResponse> {
    const { site, config } = await this.getActiveSite(siteId);
    if (!config.ttl.enabled) {
      throw new SitesServiceError('TTL is disabled for hosted sites.', 400);
    }

    const base = site.expiresAt ? Math.max(new Date(site.expiresAt).getTime(), Date.now()) : Date.now();
    const expiresAt = new Date(base + config.ttl.extensionDays * DAY_MS).toISOString();
    const updated = (await site.$query().patchAndFetch({ expiresAt })) as Site;
    return this.serialize(updated, config);
  }

  async deleteSite(siteId: string): Promise<SiteResponse> {
    const config = await this.getConfig();
    this.assertEnabled(config);

    const site = (await this.db.models.Site.query().findOne({ siteId }).whereNull('deletedAt')) as unknown as
      | Site
      | undefined;
    if (!site) {
      throw new SitesServiceError('Site not found.', 404);
    }

    const versions = (await this.db.models.SiteVersion.query().where({ siteId })) as unknown as SiteVersion[];
    await Promise.all(versions.map((version) => new SitesStorage(config).deletePrefix(version.storagePrefix)));

    const deleted = (await this.db.models.Site.transact(async (trx) => {
      const timestamp = new Date().toISOString();
      const patched = (await site.$query(trx).patchAndFetch({
        status: 'deleted',
        deletedAt: timestamp,
      })) as Site;
      await this.db.models.SiteVersion.query(trx)
        .where({ siteId })
        .whereNull('deletedAt')
        .patch({ deletedAt: timestamp });
      return patched;
    })) as Site;

    return this.serialize(deleted, config);
  }

  async getGatewayObject(hostHeader: string | undefined, pathname: string): Promise<GatewayObjectResponse> {
    const config = await this.getConfig();
    this.assertEnabled(config);

    const siteId = parseSiteIdFromHost(hostHeader, config);
    if (!siteId) {
      throw new SitesServiceError('Site not found.', 404);
    }

    const { site } = await this.getActiveSite(siteId);
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
    if (!config.enabled) {
      return false;
    }
    return Boolean(parseSiteIdFromHost(hostHeader, config));
  }

  async cleanupExpiredSites(): Promise<{ expired: number; cleaned: number; errors: number }> {
    const config = await this.getConfig();
    if (!config.enabled || !config.ttl.enabled || !config.cleanup.enabled) {
      return { expired: 0, cleaned: 0, errors: 0 };
    }

    const expiredSites = (await this.db.models.Site.query()
      .whereNull('deletedAt')
      .where('status', 'active')
      .whereNotNull('expiresAt')
      .where('expiresAt', '<=', new Date().toISOString())
      .limit(100)) as unknown as Site[];

    let cleaned = 0;
    let errors = 0;

    for (const site of expiredSites) {
      try {
        const versions = (await this.db.models.SiteVersion.query().where({
          siteId: site.siteId,
        })) as unknown as SiteVersion[];
        await Promise.all(versions.map((version) => new SitesStorage(config).deletePrefix(version.storagePrefix)));

        const timestamp = new Date().toISOString();
        await this.db.models.Site.transact(async (trx) => {
          await site.$query(trx).patch({ status: 'expired', deletedAt: timestamp });
          await this.db.models.SiteVersion.query(trx)
            .where({ siteId: site.siteId })
            .whereNull('deletedAt')
            .patch({ deletedAt: timestamp });
        });
        cleaned++;
      } catch (error) {
        errors++;
        getLogger().error({ error, siteId: site.siteId }, 'Sites: cleanup failed');
      }
    }

    return { expired: expiredSites.length, cleaned, errors };
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
    if (!config.enabled || !config.ttl.enabled || !config.cleanup.enabled) {
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
