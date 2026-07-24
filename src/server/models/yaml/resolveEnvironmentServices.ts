/**
 * Copyright 2026 Lifecycle contributors
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

import { createHash } from 'crypto';
import { EmptyFileError, ParsingError } from 'server/lib/yamlConfigParser';
import { ValidationError } from 'server/lib/yamlConfigValidator';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { DeployTypes } from 'shared/constants';
import { getDeployingServicesByName, type LifecycleConfig } from './Config';
import { getBranchName, getDeployType, getRepositoryName, type DependencyService, type Service } from './YamlService';

const ENVIRONMENT_SERVICE_RESOLUTION_MAX_REFERENCES = 200;
const ENVIRONMENT_SERVICE_RESOLUTION_MAX_CONCURRENCY = 6;

export type EnvironmentServiceResolutionStatus = 'resolved' | 'unresolved' | 'invalid' | 'rate_limited' | 'truncated';

export type EnvironmentServiceResolutionReason =
  | 'repo_not_onboarded'
  | 'config_unavailable'
  | 'config_fetch_failed'
  | 'invalid_lifecycle_yaml'
  | 'github_rate_limited'
  | 'repository_name_missing'
  | 'service_name_missing'
  | 'service_not_found'
  | 'service_id_not_supported'
  | 'max_references_exceeded';

export interface ResolverRepository {
  githubRepositoryId: number;
  fullName: string;
}

export interface ResolveEnvironmentServicesDependencies<TRepository extends ResolverRepository> {
  resolveRepository(fullName: string): Promise<TRepository | null | undefined>;
  fetchConfig(repository: TRepository, branch: string): Promise<LifecycleConfig | null | undefined>;
}

export interface ResolveEnvironmentServicesLimits {
  maxReferences?: number;
  concurrency?: number;
}

export interface ResolveEnvironmentServicesInput<TRepository extends ResolverRepository> {
  rootRepository: TRepository;
  rootBranch: string;
  rootConfig: LifecycleConfig;
  dependencies: ResolveEnvironmentServicesDependencies<TRepository>;
  limits?: ResolveEnvironmentServicesLimits;
}

export interface ExactEnvironmentServiceResolution {
  service: Service;
  requiredServices: Service[];
}

export interface ResolvedEnvironmentService {
  key: string;
  name: string;
  originalName: string;
  type: DeployTypes | null;
  defaultActive: boolean;
  branchRepository?: string | null;
  branchConfigurationRepository?: string | null;
  effectiveBranch?: string | null;
  repository: string;
  branch: string;
  resolvedFromRepositoryId: number | null;
  status: EnvironmentServiceResolutionStatus;
  reason?: EnvironmentServiceResolutionReason;
}

export interface UnresolvedEnvironmentService {
  key: string;
  name: string;
  originalName: string;
  defaultActive: boolean;
  repository: string;
  branch: string;
  status: Exclude<EnvironmentServiceResolutionStatus, 'resolved'>;
  reason: EnvironmentServiceResolutionReason;
}

export interface PendingEnvironmentService {
  name: string;
  repository: string;
  branch: string;
  defaultActive: boolean;
}

export interface ResolvedEnvironmentServices {
  services: ResolvedEnvironmentService[];
  unresolved: UnresolvedEnvironmentService[];
  pending: PendingEnvironmentService[];
  complete: boolean;
  truncated: boolean;
}

interface EnvironmentEntry {
  reference: DependencyService;
  defaultActive: boolean;
  catalogFallback?: boolean;
}

interface ConfigContext<TRepository extends ResolverRepository> {
  repository: TRepository;
  repositoryName: string;
  branch: string;
  config: LifecycleConfig;
}

interface ClassifiedFailure {
  status: Exclude<EnvironmentServiceResolutionStatus, 'resolved' | 'truncated'>;
  reason: EnvironmentServiceResolutionReason;
}

interface ConfigLoadFailure {
  repository: string;
  branch: string;
  failure: ClassifiedFailure;
}

type ConfigLoadResult<TRepository extends ResolverRepository> =
  | { context: ConfigContext<TRepository> }
  | ConfigLoadFailure;

/** Resolves the exact service first, then its direct requires in their declaration order. */
export function resolveExactEnvironmentService(
  config: LifecycleConfig,
  reference: DependencyService
): ExactEnvironmentServiceResolution | null {
  const name = reference?.name;
  if (!name) return null;

  const service = getDeployingServicesByName(config, name);
  if (!service) return null;

  const requiredServices = (service.requires ?? [])
    .map((required) => (required.name != null ? getDeployingServicesByName(config, required.name) : undefined))
    .filter((required): required is Service => required != null);

  return { service, requiredServices };
}

function normalizedRepositoryName(fullName: string): string {
  return normalizeRepoFullName(fullName ?? '');
}

function positiveBoundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), maximum);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorHeaders(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as {
    headers?: Record<string, unknown>;
    response?: { headers?: Record<string, unknown> };
  };
  return candidate.response?.headers ?? candidate.headers ?? {};
}

function headerValue(headers: Record<string, unknown>, name: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] == null ? '' : String(entry[1]);
}

function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ParsingError || error instanceof ValidationError) {
    return { status: 'invalid', reason: 'invalid_lifecycle_yaml' };
  }
  if (error instanceof EmptyFileError) {
    return { status: 'unresolved', reason: 'config_unavailable' };
  }

  const candidate = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number; statusCode?: number };
    message?: string;
  };
  const status =
    candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status ?? candidate?.response?.statusCode;
  const headers = errorHeaders(error);
  const retryAfter = headerValue(headers, 'retry-after');
  const remaining = headerValue(headers, 'x-ratelimit-remaining');
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (
    status === 429 ||
    retryAfter.length > 0 ||
    remaining === '0' ||
    /rate[ -]?limit|too many requests/i.test(message)
  ) {
    return { status: 'rate_limited', reason: 'github_rate_limited' };
  }

  return { status: 'unresolved', reason: 'config_fetch_failed' };
}

function hashDiscriminator(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assignStableCollisionNames(
  services: ResolvedEnvironmentService[],
  rootRepositoryName: string
): ResolvedEnvironmentService[] {
  const groups = new Map<string, number[]>();
  services.forEach((service, index) => {
    const indexes = groups.get(service.originalName) ?? [];
    indexes.push(index);
    groups.set(service.originalName, indexes);
  });

  const names = services.map((service) => service.originalName);
  const reservedOriginalNames = new Set(groups.keys());
  const usedNames = new Set<string>();

  for (const [originalName, indexes] of groups) {
    if (indexes.length === 1) {
      names[indexes[0]] = originalName;
      usedNames.add(originalName);
      continue;
    }

    const sortedIndexes = [...indexes].sort((leftIndex, rightIndex) => {
      const left = services[leftIndex];
      const right = services[rightIndex];
      const leftRoot = normalizedRepositoryName(left.repository) === rootRepositoryName ? 0 : 1;
      const rightRoot = normalizedRepositoryName(right.repository) === rootRepositoryName ? 0 : 1;
      if (leftRoot !== rightRoot) return leftRoot - rightRoot;
      return `${normalizedRepositoryName(left.repository)}\0${left.branch}\0${left.key}`.localeCompare(
        `${normalizedRepositoryName(right.repository)}\0${right.branch}\0${right.key}`
      );
    });

    const keeperIndex = sortedIndexes[0];
    names[keeperIndex] = originalName;
    usedNames.add(originalName);

    for (const index of sortedIndexes.slice(1)) {
      const service = services[index];
      const source = `${normalizedRepositoryName(service.repository)}@${service.branch}#${service.key}`;
      const hash = hashDiscriminator(source);
      let hashLength = 6;
      let candidate = `${originalName}-${hash.slice(0, hashLength)}`;
      while ((usedNames.has(candidate) || reservedOriginalNames.has(candidate)) && hashLength < hash.length) {
        hashLength += 2;
        candidate = `${originalName}-${hash.slice(0, hashLength)}`;
      }
      let suffix = 2;
      while (usedNames.has(candidate) || reservedOriginalNames.has(candidate)) {
        candidate = `${originalName}-${hash}-${suffix++}`;
      }
      names[index] = candidate;
      usedNames.add(candidate);
    }
  }

  return services.map((service, index) => ({ ...service, name: names[index] }));
}

function failureRow(
  entry: EnvironmentEntry,
  repository: string,
  branch: string,
  status: Exclude<EnvironmentServiceResolutionStatus, 'resolved'>,
  reason: EnvironmentServiceResolutionReason
): ResolvedEnvironmentService {
  const originalName = entry.reference.name?.trim() || '(unnamed service)';
  const normalizedRepository = normalizedRepositoryName(repository);
  return {
    key: `issue:${normalizedRepository}@${branch}:${originalName}:${reason}`,
    name: originalName,
    originalName,
    type: null,
    defaultActive: entry.defaultActive,
    repository,
    branch,
    resolvedFromRepositoryId: null,
    status,
    reason,
  };
}

function resolvedRow<TRepository extends ResolverRepository>(
  entry: EnvironmentEntry,
  context: ConfigContext<TRepository>,
  service: Service
): ResolvedEnvironmentService {
  const repositoryId = Number(context.repository.githubRepositoryId);
  const type = getDeployType(service) ?? null;
  const branchRepository =
    type === DeployTypes.GITHUB || type === DeployTypes.HELM ? getRepositoryName(service)?.trim() || null : undefined;
  const branchConfigurationRepository =
    type === DeployTypes.GITHUB || type === DeployTypes.HELM
      ? entry.reference.repository != null
        ? context.repositoryName
        : null
      : undefined;
  const effectiveBranch =
    type === DeployTypes.GITHUB || type === DeployTypes.HELM
      ? entry.catalogFallback
        ? context.branch
        : branchRepository != null &&
          normalizedRepositoryName(branchRepository) === normalizedRepositoryName(context.repositoryName)
        ? context.branch
        : branchRepository == null
        ? 'main'
        : getBranchName(service) ?? 'main'
      : undefined;
  return {
    key: `service:${repositoryId}@${context.branch}:${service.name}`,
    name: service.name,
    originalName: service.name,
    type,
    defaultActive: entry.defaultActive,
    ...(branchRepository !== undefined ? { branchRepository } : {}),
    ...(branchConfigurationRepository !== undefined ? { branchConfigurationRepository } : {}),
    ...(effectiveBranch !== undefined ? { effectiveBranch } : {}),
    repository: context.repositoryName,
    branch: context.branch,
    resolvedFromRepositoryId: Number.isFinite(repositoryId) ? repositoryId : null,
    status: 'resolved',
  };
}

/**
 * Resolves the environment definition to exactly one row per defaultServices/optionalServices
 * entry (catalog fallback when both lists are empty). A service's `requires` deploy with it but
 * are not part of the choice surface, matching the build path and the legacy preview.
 */
export async function resolveEnvironmentServices<TRepository extends ResolverRepository>(
  input: ResolveEnvironmentServicesInput<TRepository>
): Promise<ResolvedEnvironmentServices> {
  const maxReferences = positiveBoundedInteger(
    input.limits?.maxReferences,
    ENVIRONMENT_SERVICE_RESOLUTION_MAX_REFERENCES,
    ENVIRONMENT_SERVICE_RESOLUTION_MAX_REFERENCES
  );
  const concurrency = positiveBoundedInteger(
    input.limits?.concurrency,
    ENVIRONMENT_SERVICE_RESOLUTION_MAX_CONCURRENCY,
    ENVIRONMENT_SERVICE_RESOLUTION_MAX_CONCURRENCY
  );
  const rootRepositoryName = normalizedRepositoryName(input.rootRepository.fullName);
  const rootContext: ConfigContext<TRepository> = {
    repository: input.rootRepository,
    repositoryName: input.rootRepository.fullName,
    branch: input.rootBranch,
    config: input.rootConfig,
  };

  const repositoryMemo = new Map<string, Promise<TRepository | null | undefined>>();
  repositoryMemo.set(rootRepositoryName, Promise.resolve(input.rootRepository));
  const configMemo = new Map<string, Promise<ConfigLoadResult<TRepository>>>();
  configMemo.set(`${rootRepositoryName}\0${input.rootBranch}`, Promise.resolve({ context: rootContext }));

  const loadContext = async (
    repositoryName: string,
    requestedBranch?: string
  ): Promise<ConfigLoadResult<TRepository>> => {
    const normalizedName = normalizedRepositoryName(repositoryName);
    const branch = requestedBranch ?? 'main';
    let repositoryPromise = repositoryMemo.get(normalizedName);
    if (!repositoryPromise) {
      repositoryPromise = input.dependencies.resolveRepository(repositoryName);
      repositoryMemo.set(normalizedName, repositoryPromise);
    }

    let loadedRepository: TRepository | null | undefined;
    try {
      loadedRepository = await repositoryPromise;
    } catch (error) {
      return { repository: repositoryName, branch, failure: classifyFailure(error) };
    }
    if (!loadedRepository) {
      return {
        repository: repositoryName,
        branch,
        failure: { status: 'unresolved', reason: 'repo_not_onboarded' },
      };
    }
    const repository = loadedRepository;

    const configKey = `${normalizedName}\0${branch}`;
    let configPromise = configMemo.get(configKey);
    if (!configPromise) {
      configPromise = (async (): Promise<ConfigLoadResult<TRepository>> => {
        try {
          const config = await input.dependencies.fetchConfig(repository, branch);
          if (!config) {
            return {
              repository: repository.fullName,
              branch,
              failure: { status: 'unresolved', reason: 'config_unavailable' },
            };
          }
          return { context: { repository, repositoryName: repository.fullName, branch, config } };
        } catch (error) {
          return { repository: repository.fullName, branch, failure: classifyFailure(error) };
        }
      })();
      configMemo.set(configKey, configPromise);
    }
    return configPromise;
  };

  const resolveEntry = async (entry: EnvironmentEntry): Promise<ResolvedEnvironmentService> => {
    const { reference } = entry;
    if (reference.serviceId != null) {
      return failureRow(
        entry,
        rootContext.repositoryName,
        rootContext.branch,
        'unresolved',
        'service_id_not_supported'
      );
    }

    const name = reference.name?.trim();
    if (!name) {
      return failureRow(entry, rootContext.repositoryName, rootContext.branch, 'unresolved', 'service_name_missing');
    }

    const referenceRepository = reference.repository;
    if (referenceRepository != null && normalizedRepositoryName(referenceRepository).length === 0) {
      return failureRow(
        entry,
        referenceRepository,
        reference.branch ?? 'main',
        'unresolved',
        'repository_name_missing'
      );
    }

    if (referenceRepository == null) {
      const exact = resolveExactEnvironmentService(rootContext.config, reference);
      if (exact) return resolvedRow(entry, rootContext, exact.service);
      return failureRow(entry, rootContext.repositoryName, rootContext.branch, 'unresolved', 'service_not_found');
    }

    const loaded = await loadContext(referenceRepository, reference.branch);
    if ('failure' in loaded) {
      return failureRow(entry, loaded.repository, loaded.branch, loaded.failure.status, loaded.failure.reason);
    }
    const exact = resolveExactEnvironmentService(loaded.context.config, reference);
    if (exact) return resolvedRow(entry, loaded.context, exact.service);
    return failureRow(entry, loaded.context.repositoryName, loaded.context.branch, 'unresolved', 'service_not_found');
  };

  const defaults = input.rootConfig.environment?.defaultServices ?? [];
  const optionals = input.rootConfig.environment?.optionalServices ?? [];
  const entries: EnvironmentEntry[] =
    defaults.length === 0 && optionals.length === 0
      ? (input.rootConfig.services ?? []).map((service) => ({
          reference: { name: service.name },
          defaultActive: true,
          catalogFallback: true,
        }))
      : [
          ...defaults.map((reference) => ({ reference, defaultActive: true })),
          ...optionals.map((reference) => ({ reference, defaultActive: false })),
        ];

  const truncated = entries.length > maxReferences;
  const rows = await mapWithConcurrency(entries.slice(0, maxReferences), concurrency, resolveEntry);

  let services: ResolvedEnvironmentService[] = [];
  const rowIndexByKey = new Map<string, number>();
  for (const row of rows) {
    const existingIndex = rowIndexByKey.get(row.key);
    if (existingIndex != null) {
      const existing = services[existingIndex];
      const defaultActive = row.defaultActive || existing.defaultActive;
      const promoteBranchConfigurationRepository =
        existing.branchConfigurationRepository == null && row.branchConfigurationRepository != null;
      if (defaultActive !== existing.defaultActive || promoteBranchConfigurationRepository) {
        services[existingIndex] = {
          ...existing,
          defaultActive,
          ...(promoteBranchConfigurationRepository
            ? { branchConfigurationRepository: row.branchConfigurationRepository }
            : {}),
        };
      }
      continue;
    }
    rowIndexByKey.set(row.key, services.length);
    services.push(row);
  }

  if (truncated) {
    const entry = entries[maxReferences];
    const repository = entry.reference.repository ?? rootContext.repositoryName;
    const branch = entry.reference.repository != null ? entry.reference.branch ?? 'main' : rootContext.branch;
    services.push(failureRow(entry, repository, branch, 'truncated', 'max_references_exceeded'));
  }

  services = assignStableCollisionNames(services, rootRepositoryName);
  const unresolved = services
    .filter(
      (
        service
      ): service is ResolvedEnvironmentService & {
        status: Exclude<EnvironmentServiceResolutionStatus, 'resolved'>;
        reason: EnvironmentServiceResolutionReason;
      } => service.status !== 'resolved' && service.reason != null
    )
    .map((service) => ({
      key: service.key,
      name: service.name,
      originalName: service.originalName,
      defaultActive: service.defaultActive,
      repository: service.repository,
      branch: service.branch,
      status: service.status,
      reason: service.reason,
    }));

  return {
    services,
    unresolved,
    pending: [],
    complete: true,
    truncated,
  };
}
