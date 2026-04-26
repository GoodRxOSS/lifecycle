/**
 * Copyright 2025 GoodRx, Inc.
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

import { getLogger } from 'server/lib/logger';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { PaginationMetadata } from 'server/lib/paginate';
import { getUtcTimestamp } from 'server/lib/time';
import * as github from 'server/lib/github';
import { Repository } from 'server/models';
import { GITHUB_API_CACHE_EXPIRATION_SECONDS } from 'shared/constants';
import { GITHUB_APP_INSTALLATION_ID } from 'shared/config';
import BaseService from './_service';
import EnvironmentService from './environment';

const GITHUB_REPOSITORIES_PAGE_SIZE = 100;
const ONBOARDED_REPOSITORY_CACHE_TTL_SECONDS = GITHUB_API_CACHE_EXPIRATION_SECONDS;
const NOT_ONBOARDED_REPOSITORY_CACHE_TTL_SECONDS = 60;

export const githubInstalledRepositoriesCacheKey = (installationId: number) => `github:installed:${installationId}`;
export const githubOnboardedRepositoryCacheKey = (installationId: number, githubRepositoryId: number) =>
  `github:onboarded:${installationId}:${githubRepositoryId}`;

export interface RepositoryResponse {
  id: number;
  githubRepositoryId: number;
  githubInstallationId: number;
  ownerId: number | null;
  fullName: string;
  htmlUrl: string | null;
  defaultEnvId: number | null;
  onboarded: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface InstalledRepositoryResponse {
  githubRepositoryId: number;
  ownerId: number | null;
  ownerLogin: string | null;
  name: string;
  fullName: string;
  htmlUrl: string | null;
  private: boolean | null;
  archived: boolean | null;
  disabled: boolean | null;
  visibility: string | null;
  defaultBranch: string | null;
  updatedAt: string | null;
  pushedAt: string | null;
  onboarded?: boolean;
}

export interface OnboardRepositoryResult {
  repository: RepositoryResponse;
  created: boolean;
}

export interface RepositoryListResult<T> {
  repositories: T[];
  pagination: PaginationMetadata;
}

interface RepositoryMetadata {
  ownerId?: number | null;
  githubRepositoryId: number;
  githubInstallationId: number;
  name?: string | null;
  ownerLogin?: string | null;
  fullName: string;
  htmlUrl?: string | null;
  defaultEnvId?: number | null;
}

interface ListRepositoriesOptions {
  query?: string;
  page?: number;
  limit?: number;
  installationId?: number | string | null;
  onboarded?: boolean;
  refresh?: boolean;
}

interface InstalledRepositoriesCachePayload {
  installationId: number;
  fetchedAt: string;
  repositories: InstalledRepositoryResponse[];
}

type OnboardedRepositoryCachePayload =
  | {
      onboarded: true;
      repositoryId: number;
      githubRepositoryId: number;
      githubInstallationId: number;
      fullName: string;
    }
  | {
      onboarded: false;
    };

function parseBooleanParam(value?: string | null): boolean | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('onboarded must be true or false');
}

function paginateArray<T>(items: T[], page = 1, limit = 25): RepositoryListResult<T> {
  const normalizedPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 25;
  const start = (normalizedPage - 1) * normalizedLimit;
  const repositories = items.slice(start, start + normalizedLimit);

  return {
    repositories,
    pagination: {
      current: normalizedPage,
      total: Math.max(Math.ceil(items.length / normalizedLimit), 1),
      items: items.length,
      limit: normalizedLimit,
    },
  };
}

export default class RepositoryService extends BaseService {
  public parseOnboardedParam = parseBooleanParam;
  private readonly environmentService = new EnvironmentService(this.db, this.redis, this.redlock, this.queueManager);

  private resolveInstallationId(installationId?: number | string | null): number {
    const rawInstallationId = installationId ?? GITHUB_APP_INSTALLATION_ID;
    const resolvedInstallationId =
      typeof rawInstallationId === 'number' ? rawInstallationId : Number.parseInt(String(rawInstallationId), 10);

    if (!Number.isFinite(resolvedInstallationId)) {
      throw new Error('A valid GitHub App installation ID is required');
    }

    return resolvedInstallationId;
  }

  private normalizeAndValidateFullName(rawFullName: string): string {
    const fullName = normalizeRepoFullName(rawFullName || '');
    if ((fullName.match(/\//g) || []).length !== 1) {
      throw new Error('Invalid repository fullName. Expected format: owner/repo');
    }

    return fullName;
  }

  private normalizeQuery(query?: string): string {
    return (query || '').trim().toLowerCase();
  }

  private toRepositoryResponse(repository: Repository, onboarded = true): RepositoryResponse {
    return {
      id: repository.id,
      githubRepositoryId: repository.githubRepositoryId,
      githubInstallationId: repository.githubInstallationId,
      ownerId: repository.ownerId ?? null,
      fullName: repository.fullName,
      htmlUrl: repository.htmlUrl ?? null,
      defaultEnvId: repository.defaultEnvId ?? null,
      onboarded,
      createdAt: repository.createdAt,
      updatedAt: repository.updatedAt,
      deletedAt: repository.deletedAt ?? null,
    };
  }

  private normalizeGithubRepository(repo: any): InstalledRepositoryResponse {
    return {
      githubRepositoryId: repo.id,
      ownerId: repo.owner?.id ?? null,
      ownerLogin: repo.owner?.login ?? null,
      name: repo.name,
      fullName: repo.full_name,
      htmlUrl: repo.html_url ?? null,
      private: typeof repo.private === 'boolean' ? repo.private : null,
      archived: typeof repo.archived === 'boolean' ? repo.archived : null,
      disabled: typeof repo.disabled === 'boolean' ? repo.disabled : null,
      visibility: repo.visibility ?? null,
      defaultBranch: repo.default_branch ?? null,
      updatedAt: repo.updated_at ?? null,
      pushedAt: repo.pushed_at ?? null,
    };
  }

  private normalizeWebhookRepository(metadata: RepositoryMetadata): InstalledRepositoryResponse {
    const [, repoName] = metadata.fullName.split('/');
    return {
      githubRepositoryId: metadata.githubRepositoryId,
      ownerId: metadata.ownerId ?? null,
      ownerLogin: metadata.ownerLogin ?? null,
      name: metadata.name || repoName,
      fullName: metadata.fullName,
      htmlUrl: metadata.htmlUrl ?? null,
      private: null,
      archived: null,
      disabled: null,
      visibility: null,
      defaultBranch: null,
      updatedAt: null,
      pushedAt: null,
    };
  }

  private async patchRepositoryMetadata(repository: Repository, metadata: RepositoryMetadata): Promise<Repository> {
    const patch: Record<string, unknown> = {};

    if (metadata.ownerId != null && repository.ownerId !== metadata.ownerId) patch.ownerId = metadata.ownerId;
    if (metadata.fullName && repository.fullName !== metadata.fullName) patch.fullName = metadata.fullName;
    if (metadata.htmlUrl && repository.htmlUrl !== metadata.htmlUrl) patch.htmlUrl = metadata.htmlUrl;
    if (metadata.defaultEnvId != null && !repository.defaultEnvId) patch.defaultEnvId = metadata.defaultEnvId;
    if (repository.deletedAt) patch.deletedAt = null;

    if (!Object.keys(patch).length) {
      return repository;
    }

    return await repository.$query().patchAndFetch(patch);
  }

  private async writeOnboardedRepositoryCache(repository: Repository): Promise<void> {
    const payload: OnboardedRepositoryCachePayload = {
      onboarded: true,
      repositoryId: repository.id,
      githubRepositoryId: repository.githubRepositoryId,
      githubInstallationId: repository.githubInstallationId,
      fullName: repository.fullName,
    };

    await this.redis.set(
      githubOnboardedRepositoryCacheKey(repository.githubInstallationId, repository.githubRepositoryId),
      JSON.stringify(payload),
      'EX',
      ONBOARDED_REPOSITORY_CACHE_TTL_SECONDS
    );
  }

  private async writeNotOnboardedRepositoryCache(
    githubInstallationId: number,
    githubRepositoryId: number
  ): Promise<void> {
    const payload: OnboardedRepositoryCachePayload = { onboarded: false };
    await this.redis.set(
      githubOnboardedRepositoryCacheKey(githubInstallationId, githubRepositoryId),
      JSON.stringify(payload),
      'EX',
      NOT_ONBOARDED_REPOSITORY_CACHE_TTL_SECONDS
    );
  }

  private async patchInstalledRepositoriesCache(metadata: RepositoryMetadata): Promise<void> {
    const cacheKey = githubInstalledRepositoriesCacheKey(metadata.githubInstallationId);
    const cached = await this.redis.get(cacheKey);
    if (!cached) return;

    try {
      const payload = JSON.parse(cached) as InstalledRepositoriesCachePayload;
      const repository = this.normalizeWebhookRepository(metadata);
      const nextRepositories = payload.repositories.map((existing) =>
        existing.githubRepositoryId === metadata.githubRepositoryId
          ? {
              ...existing,
              ownerId: repository.ownerId ?? existing.ownerId,
              ownerLogin: repository.ownerLogin ?? existing.ownerLogin,
              name: repository.name,
              fullName: repository.fullName,
              htmlUrl: repository.htmlUrl,
            }
          : existing
      );

      await this.redis.set(
        cacheKey,
        JSON.stringify({
          ...payload,
          repositories: nextRepositories,
        }),
        'EX',
        GITHUB_API_CACHE_EXPIRATION_SECONDS
      );
    } catch (error) {
      getLogger({ error, cacheKey }).warn('Repository: installed cache patch failed');
      await this.redis.del(cacheKey);
    }
  }

  private async patchOnboardedRepositoryCache(repository: Repository): Promise<void> {
    const cacheKey = githubOnboardedRepositoryCacheKey(repository.githubInstallationId, repository.githubRepositoryId);
    const cached = await this.redis.get(cacheKey);
    if (!cached) return;

    try {
      const payload = JSON.parse(cached) as OnboardedRepositoryCachePayload;
      if (!payload.onboarded) return;
      await this.writeOnboardedRepositoryCache(repository);
    } catch (error) {
      getLogger({ error, cacheKey }).warn('Repository: onboarded cache patch failed');
      await this.redis.del(cacheKey);
    }
  }

  private async readInstalledRepositoriesCache(
    installationId: number
  ): Promise<InstalledRepositoriesCachePayload | null> {
    const cached = await this.redis.get(githubInstalledRepositoriesCacheKey(installationId));
    if (!cached) return null;

    try {
      return JSON.parse(cached) as InstalledRepositoriesCachePayload;
    } catch (error) {
      getLogger({ error, installationId }).warn('Repository: installed cache parse failed');
      await this.redis.del(githubInstalledRepositoriesCacheKey(installationId));
      return null;
    }
  }

  private async writeInstalledRepositoriesCache(payload: InstalledRepositoriesCachePayload): Promise<void> {
    await this.redis.set(
      githubInstalledRepositoriesCacheKey(payload.installationId),
      JSON.stringify(payload),
      'EX',
      GITHUB_API_CACHE_EXPIRATION_SECONDS
    );
  }

  private async fetchInstalledRepositoriesFromGithub(installationId: number): Promise<InstalledRepositoryResponse[]> {
    const repositories: InstalledRepositoryResponse[] = [];
    let page = 1;
    let totalCount = Number.POSITIVE_INFINITY;

    while (repositories.length < totalCount) {
      const response = await github.listInstallationRepositories({
        installationId,
        page,
        perPage: GITHUB_REPOSITORIES_PAGE_SIZE,
      });
      const pageRepositories = response.data?.repositories || [];
      totalCount = response.data?.total_count ?? repositories.length + pageRepositories.length;
      repositories.push(...pageRepositories.map((repo) => this.normalizeGithubRepository(repo)));

      if (pageRepositories.length < GITHUB_REPOSITORIES_PAGE_SIZE) {
        break;
      }
      page += 1;
    }

    return repositories;
  }

  private async getInstalledRepositories(
    installationId: number,
    refresh = false
  ): Promise<InstalledRepositoryResponse[]> {
    if (!refresh) {
      const cached = await this.readInstalledRepositoriesCache(installationId);
      if (cached) return cached.repositories;
    }

    const repositories = await this.fetchInstalledRepositoriesFromGithub(installationId);
    await this.writeInstalledRepositoriesCache({
      installationId,
      fetchedAt: new Date().toISOString(),
      repositories,
    });

    return repositories;
  }

  private async getActiveOnboardedRepositories(installationId?: number): Promise<Repository[]> {
    const query = this.db.models.Repository.query().whereNull('deletedAt');
    if (installationId) {
      query.where('githubInstallationId', installationId);
    }
    return await query;
  }

  async findRepositoryByGithubId(
    githubRepositoryId: number,
    githubInstallationId: number,
    { includeDeleted = false }: { includeDeleted?: boolean } = {}
  ): Promise<Repository | undefined> {
    try {
      const query = this.db.models.Repository.query().where({
        githubRepositoryId,
        githubInstallationId,
      });

      if (!includeDeleted) {
        query.whereNull('deletedAt');
      }

      return await query.first();
    } catch (error) {
      getLogger({ githubRepositoryId, githubInstallationId, error }).error('Repository: find by GitHub ID failed');
      throw error;
    }
  }

  async listOnboardedRepositories({
    query,
    page = 1,
    limit = 25,
    installationId,
  }: ListRepositoriesOptions = {}): Promise<RepositoryListResult<RepositoryResponse>> {
    const normalizedQuery = this.normalizeQuery(query);
    const githubInstallationId = installationId == null ? null : this.resolveInstallationId(installationId);
    const repositoryQuery = this.db.models.Repository.query().whereNull('deletedAt');

    if (githubInstallationId) {
      repositoryQuery.where('githubInstallationId', githubInstallationId);
    }

    if (normalizedQuery) {
      repositoryQuery.whereRaw('lower("fullName") like ?', [`%${normalizedQuery}%`]);
    }

    const normalizedPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 25;
    const result = await repositoryQuery.orderBy('fullName', 'asc').page(normalizedPage - 1, normalizedLimit);

    return {
      repositories: result.results.map((repository) => this.toRepositoryResponse(repository, true)),
      pagination: {
        current: normalizedPage,
        total: Math.max(Math.ceil(result.total / normalizedLimit), 1),
        items: result.total,
        limit: normalizedLimit,
      },
    };
  }

  async listInstalledRepositories({
    query,
    page = 1,
    limit = 25,
    installationId,
    onboarded,
    refresh = false,
  }: ListRepositoriesOptions = {}): Promise<RepositoryListResult<InstalledRepositoryResponse>> {
    const githubInstallationId = this.resolveInstallationId(installationId);
    const normalizedQuery = this.normalizeQuery(query);
    const installedRepositories = await this.getInstalledRepositories(githubInstallationId, refresh);
    const onboardedRepositories = await this.getActiveOnboardedRepositories(githubInstallationId);
    const onboardedRepositoryIds = new Set(onboardedRepositories.map((repository) => repository.githubRepositoryId));

    const repositories = installedRepositories
      .map((repository) => ({
        ...repository,
        onboarded: onboardedRepositoryIds.has(repository.githubRepositoryId),
      }))
      .filter((repository) => {
        if (typeof onboarded === 'boolean' && repository.onboarded !== onboarded) return false;
        if (!normalizedQuery) return true;
        return (
          repository.fullName.toLowerCase().includes(normalizedQuery) ||
          repository.name.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName));

    return paginateArray(repositories, page, limit);
  }

  async syncRepositoryRename(metadata: RepositoryMetadata): Promise<Repository | null> {
    const repository = await this.findRepositoryByGithubId(metadata.githubRepositoryId, metadata.githubInstallationId);
    if (!repository) {
      return null;
    }

    const updatedRepository = await this.patchRepositoryMetadata(repository, metadata);
    await this.patchInstalledRepositoriesCache(metadata);
    await this.patchOnboardedRepositoryCache(updatedRepository);

    return updatedRepository;
  }

  async isRepositoryOnboarded(githubInstallationId: number, githubRepositoryId: number): Promise<boolean> {
    const cacheKey = githubOnboardedRepositoryCacheKey(githubInstallationId, githubRepositoryId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const payload = JSON.parse(cached) as OnboardedRepositoryCachePayload;
        return payload.onboarded;
      } catch (error) {
        getLogger({ error, cacheKey }).warn('Repository: onboarded cache parse failed');
        await this.redis.del(cacheKey);
      }
    }

    const repository = await this.findRepositoryByGithubId(githubRepositoryId, githubInstallationId);
    if (!repository) {
      await this.writeNotOnboardedRepositoryCache(githubInstallationId, githubRepositoryId);
      return false;
    }

    await this.writeOnboardedRepositoryCache(repository);
    return true;
  }

  async upsertRepositoryMetadata(metadata: RepositoryMetadata): Promise<OnboardRepositoryResult> {
    const repository = await this.findRepositoryByGithubId(metadata.githubRepositoryId, metadata.githubInstallationId, {
      includeDeleted: true,
    });

    if (repository) {
      const updatedRepository = await this.patchRepositoryMetadata(repository, metadata);
      await this.writeOnboardedRepositoryCache(updatedRepository);
      return {
        repository: this.toRepositoryResponse(updatedRepository, true),
        created: false,
      };
    }

    const createdRepository = await this.db.models.Repository.create({
      githubRepositoryId: metadata.githubRepositoryId,
      githubInstallationId: metadata.githubInstallationId,
      ownerId: metadata.ownerId,
      fullName: metadata.fullName,
      htmlUrl: metadata.htmlUrl,
      defaultEnvId: metadata.defaultEnvId,
      deletedAt: null,
    });

    await this.writeOnboardedRepositoryCache(createdRepository);

    return {
      repository: this.toRepositoryResponse(createdRepository, true),
      created: true,
    };
  }

  async onboardRepository(fullName: string, installationId?: number | string | null): Promise<OnboardRepositoryResult> {
    const normalizedFullName = this.normalizeAndValidateFullName(fullName);
    const githubInstallationId = this.resolveInstallationId(installationId);

    try {
      const repoResponse = await github.getRepositoryByFullName(normalizedFullName, githubInstallationId);
      const repo = repoResponse.data;
      const environment = await this.environmentService.findOrCreateEnvironment(repo.name, repo.name, false);

      return await this.upsertRepositoryMetadata({
        ownerId: repo.owner?.id,
        ownerLogin: repo.owner?.login,
        name: repo.name,
        githubRepositoryId: repo.id,
        githubInstallationId,
        fullName: repo.full_name,
        htmlUrl: repo.html_url,
        defaultEnvId: environment.id,
      });
    } catch (error) {
      getLogger({ fullName: normalizedFullName, installationId: githubInstallationId, error }).error(
        'Repository: onboard failed'
      );
      throw error;
    }
  }

  async removeRepository(fullName: string, installationId?: number | string | null): Promise<RepositoryResponse> {
    const normalizedFullName = this.normalizeAndValidateFullName(fullName);
    const githubInstallationId = installationId == null ? null : this.resolveInstallationId(installationId);

    try {
      const query = this.db.models.Repository.query()
        .whereNull('deletedAt')
        .whereRaw('lower("fullName") = ?', [normalizedFullName]);

      if (githubInstallationId) {
        query.where('githubInstallationId', githubInstallationId);
      }

      const repository = await query.first();
      if (!repository) {
        throw new Error(`Repository not found or already removed: ${normalizedFullName}`);
      }

      const removedRepository = await repository.$query().patchAndFetch({
        deletedAt: getUtcTimestamp(),
      });

      await this.writeNotOnboardedRepositoryCache(
        removedRepository.githubInstallationId,
        removedRepository.githubRepositoryId
      );

      return this.toRepositoryResponse(removedRepository, false);
    } catch (error) {
      getLogger({ fullName: normalizedFullName, installationId: githubInstallationId, error }).error(
        'Repository: remove failed'
      );
      throw error;
    }
  }

  /**
   * Retrieve a Lifecycle Github Repository model. If it doesn't exist, create a new record.
   * @param ownerId Github repoistory owner ID.
   * @param githubRepositoryId Github repository ID.
   * @param githubInstallationId Lifecycle Github installation ID.
   * @param fullName Github repository full name (including the owner/organization name).
   * @param htmlUrl Github repository owner URL.
   * @param defaultEnvId Default Lifecycle environment ID.
   * @returns Lifecycle Github Repository model.
   */
  async findOrCreateRepository(
    ownerId: number,
    githubRepositoryId: number,
    githubInstallationId: number,
    fullName: string,
    htmlUrl: string,
    defaultEnvId: number
  ) {
    let repository: Repository;

    try {
      repository =
        (await this.findRepository(ownerId, githubRepositoryId, githubInstallationId)) ||
        (await this.db.models.Repository.create({
          githubRepositoryId,
          githubInstallationId,
          ownerId,
          fullName,
          htmlUrl,
          defaultEnvId,
        }));
    } catch (error) {
      getLogger({ githubRepositoryId, error }).error('Repository: find or create failed');
      throw error;
    }

    return repository;
  }

  /**
   * Retrieve a Lifecycle Github Repository model.
   * @param ownerId Github repoistory owner ID.
   * @param githubRepositoryId Github repository ID.
   * @param githubInstallationId Lifecycle Github installation ID.
   * @returns Lifecycle Github Repository model.
   */
  async findRepository(
    ownerId: number,
    githubRepositoryId: number,
    githubInstallationId: number
  ): Promise<Repository | undefined> {
    let repository: Repository | undefined;

    try {
      repository = await this.db.models.Repository.query()
        .where({
          githubRepositoryId,
          githubInstallationId,
          ownerId,
        })
        .whereNull('deletedAt')
        .first();
    } catch (error) {
      getLogger({ githubRepositoryId, error }).error('Repository: find failed');
      throw error;
    }

    return repository;
  }

  async searchRepositories(query: string, limit = 10): Promise<RepositoryResponse[]> {
    const result = await this.listOnboardedRepositories({ query, limit });
    return result.repositories;
  }
}
