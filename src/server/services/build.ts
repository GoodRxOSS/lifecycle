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
import Haikunator from 'haikunator';
import * as k8s from 'server/lib/kubernetes';
import * as cli from 'server/lib/cli';
import * as github from 'server/lib/github';
import { uninstallHelmReleases } from 'server/lib/helm';
import { ingressBannerSnippet } from 'server/lib/helm/utils';
import { customAlphabet, nanoid } from 'nanoid';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import { getBuildSource, isDeployEnabled, resolveBuildSourceRepository } from 'server/lib/buildSource';
import { computeExtendedExpiry, computeInitialExpiry, isExpired } from 'server/lib/lease';
import { getUtcTimestamp } from 'server/lib/time';
import { AppError, BadRequestError } from 'server/lib/appError';
import { containsSecretRefTemplate } from 'server/lib/secretRefs';
import { isNativeBuilderEngine } from 'server/lib/buildEngines';
import { validateBuildUuidFormat } from 'server/lib/validation/buildUuidValidator';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { toPublicHref } from 'server/lib/publicHref';
import { UniqueViolationError, type AnyQueryBuilder, type Transaction } from 'objection';

import { Build, Deploy, Deployable, Environment, Repository } from 'server/models';
import { BuildKind, BuildStatus, CLIDeployTypes, DeployStatus, DeployTypes, PullRequestStatus } from 'shared/constants';
import { type DeployOptions } from './deploy';
import BaseService from './_service';
import _ from 'lodash';
import { QUEUE_NAMES } from 'shared/config';
import { LifecycleError } from 'server/lib/errors';
import { withLogContext, getLogger, extractContextForQueue, LogStage, updateLogContext } from 'server/lib/logger';
import { ParsingError, YamlConfigParser } from 'server/lib/yamlConfigParser';
import { ValidationError, YamlConfigValidator } from 'server/lib/yamlConfigValidator';

import { type LifecycleYamlConfigOptions } from 'server/models/yaml/types';
import type { DeployableReconciliationResult } from 'server/services/deployable';
import { DeploymentManager, DeploymentSupersededError } from 'server/lib/deploymentManager/deploymentManager';
import { AuthorityLockLostError, type AuthorityLockResult, withAuthorityLock } from 'server/lib/authorityLock';
import { ensureServiceAccountForJob } from 'server/lib/kubernetes/common/serviceAccount';
import { Tracer } from 'server/lib/tracer';
import { redisClient } from 'server/lib/dependencies';
import { generateGraph } from 'server/lib/dependencyGraph';
import GlobalConfigService from './globalConfig';
import IngressService from './ingress';
import AgentPrewarmService from './agentPrewarm';
import DeployCleanupService from './deployCleanup';
import { paginate, PaginationMetadata, PaginationParams } from 'server/lib/paginate';
import { getYamlFileContentFromBranch } from 'server/lib/github';
import WebhookService from './webhook';
import { compactStatusMessage, statusMessageFromError } from 'server/lib/terminalFailure';
import OverrideService, { isBranchOrExternalUrlEditable, type BuildServiceOverrideState } from './override';
import ApiAccessConfigService from './apiAccessConfig';
import { getBranchName, getDeployType, getRepositoryName, type Service } from 'server/models/yaml/YamlService';
import type { LifecycleConfig } from 'server/models/yaml/Config';
import * as YamlService from 'server/models/yaml';
import { getEnvironmentPhaseFromState, isActiveServiceReady } from 'server/lib/environments/readiness';
import {
  acceptDeploymentIntent,
  dirtyDeploymentIntents,
  type DeploymentIntent,
  type DeploymentReconciliationJobData,
  type DirtyDeploymentIntent,
} from 'server/lib/deploymentReconciliation/mailbox';

const tracer = Tracer.getInstance();
tracer.initialize('build-service');
const TEARDOWN_RETRY_GRACE_MS = 15 * 60 * 1000;
const BUILD_DEPLOYMENT_LOCK_TTL_MS = 15 * 60 * 1000;
const DEPLOY_SECRET_MUTATION_LOCK_TTL_MS = 2 * 60 * 1000;
const DEPLOYMENT_RECONCILIATION_SWEEP_MS = 5_000;
const HOUR_MS = 60 * 60 * 1000;
const PR_AUTHORITY_REVALIDATED_DELETE_REASONS = new Set([
  'pull_request_closed',
  'deploy_disabled',
  'pull_request_inactive_sweep',
  'ttl_closed_pull_request',
]);

/**
 * Every delete reason for one Build converges on the same durable ownership
 * token. BullMQ keeps the first payload when a deterministic jobId is already
 * waiting, so generating a fresh token per caller can leave that queued job
 * unable to claim a row that a later API delete already moved to TEARING_DOWN.
 */
function buildTeardownRunUUID(buildId: number): string {
  return `build-teardown-${buildId}`;
}

export interface IngressConfiguration {
  host: string;
  altHosts?: string[];
  serviceHost: string;
  deployUUID: string;
  ipWhitelist: string[];
  pathPortMapping: Record<string, number>;
  readonly ingressAnnotations?: Record<string, any>;
}

type DeployServiceOverrideState = Pick<
  BuildServiceOverrideState,
  'name' | 'branchOrExternalUrl' | 'group' | 'editable'
>;

interface DeploymentScopeOptions {
  runUUID: string;
  /** Exact case-sensitive branch paired with an immutable push source ref. */
  sourceBranch?: string | null;
  /** Repository that owns sourceRef; independent from the execution target selector. */
  sourceGithubRepositoryId?: number | null;
  /** Exact mailbox generation owned by this pass. */
  expectedGeneration?: number;
}

interface DeploymentReconciliationClaim {
  generation: number;
  token: string;
  dirty: DirtyDeploymentIntent[];
}

interface DeploymentReconciliationScope {
  githubRepositoryId: number | null;
  sourceGithubRepositoryId?: number;
  sourceRef?: string;
  sourceBeforeRef?: string;
  sourceBranch?: string;
  skipDeletedServiceReconciliation?: boolean;
}

interface DeploymentScopePreparation {
  build: Build;
  runUUID: string;
  githubRepositoryId: number | null;
  sourceGithubRepositoryId?: number | null;
  sourceRef?: string | null;
  sourceBranch?: string | null;
}

interface DeploymentScopeOutcome {
  status: BuildStatus;
  error?: unknown;
}

interface DeploymentReconciliationRequest {
  buildId: number;
  githubRepositoryId?: number | null;
  triggerRef?: string | null;
  sourceBranch?: string | null;
  sourceGithubRepositoryId?: number | null;
  sourceRef?: string | null;
  sourceBeforeRef?: string | null;
  runUUID?: string | null;
}

interface DeploymentReconciliationQueueJob {
  data: DeploymentReconciliationJobData;
  /** BullMQ counts attempts completed before the currently running attempt. */
  attemptsMade?: number;
  opts?: { attempts?: number };
}

interface DeleteBuildOptions {
  rethrow?: boolean;
  runUUID?: string;
  reason?: string;
  deploymentLockAlreadyHeld?: boolean;
}

export type RedeployBuildResult =
  | { status: 'success'; message: string; deployId: string }
  | { status: 'not_found' | 'tearing_down' | 'deploy_disabled'; message: string };

export type ApplyApiEnvironmentPatchResult =
  | { mode: 'applied'; changed: boolean; build: Build }
  | { mode: 'redeploy_queued'; changed: true; deployId: string; build: Build };

export interface ApplyApiEnvironmentPatchOptions {
  /** MCP patches individual keys; REST retains its established whole-map replacement. */
  envMode?: 'merge' | 'replace';
}

export interface ExtendApiEnvironmentOptions {
  ifExpiresAt?: string;
  rejectPullRequest?: boolean;
}

export interface ExtendApiEnvironmentResult {
  /** Exact row returned by the extension transaction. */
  build: Build;
  /** Whole-hour change from the additive base max(now, locked stored expiry). */
  addedHours: number;
  /** True when the configured maximum shortened or clamped the requested extension. */
  maxReached: boolean;
}

export interface CreateApiEnvironmentAuthorization {
  /** Stable repository identities. Non-null takes precedence over the legacy name list. */
  repositoryAllowlistRepoIds?: number[] | null;
  /** Legacy, mutable repository-name constraints retained for older API keys. */
  repositoryAllowlist?: string[] | null;
}

export interface LockedApiEnvironmentDeletionGuard {
  rejectPullRequest?: boolean;
  /** Recomputes the phase-1 decision-state hash under the row lock; throwing aborts before teardown is claimed. */
  validateLockedState?: (build: Build, trx: Transaction) => void | Promise<void>;
}

export default class BuildService extends BaseService {
  ingressService = new IngressService(this.db, this.redis, this.redlock, this.queueManager);
  private deploymentReconciliationSweepCursor = 0;

  /**
   * For every build that is not closed
   * 1. Check if the PR is open, if not, destroy
   * 2. If PR is open, check if lifecycle label exists, if not, destroy.
   */
  async cleanupBuilds() {
    /* On close, delete the build associated with this PR, if one exists */
    const builds = await this.activeBuilds();
    for (const build of builds) {
      try {
        await build?.$fetchGraph('pullRequest.[repository]');
        if (build.pullRequest?.repository != null) {
          const isActive = await this.db.services.PullRequest.lifecycleEnabledForPullRequest(build.pullRequest);
          // Either we want the PR status to be closed or
          // if deployOnUpdate at the PR level (with the lifecycle-disabled! label)
          if (
            build.pullRequest.status === 'closed' ||
            (isActive === false && build.pullRequest.deployOnUpdate === false)
          ) {
            // Enqueue a deletion job
            const buildId = build?.id;
            if (!buildId) {
              getLogger().error('Build: id missing for=cleanup');
            }
            getLogger().info('Build: queuing action=delete');
            await this.db.services.BuildService.enqueueBuildDeletion(build, 'pull_request_inactive_sweep');
          }
        }
      } catch (e) {
        getLogger().error({ error: e }, 'Build: cleanup failed');
      }
    }
  }

  private deploymentIntentForRequest(
    {
      githubRepositoryId,
      triggerRef,
      sourceBranch,
      sourceGithubRepositoryId,
      sourceRef,
      sourceBeforeRef,
    }: DeploymentReconciliationRequest,
    requestId: string
  ): DeploymentIntent {
    const immutableSourceRef = sourceRef || (sourceGithubRepositoryId != null ? triggerRef : null);
    if (sourceGithubRepositoryId != null && sourceBranch && immutableSourceRef) {
      return {
        type: 'source',
        requestId,
        target: githubRepositoryId == null ? 'all' : 'repository',
        githubRepositoryId: Number(sourceGithubRepositoryId),
        branch: sourceBranch,
        sha: immutableSourceRef,
        ...(sourceBeforeRef ? { beforeSha: sourceBeforeRef } : {}),
      };
    }
    if (githubRepositoryId != null) {
      return { type: 'repository', requestId, githubRepositoryId: Number(githubRepositoryId) };
    }
    return { type: 'all', requestId };
  }

  async enqueueResolveAndDeployBuild(request: DeploymentReconciliationRequest) {
    // The source SHA is desired content, not execution ownership. A unique token
    // prevents two scopes that happen to reference the same commit from accepting
    // each other's late Deploy writes.
    const requestId = request.runUUID || nanoid();
    const intent = this.deploymentIntentForRequest(request, requestId);
    const accepted = await acceptDeploymentIntent(request.buildId, intent);

    if (!accepted) throw new Error(`Build ${request.buildId} was not found while accepting deployment work`);
    if (!accepted.accepted) {
      getLogger({
        buildId: request.buildId,
        scopeKey: accepted.scopeKey,
        generation: accepted.generation,
      }).info('Build reconciliation: duplicate deployment intent ignored');
      return null;
    }

    getLogger({ stage: LogStage.BUILD_QUEUED, buildId: request.buildId, generation: accepted.generation }).info(
      'Build reconciliation: accepted'
    );
    return this.signalPendingDeploymentReconciliation(request.buildId, accepted.generation);
  }

  /**
   * Returns a list of all of the active builds
   */
  async activeBuilds(): Promise<Build[]> {
    const builds = await this.db.models.Build.query()
      .where('kind', BuildKind.ENVIRONMENT)
      .whereNot('status', 'torn_down')
      .whereNot('status', 'pending')
      .withGraphFetched('deploys.[deployable.[repository]]');
    return builds;
  }

  /** Source repository is matched via EXISTS: a join on repositories.githubRepositoryId (not unique across installations) would duplicate rows. */
  private sourceRepositoryExists() {
    return this.db.models.Repository.query()
      .whereColumn('repositories.githubRepositoryId', 'builds.githubRepositoryId')
      .whereNull('repositories.deletedAt');
  }

  /** Active, named, ready service existence used by the shallow environment-list filter. */
  private readyActiveServiceExists() {
    return this.db.models.Deploy.query()
      .select('deploys.id')
      .joinRelated('deployable')
      .whereColumn('deploys.buildId', 'builds.id')
      .where('deploys.active', true)
      .where('deploys.status', DeployStatus.READY)
      .whereNotNull('deployable.name');
  }

  /** SECURITY: every principal-facing build listing must apply this, or repo-scoped keys see other repositories' builds. */
  private scopeToRepositoryAllowlist(
    qb: AnyQueryBuilder,
    repositoryAllowlist?: string[] | null,
    repositoryAllowlistRepoIds?: number[] | null
  ): void {
    // Id-bound tokens filter by repository identity alone; the name list is only a legacy fallback.
    // null = unrestricted, [] = match nothing: a malformed empty allowlist must not widen the listing.
    const allowlistRepoIds = repositoryAllowlistRepoIds?.map(Number).filter(Number.isFinite) ?? null;
    const allowlist = allowlistRepoIds ? null : repositoryAllowlist?.map((entry) => entry.toLowerCase()) ?? null;

    if (allowlistRepoIds) {
      qb.where((w) => {
        w.orWhereIn('builds.githubRepositoryId', allowlistRepoIds);
        w.orWhereExists(
          this.db.models.Build.relatedQuery('pullRequest')
            .joinRelated('repository')
            .whereIn('repository.githubRepositoryId', allowlistRepoIds)
        );
      });
    } else if (allowlist) {
      qb.where((w) => {
        w.orWhereExists(this.sourceRepositoryExists().whereRaw('LOWER("fullName") = ANY(?)', [allowlist]));
        w.orWhereExists(
          this.db.models.Build.relatedQuery('pullRequest').whereRaw('LOWER("fullName") = ANY(?)', [allowlist])
        );
      });
    }
  }

  /**
   * Returns a paginated list of all builds, excluding those with specified statuses.
   * By default, pagination is enabled with a limit of 25 items per page.
   * @param excludeStatuses A comma-separated string of build statuses to exclude from the results.
   * @param pagination Pagination parameters including page number and limit.
   * @returns An object containing the list of builds and pagination metadata.
   * */
  async getAllBuilds(
    excludeStatuses: string,
    filterByAuthor?: string,
    search?: string,
    pagination?: PaginationParams,
    repositoryAllowlist?: string[] | null,
    repositoryAllowlistRepoIds?: number[] | null
  ): Promise<{
    data: Build[];
    paginationMetadata: PaginationMetadata;
  }> {
    const exclude = excludeStatuses ? excludeStatuses.split(',').map((s) => s.trim()) : [];

    const baseQuery = this.db.models.Build.query()
      .select(
        'id',
        'uuid',
        'status',
        'statusMessage',
        'namespace',
        'createdAt',
        'updatedAt',
        'isStatic',
        'kind',
        'baseBuildId',
        'commentRuntimeEnv',
        'commentInitEnv'
      )
      .where('kind', BuildKind.ENVIRONMENT)
      .whereNotIn('status', exclude)
      .modify((qb) => {
        if (filterByAuthor) {
          qb.whereExists(this.db.models.Build.relatedQuery('pullRequest').where('githubLogin', filterByAuthor));
        }

        this.scopeToRepositoryAllowlist(qb, repositoryAllowlist, repositoryAllowlistRepoIds);

        const term = (search ?? '').trim();
        if (term) {
          const like = `%${term.toLowerCase()}%`;

          qb.where((w) => {
            // Build table columns
            w.orWhereRaw('LOWER("uuid") LIKE ?', [like]).orWhereRaw('LOWER("namespace") LIKE ?', [like]);

            // Related pullRequest columns
            w.orWhereExists(
              this.db.models.Build.relatedQuery('pullRequest').where((pr) => {
                pr.whereRaw('LOWER("title") LIKE ?', [like])
                  .orWhereRaw('LOWER("fullName") LIKE ?', [like])
                  .orWhereRaw('LOWER("githubLogin") LIKE ?', [like]);
              })
            );
          });
        }
      })
      .withGraphFetched('[pullRequest, deploys.[deployable]]')
      .modifyGraph('pullRequest', (b) => {
        b.select('id', 'title', 'fullName', 'githubLogin', 'pullRequestNumber', 'branchName');
      })
      .modifyGraph('deploys', (b) => {
        b.select('id', 'uuid', 'status', 'active', 'deployableId');
      })
      .modifyGraph('deploys.deployable', (b) => {
        b.select('name');
      })
      .orderBy('updatedAt', 'desc');

    const { data, metadata: paginationMetadata } = await paginate<Build>(
      baseQuery,
      pagination ?? { page: 1, limit: 25 }
    );

    return { data, paginationMetadata };
  }

  async getBuildByUUID(
    uuid: string,
    options: { liveOnly?: boolean; expectedBuildId?: number } = { liveOnly: true }
  ): Promise<Build | null> {
    const identity = options.expectedBuildId == null ? { uuid } : { uuid, id: options.expectedBuildId };
    let query = this.db.models.Build.query().findOne(identity);
    // Torn-down API environments are soft-deleted and may share a uuid with a live successor.
    if (options.liveOnly ?? true) {
      query = query.whereNull('deletedAt');
    }
    const build = await query
      .select(
        'id',
        'uuid',
        'deletedAt',
        'status',
        'statusMessage',
        'namespace',
        'manifest',
        'sha',
        'createdAt',
        'updatedAt',
        'dependencyGraph',
        'isStatic',
        'kind',
        'baseBuildId',
        'environmentId',
        'pullRequestId',
        'commentRuntimeEnv',
        'commentInitEnv',
        'triggerType',
        'githubRepositoryId',
        'branchName',
        'configSha',
        'deployEnabled',
        'expiresAt',
        'autoTrack',
        'trackDefaultBranches',
        'createdByUserId',
        'createdByTokenId',
        'createdByGithubLogin',
        'runUUID'
      )
      .withGraphFetched('[baseBuild, pullRequest, deploys.[deployable, repository]]')
      .modifyGraph('pullRequest', (b) => {
        b.select(
          'id',
          'title',
          'fullName',
          'githubLogin',
          'pullRequestNumber',
          'branchName',
          'status',
          'labels',
          'deployOnUpdate'
        );
      })
      .modifyGraph('baseBuild', (b) => {
        b.select('id', 'uuid');
      })
      .modifyGraph('deploys', (b) => {
        b.select(
          'id',
          'buildId',
          'uuid',
          'status',
          'statusMessage',
          'active',
          'devMode',
          'cname',
          'deployableId',
          'branchName',
          'deployPipelineId',
          'githubRepositoryId',
          'runUUID',
          'publicUrl',
          'dockerImage',
          'buildLogs',
          'createdAt',
          'updatedAt',
          'sha',
          'initDockerImage',
          'env',
          'initEnv'
        );
      })
      .modifyGraph('deploys.deployable', (b) => {
        b.select('name', 'type', 'dockerfilePath', 'deploymentDependsOn', 'builder', 'ecr', 'grpc', 'hostPortMapping');
      })
      .modifyGraph('deploys.repository', (b) => {
        b.select('fullName');
      });

    // findOne is nondeterministic across duplicate uuids; a live successor always wins over a tombstone.
    if (!options.liveOnly && build?.deletedAt) {
      const live = await this.getBuildByUUID(uuid, { liveOnly: true });
      if (live) return live;
    }

    if (!build) {
      return null;
    }

    await Promise.all([this.attachServiceOverrideStateToDeploys(build), this.attachPublicHrefsToDeploys(build)]);

    return build;
  }

  /**
   * Shallow environment listing for machine consumers: one indexed query,
   * identity fields coalesced from the PR or the build's own source columns.
   */
  async listEnvironments(params: {
    excludeStatuses?: string | null;
    statuses?: string[] | null;
    search?: string | null;
    trigger?: string | null;
    repositoryGithubRepositoryId?: number | null;
    githubLogin?: string | null;
    ownerUserId?: string | null;
    createdByTokenId?: number | null;
    hasReadyActiveService?: boolean | null;
    createdBefore?: string | null;
    createdAfter?: string | null;
    expiresBefore?: string | null;
    repositoryAllowlist?: string[] | null;
    repositoryAllowlistRepoIds?: number[] | null;
    pagination?: PaginationParams;
  }): Promise<{ data: Record<string, unknown>[]; paginationMetadata: PaginationMetadata }> {
    const exclude = (params.excludeStatuses ?? 'torn_down')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const includeDeletedTornDown = !exclude.includes(BuildStatus.TORN_DOWN);

    let baseQuery = this.db.models.Build.query()
      .select(
        'builds.id',
        'builds.uuid',
        'builds.deletedAt',
        'builds.status',
        'builds.statusMessage',
        'builds.namespace',
        'builds.isStatic',
        'builds.triggerType',
        'builds.branchName',
        'builds.githubRepositoryId',
        'builds.deployEnabled',
        'builds.autoTrack',
        'builds.trackDefaultBranches',
        'builds.configSha',
        'builds.runUUID',
        'builds.expiresAt',
        'builds.createdAt',
        'builds.updatedAt',
        'builds.createdByUserId',
        'builds.createdByTokenId',
        'builds.createdByGithubLogin'
      )
      .where('builds.kind', BuildKind.ENVIRONMENT);

    baseQuery = includeDeletedTornDown
      ? baseQuery.where((qb) => {
          qb.whereNull('builds.deletedAt').orWhere((deleted) => {
            deleted.whereNotNull('builds.deletedAt').where('builds.status', BuildStatus.TORN_DOWN);
          });
        })
      : baseQuery.whereNull('builds.deletedAt');

    baseQuery = baseQuery
      .modify((qb) => {
        if (exclude.length > 0) {
          qb.whereNotIn('builds.status', exclude);
        }
        if (params.statuses && params.statuses.length > 0) {
          qb.whereIn('builds.status', params.statuses);
        }
        if (params.trigger) {
          qb.where('builds.triggerType', params.trigger);
        }
        const repositoryGithubRepositoryId = params.repositoryGithubRepositoryId;
        if (repositoryGithubRepositoryId != null) {
          qb.where((repository) => {
            repository
              .where('builds.githubRepositoryId', repositoryGithubRepositoryId)
              .orWhereExists(
                this.db.models.Build.relatedQuery('pullRequest')
                  .joinRelated('repository')
                  .where('repository.githubRepositoryId', repositoryGithubRepositoryId)
              );
          });
        }
        if (params.createdBefore) {
          qb.where('builds.createdAt', '<', params.createdBefore);
        }
        if (params.createdAfter) {
          qb.where('builds.createdAt', '>', params.createdAfter);
        }
        if (params.expiresBefore) {
          qb.where('builds.expiresAt', '<', params.expiresBefore);
        }
        if (params.createdByTokenId != null) {
          qb.where('builds.createdByTokenId', params.createdByTokenId);
        }
        if (params.hasReadyActiveService != null) {
          const readyServiceQuery = this.readyActiveServiceExists();
          if (params.hasReadyActiveService) {
            qb.whereExists(readyServiceQuery);
          } else {
            qb.whereNotExists(readyServiceQuery);
          }
        }
        // mine=true for a human (JWT user or user token): their API envs (by owner sub) OR their PR envs (by login).
        if (params.ownerUserId != null) {
          qb.where((w) => {
            w.orWhere('builds.createdByUserId', params.ownerUserId as string);
            if (params.githubLogin) {
              w.orWhereExists(
                this.db.models.Build.relatedQuery('pullRequest').where('githubLogin', params.githubLogin)
              );
            }
          });
        } else if (params.githubLogin) {
          qb.whereExists(this.db.models.Build.relatedQuery('pullRequest').where('githubLogin', params.githubLogin));
        }
        this.scopeToRepositoryAllowlist(qb, params.repositoryAllowlist, params.repositoryAllowlistRepoIds);
        const term = (params.search ?? '').trim().toLowerCase();
        if (term) {
          const like = `%${term}%`;
          qb.where((w) => {
            w.orWhereRaw('LOWER(builds."uuid") LIKE ?', [like])
              .orWhereRaw('LOWER(builds."namespace") LIKE ?', [like])
              .orWhereRaw('LOWER(builds."branchName") LIKE ?', [like])
              .orWhereRaw('LOWER(builds."createdByGithubLogin") LIKE ?', [like]);
            w.orWhereExists(this.sourceRepositoryExists().whereRaw('LOWER("fullName") LIKE ?', [like]));
            w.orWhereExists(
              this.db.models.Build.relatedQuery('pullRequest').where((pr) => {
                pr.whereRaw('LOWER("title") LIKE ?', [like])
                  .orWhereRaw('LOWER("fullName") LIKE ?', [like])
                  .orWhereRaw('LOWER("githubLogin") LIKE ?', [like])
                  .orWhereRaw('LOWER("branchName") LIKE ?', [like]);
              })
            );
          });
        }
      })
      .withGraphFetched('pullRequest')
      .modifyGraph('pullRequest', (b) => {
        b.select(
          'id',
          'title',
          'fullName',
          'githubLogin',
          'pullRequestNumber',
          'branchName',
          'status',
          'deployOnUpdate'
        );
      })
      .orderBy('builds.updatedAt', 'desc');

    const rawLimit = Number(params.pagination?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 25;
    const rawPage = Number(params.pagination?.page);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const { data, metadata: paginationMetadata } = await paginate<Build>(baseQuery, { page, limit });

    const [sourceRepositoryNames, serviceSummaries] = await Promise.all([
      this.resolveSourceRepositoryNames(data),
      this.resolveEnvironmentServiceSummaries(data),
    ]);

    return {
      data: data.map((build) => this.serializeEnvironmentSummary(build, sourceRepositoryNames, serviceSummaries)),
      paginationMetadata,
    };
  }

  private async resolveSourceRepositoryNames(builds: Build[]): Promise<Map<number, string>> {
    const ids = [
      ...new Set(
        builds
          .filter((build) => !build.pullRequest && build.githubRepositoryId != null)
          .map((build) => Number(build.githubRepositoryId))
      ),
    ];
    if (ids.length === 0) return new Map();

    const repositories = await this.db.models.Repository.query()
      .select('githubRepositoryId', 'fullName')
      .whereIn('githubRepositoryId', ids)
      .whereNull('deletedAt');
    return new Map(repositories.map((repo) => [Number(repo.githubRepositoryId), repo.fullName]));
  }

  private async resolveEnvironmentServiceSummaries(
    builds: Build[]
  ): Promise<
    Map<number, { activeServiceCount: number; hasReadyActiveService: boolean; allActiveServicesReady: boolean }>
  > {
    const buildIds = builds.map((build) => Number(build.id)).filter((id) => Number.isFinite(id));
    if (buildIds.length === 0) return new Map();

    const rows = (await this.db.models.Deploy.query()
      .alias('deploys')
      .select(
        'deploys.buildId',
        'deploys.status',
        'deploys.publicUrl',
        'deployable.name as deployableName',
        'deployable.type as deployableType'
      )
      .joinRelated('deployable')
      .whereIn('deploys.buildId', buildIds)
      .where('deploys.active', true)
      .whereNotNull('deployable.name')) as unknown as Array<{
      buildId: number;
      status: DeployStatus;
      publicUrl: string | null;
      deployableName: string;
      deployableType: string | null;
    }>;

    const aggregates = new Map<
      number,
      { names: Set<string>; hasReadyActiveService: boolean; allActiveServicesReady: boolean }
    >();
    for (const row of rows) {
      const buildId = Number(row.buildId);
      const name = row.deployableName?.trim();
      if (!name) continue;
      const aggregate = aggregates.get(buildId) ?? {
        names: new Set<string>(),
        hasReadyActiveService: false,
        allActiveServicesReady: true,
      };
      aggregate.names.add(name);
      if (row.status === DeployStatus.READY) aggregate.hasReadyActiveService = true;
      aggregate.allActiveServicesReady =
        aggregate.allActiveServicesReady &&
        isActiveServiceReady({
          active: true,
          status: row.status,
          publicUrl: row.publicUrl ?? '',
          deployable: { type: row.deployableType },
        });
      aggregates.set(buildId, aggregate);
    }

    return new Map(
      [...aggregates].map(([buildId, aggregate]) => [
        buildId,
        {
          activeServiceCount: aggregate.names.size,
          hasReadyActiveService: aggregate.hasReadyActiveService,
          allActiveServicesReady: aggregate.allActiveServicesReady,
        },
      ])
    );
  }

  private serializeEnvironmentSummary(
    build: Build,
    sourceRepositoryNames?: Map<number, string>,
    serviceSummaries?: Map<
      number,
      { activeServiceCount: number; hasReadyActiveService: boolean; allActiveServicesReady: boolean }
    >
  ): Record<string, unknown> {
    const source = getBuildSource(build);
    const pullRequest = source.pullRequest;
    const sourceRepositoryFullName =
      build.githubRepositoryId != null ? sourceRepositoryNames?.get(Number(build.githubRepositoryId)) : undefined;
    const activeDeploysByName = new Map(
      (build.deploys ?? [])
        .filter((deploy) => deploy.active && deploy.deployable?.name?.trim())
        .map((deploy) => [deploy.deployable!.name.trim(), deploy])
    );
    const serviceSummary = serviceSummaries?.get(Number(build.id)) ?? {
      activeServiceCount: activeDeploysByName.size,
      hasReadyActiveService: [...activeDeploysByName.values()].some((deploy) => deploy.status === DeployStatus.READY),
      allActiveServicesReady: [...activeDeploysByName.values()].every(isActiveServiceReady),
    };
    const ready = build.status === BuildStatus.DEPLOYED && serviceSummary.allActiveServicesReady;
    return {
      uuid: build.uuid,
      environmentId: build.id,
      status: build.status,
      phase: getEnvironmentPhaseFromState(build.status, isDeployEnabled(build), ready),
      statusMessage: build.statusMessage ?? null,
      namespace: build.namespace,
      trigger: build.triggerType ?? 'github_pr',
      repository: source.fullName ?? sourceRepositoryFullName ?? null,
      branch: source.branchName,
      isStatic: build.isStatic ?? false,
      deployEnabled: isDeployEnabled(build),
      autoTrack: build.autoTrack ?? false,
      expiresAt: build.expiresAt ?? null,
      deletedAt: build.deletedAt ?? null,
      activeServiceCount: serviceSummary.activeServiceCount,
      hasReadyActiveService: serviceSummary.hasReadyActiveService,
      ready,
      currentDeployId: build.runUUID ?? null,
      // Human owner: API envs carry it durably (createdByGithubLogin); PR envs fall back to the PR author.
      author: build.createdByGithubLogin ?? pullRequest?.githubLogin ?? null,
      createdByUserId: build.createdByUserId ?? null,
      pullRequest: pullRequest
        ? {
            number: pullRequest.pullRequestNumber,
            title: pullRequest.title,
            author: pullRequest.githubLogin,
            status: pullRequest.status,
          }
        : null,
      createdAt: build.createdAt,
      updatedAt: build.updatedAt,
    };
  }

  async getEnvironmentDetail(uuid: string, expectedBuildId?: number): Promise<Record<string, unknown> | null> {
    const build = await this.getBuildByUUID(
      uuid,
      expectedBuildId == null ? { liveOnly: true } : { liveOnly: true, expectedBuildId }
    );
    if (!build) return null;
    await this.attachPublicHrefsToDeploys(build);

    let repository = build.pullRequest?.fullName ?? null;
    if (!repository && build.githubRepositoryId != null) {
      const repo = await resolveBuildSourceRepository(build);
      repository = repo?.fullName ?? null;
    }

    return {
      ...this.serializeEnvironmentSummary(build),
      repository,
      configSha: build.configSha ?? null,
      trackDefaultBranches: build.trackDefaultBranches ?? false,
      services: (build.deploys ?? []).map((deploy) => ({
        name: deploy.deployable?.name ?? null,
        status: deploy.status,
        statusMessage: deploy.statusMessage ?? null,
        active: deploy.active,
        branch: deploy.branchName ?? null,
        publicUrl: deploy.publicUrl ?? null,
        publicHref: deploy.publicHref ?? null,
        sha: deploy.sha ?? null,
      })),
      statusUrl: `/api/v2/environments/${build.uuid}`,
    };
  }

  private async attachPublicHrefsToDeploys(build: Build): Promise<void> {
    const deploys = (build.deploys ?? []).filter((deploy) => deploy.publicUrl && deploy.publicHref === undefined);
    if (deploys.length === 0) return;

    let domainDefaults: Parameters<typeof toPublicHref>[1];
    try {
      domainDefaults = (await GlobalConfigService.getInstance().getAllConfigs())?.domainDefaults;
    } catch (error) {
      getLogger().warn({ error }, 'Public href: config lookup failed using=https');
    }

    for (const deploy of deploys) {
      deploy.publicHref = toPublicHref(deploy.publicUrl, domainDefaults);
    }
  }

  private async attachServiceOverrideStateToDeploys(build: Build): Promise<void> {
    if (!build.id || !Array.isArray(build.deploys)) {
      return;
    }

    const buildForServiceOverrides = await this.db.models.Build.query()
      .findOne({ id: build.id })
      .select('id', 'uuid', 'environmentId')
      .withGraphFetched('[environment, deploys.[deployable]]');

    if (!buildForServiceOverrides) {
      return;
    }

    const overrideService = new OverrideService(this.db, this.redis, this.redlock, this.queueManager);
    const overrideStates = await overrideService.getServiceOverrideStates(buildForServiceOverrides.deploys || []);
    const overrideStateByName = new Map(overrideStates.map((state) => [state.name, state]));

    build.deploys.forEach((deploy) => {
      const serviceName = deploy.deployable?.name;
      const state = serviceName ? overrideStateByName.get(serviceName) : null;
      (deploy as Deploy & { serviceOverride: DeployServiceOverrideState | null }).serviceOverride = state
        ? {
            name: state.name,
            branchOrExternalUrl: state.branchOrExternalUrl,
            group: state.group,
            editable: state.editable,
          }
        : null;
    });
  }

  async redeployServiceFromBuild(buildUuid: string, serviceName: string, expectedBuildId?: number) {
    const identity = expectedBuildId == null ? { uuid: buildUuid } : { uuid: buildUuid, id: expectedBuildId };
    const build = await this.db.models.Build.query()
      .findOne(identity)
      .whereNull('deletedAt')
      .withGraphFetched('[deploys.deployable, pullRequest]');

    if (!build) {
      getLogger().debug(`Build not found for ${buildUuid}.`);
      return {
        status: 'not_found',
        message: `Build not found for ${buildUuid}.`,
      };
    }
    const blocked = this.deploymentBlockReason(build);
    if (blocked === 'torn_down') {
      return {
        status: 'tearing_down',
        message: `Build ${buildUuid} is being (or has been) torn down and cannot be redeployed.`,
      };
    }
    if (blocked) {
      return {
        status: 'deploy_disabled',
        message: `Deploys are disabled for build ${buildUuid}; enable deploys before redeploying.`,
      };
    }

    const deploy = build.deploys?.find((candidate) => candidate.deployable?.name === serviceName);
    if (!deploy?.deployable) {
      getLogger().debug(`Deployable ${serviceName} not found for ${buildUuid}.`);
      throw new Error(`Deployable ${serviceName} not found for ${buildUuid}.`);
    }

    const sourceRepositoryId =
      deploy.deployable.resolvedFromRepositoryId ?? deploy.deployable.repositoryId ?? deploy.githubRepositoryId;
    if (sourceRepositoryId == null) {
      getLogger({ buildUuid, serviceName, deployId: deploy.id }).error(
        'Build: service redeploy has no source repository identity'
      );
      throw new Error(`Cannot redeploy ${serviceName}: source repository is unknown.`);
    }

    const runUUID = nanoid();
    await this.enqueueResolveAndDeployBuild({
      buildId: build.id,
      githubRepositoryId: Number(sourceRepositoryId),
      runUUID,
    });

    // The mailbox worker owns status/token changes for every selected Deploy.
    getLogger({ stage: LogStage.BUILD_QUEUED }).info(`Build: service redeploy queued service=${serviceName}`);
    return {
      status: 'success',
      message: `Redeploy for service ${serviceName} in environment ${buildUuid} has been queued`,
    };
  }

  async redeployBuild(
    buildUuid: string,
    expectedBuildId?: number,
    expectedBuildKind?: BuildKind
  ): Promise<RedeployBuildResult> {
    const correlationId = `api-redeploy-${Date.now()}-${nanoid(8)}`;
    return withLogContext({ correlationId, buildUuid }, async () => {
      const enqueue = async (): Promise<RedeployBuildResult> => {
        const identity =
          expectedBuildId == null
            ? { uuid: buildUuid }
            : {
                uuid: buildUuid,
                id: expectedBuildId,
                ...(expectedBuildKind ? { kind: expectedBuildKind } : {}),
              };
        const build = await this.db.models.Build.query()
          .findOne(identity)
          .whereNull('deletedAt')
          .withGraphFetched('[deploys.deployable, pullRequest]');

        if (!build) {
          getLogger().debug(`Build not found for ${buildUuid}.`);
          return {
            status: 'not_found',
            message: `Build not found for ${buildUuid}.`,
          };
        }
        const blocked = this.deploymentBlockReason(build);
        if (blocked === 'torn_down') {
          return {
            status: 'tearing_down',
            message: `Build ${buildUuid} is being (or has been) torn down and cannot be redeployed.`,
          };
        }
        if (blocked) {
          return {
            status: 'deploy_disabled',
            message: `Deploys are disabled for build ${buildUuid}; enable deploys before redeploying.`,
          };
        }

        const buildId = build.id;
        const runUUID = nanoid();

        await this.enqueueResolveAndDeployBuild({
          buildId,
          runUUID,
        });

        getLogger({ stage: LogStage.BUILD_QUEUED }).info('Build: redeploy queued');

        return {
          status: 'success',
          message: `Redeploy for build ${buildUuid} has been queued`,
          deployId: runUUID,
        };
      };

      // The worker serializes execution and revalidates authority under the deployment lock.
      return enqueue();
    });
  }

  async destroyBuildEnvironment(uuid: string, expectedBuildId?: number) {
    return withLogContext({ buildUuid: uuid }, async () => {
      const enqueue = async () => {
        const identity = expectedBuildId == null ? { uuid } : { uuid, id: expectedBuildId };
        const build = await this.db.models.Build.query().findOne(identity).whereNull('deletedAt');

        if (!build || build.isStatic) {
          getLogger().debug('Build does not exist or is static environment');
          return {
            status: 'not_found',
            message: `Build not found for ${uuid} or is static environment.`,
          };
        }

        await this.enqueueBuildDeletion(build, 'manual_destroy');

        getLogger({ stage: LogStage.BUILD_QUEUED }).info('Build: delete queued');
        return {
          status: 'success',
          message: `Build ${uuid} teardown has been queued`,
        };
      };

      return expectedBuildId == null ? enqueue() : this.withBuildDeploymentLock(expectedBuildId, enqueue);
    });
  }

  async getApiEnvironmentsConfig(): Promise<{
    enabled: boolean;
    defaultTtlHours: number;
    maxTtlHours: number;
    extensionHours: number;
  }> {
    return ApiAccessConfigService.getInstance().getApiEnvironmentsConfig();
  }

  private async resolveOnboardedRepository(repositoryFullName: string) {
    const fullName = normalizeRepoFullName(repositoryFullName ?? '');
    if (!fullName || !fullName.includes('/')) {
      throw new BadRequestError('repository must be an "org/repo" fullName', 'invalid_repository');
    }
    const repository = await this.db.models.Repository.query()
      .whereRaw('lower("fullName") = ?', [fullName])
      .whereNull('deletedAt')
      .first();
    if (!repository) {
      throw new AppError({
        httpStatus: 404,
        code: 'repo_not_onboarded',
        message: `Repository ${fullName} is not onboarded into Lifecycle.`,
      });
    }
    return repository;
  }

  /** Branch picker source for the create-environment UI: GitHub branches for an onboarded repo. */
  async listRepositoryBranches(
    repositoryFullName: string
  ): Promise<{ branches: string[]; defaultBranch: string | null }> {
    const repository = await this.resolveOnboardedRepository(repositoryFullName);
    return github.listBranchesForRepo(repository.fullName);
  }

  private async fetchPreviewLifecycleConfig(repositoryFullName: string, branch: string): Promise<LifecycleConfig> {
    const config = await new YamlConfigParser().parseYamlConfigFromBranch(repositoryFullName, branch);
    new YamlConfigValidator().validate((config as { version?: string })?.version, config);
    return config;
  }

  /**
   * Create-time preview for the UI: parses lifecycle.yaml at the ref and reports validity plus the
   * service list with per-service default-active state and whether a branch/URL override is editable.
   */
  async previewEnvironmentConfig(repositoryFullName: string, branch: string): Promise<EnvironmentConfigPreviewResult> {
    const rootRepository = await this.resolveOnboardedRepository(repositoryFullName);
    const trimmedBranch = (branch ?? '').trim();
    if (!trimmedBranch) {
      throw new BadRequestError('branch is required', 'invalid_branch');
    }

    let config: LifecycleConfig;
    try {
      config = await new YamlConfigParser().parseYamlConfigFromBranch(repositoryFullName, trimmedBranch);
    } catch {
      return { valid: false, error: 'lifecycle.yaml was not found or could not be read at this ref.', services: [] };
    }

    let valid = false;
    try {
      valid = new YamlConfigValidator().validate((config as { version?: string })?.version, config);
    } catch {
      valid = false;
    }

    const legacyServices = buildServicePreview(config, rootRepository.fullName, trimmedBranch);
    if (!valid || !hasExtendedPreviewReferences(config)) {
      return { valid, services: legacyServices };
    }

    const apiEnvironmentsConfig = await this.getApiEnvironmentsConfig();
    if (!apiEnvironmentsConfig.enabled && !hasServiceIdPreviewReferences(config)) {
      return { valid, services: legacyServices };
    }

    const resolution = await YamlService.resolveEnvironmentServices({
      rootRepository,
      rootBranch: trimmedBranch,
      rootConfig: config,
      dependencies: {
        resolveRepository: async (fullName: string) => {
          const normalizedFullName = normalizeRepoFullName(fullName ?? '');
          if (!normalizedFullName) return null;
          return this.db.models.Repository.query()
            .whereRaw('lower("fullName") = ?', [normalizedFullName])
            .whereNull('deletedAt')
            .first();
        },
        fetchConfig: (repository, resolvedBranch) =>
          this.fetchPreviewLifecycleConfig(repository.fullName, resolvedBranch),
      },
    });

    return {
      valid,
      services: buildResolvedServicePreviews(resolution.services, rootRepository.fullName),
      complete: true,
      pending: [],
      unresolved: resolution.unresolved.map(({ name, repository, branch, status, reason }) => ({
        name,
        repository,
        branch,
        status,
        reason: environmentServiceResolutionReasonText(reason),
      })),
      truncated: resolution.truncated,
    };
  }

  /**
   * Create an environment from the API (no PullRequest): validates cheaply,
   * inserts the queued Build row (insert-catch idempotency), and enqueues the
   * environment-create job. Heavy work (yaml import, deploys) runs on job nodes.
   */
  public async createApiEnvironment(
    input: CreateApiEnvironmentInput,
    authorization?: CreateApiEnvironmentAuthorization | null,
    options: { requireApiEnvironmentsEnabled?: boolean } = {}
  ): Promise<CreateApiEnvironmentResult> {
    const repositoryAuthorization = normalizeCreateApiEnvironmentAuthorization(authorization);
    // Resolve replays before mutable flag/onboarding/config reads can turn a safe retry into a new failure.
    const creator = input.createdByUserId
      ? `user:${input.createdByUserId}`
      : input.createdByTokenId != null
      ? `token:${input.createdByTokenId}`
      : `user:${input.createdBy ?? 'anonymous'}`;
    const idempotencyKey = input.idempotencyKey ? `${creator}:${input.idempotencyKey}` : null;
    const idempotencyRequestDigest = computeIdempotencyRequestDigest(input);

    if (idempotencyKey) {
      const existing = await this.db.models.Build.query().findOne({ idempotencyKey }).whereNull('deletedAt');
      if (existing) {
        assertIdempotentReplayAllowed(
          existing,
          idempotencyRequestDigest,
          repositoryAuthorization.repositoryAllowlistRepoIds
        );
        await this.assertApiEnvironmentRepositoryAllowed(existing.githubRepositoryId, repositoryAuthorization);
        await this.reenqueueCreateIfStranded(existing, input.services ?? null);
        return { build: existing, replayed: true };
      }
    }

    const config = await this.getApiEnvironmentsConfig();
    if (options.requireApiEnvironmentsEnabled !== false && !config.enabled) {
      throw new AppError({
        httpStatus: 403,
        code: 'api_environments_disabled',
        message: 'API-created environments are disabled; enable the api_environments global config to use them.',
      });
    }

    const fullName = normalizeRepoFullName(input.repositoryFullName ?? '');
    if (!fullName || !fullName.includes('/')) {
      throw new BadRequestError('repository must be an "org/repo" fullName', 'invalid_repository');
    }
    const branch = (input.branch ?? '').trim();
    if (!branch) {
      throw new BadRequestError('branch is required', 'invalid_branch');
    }
    if (input.sha && input.autoTrack) {
      throw new AppError({
        httpStatus: 422,
        code: 'auto_track_pinned_source',
        message: 'autoTrack cannot be enabled when sha pins the environment to an immutable source revision.',
      });
    }

    const repository = await this.db.models.Repository.query()
      .whereRaw('lower("fullName") = ?', [fullName])
      .whereNull('deletedAt')
      .first();
    if (!repository) {
      throw new AppError({
        httpStatus: 404,
        code: 'repo_not_onboarded',
        message: `Repository ${fullName} is not onboarded into Lifecycle.`,
      });
    }
    await this.assertApiEnvironmentRepositoryAllowed(
      repository.githubRepositoryId,
      repositoryAuthorization,
      repository.fullName
    );

    const environmentId = input.environmentId ?? repository.defaultEnvId;
    if (environmentId == null) {
      throw new AppError({
        httpStatus: 400,
        code: 'env_ambiguous',
        message: `Repository ${fullName} has no default environment; pass environmentId explicitly.`,
      });
    }
    const environment = await this.db.models.Environment.query().findById(environmentId);
    if (!environment) {
      throw new AppError({
        httpStatus: 404,
        code: 'env_not_found',
        message: `Environment ${environmentId} was not found.`,
      });
    }
    rejectSecretRefEnv(input.env, 'env');
    rejectSecretRefEnv(input.initEnv, 'initEnv');

    let lifecycleConfig: LifecycleYamlConfigOptions;
    try {
      lifecycleConfig = (await github.getYamlFileContent({
        fullName,
        branch,
        sha: input.sha ?? '',
        isJSON: true,
      })) as LifecycleYamlConfigOptions;
    } catch (error) {
      throw new AppError({
        httpStatus: 422,
        code: 'config_invalid',
        message: `Unable to read lifecycle.yaml from ${fullName}@${input.sha || branch}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        cause: error,
      });
    }
    try {
      new YamlConfigValidator().validate('latest', lifecycleConfig as any);
    } catch (error) {
      throw new AppError({
        httpStatus: 422,
        code: 'config_invalid',
        message: `lifecycle.yaml failed validation: ${error instanceof Error ? error.message : 'unknown error'}`,
        cause: error,
      });
    }

    if (input.name != null) {
      const formatError = validateBuildUuidFormat(input.name);
      if (formatError) {
        throw new BadRequestError(formatError, 'invalid_name');
      }
    }

    const now = new Date();
    const expiresAt = computeInitialExpiry(now, input.ttlHours ?? config.defaultTtlHours, config.maxTtlHours);

    const haikunator = new Haikunator({ defaults: { tokenLength: 6 } });
    const nanoId = customAlphabet('1234567890abcdef', 6);
    const env = lifecycleConfig?.environment;

    const insertBuild = async (uuid: string): Promise<Build> => {
      const attributes = {
        uuid,
        environmentId: environment.id,
        status: BuildStatus.QUEUED,
        sha: nanoId(),
        enabledFeatures: JSON.stringify(env?.enabledFeatures || []),
        // GitHub Deployments require a PR; force off so the deployment queue is never enqueued.
        githubDeployments: false,
        namespace: `env-${uuid}`,
        trackDefaultBranches: input.trackDefaultBranches ?? false,
        triggerType: 'api',
        githubRepositoryId: repository.githubRepositoryId,
        branchName: branch,
        configSha: input.sha ?? null,
        deployEnabled: input.deployEnabled ?? true,
        expiresAt: expiresAt.toISOString(),
        idempotencyKey,
        idempotencyRequestDigest: idempotencyKey ? idempotencyRequestDigest : null,
        createdByTokenId: input.createdByTokenId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByGithubLogin: input.createdByGithubLogin ?? null,
        autoTrack: input.autoTrack ?? false,
        commentRuntimeEnv: input.env ?? {},
        commentInitEnv: input.initEnv ?? input.env ?? {},
      };
      const inserted = await this.db.models.Build.create(attributes);
      return Object.assign(inserted, attributes);
    };

    let build: Build;
    try {
      build = input.name ? await insertBuild(input.name) : await insertOnUuid(insertBuild, haikunator);
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        if (idempotencyKey) {
          const existing = await this.db.models.Build.query().findOne({ idempotencyKey }).whereNull('deletedAt');
          if (existing) {
            assertIdempotentReplayAllowed(
              existing,
              idempotencyRequestDigest,
              repositoryAuthorization.repositoryAllowlistRepoIds
            );
            await this.assertApiEnvironmentRepositoryAllowed(existing.githubRepositoryId, repositoryAuthorization);
            await this.reenqueueCreateIfStranded(existing, input.services ?? null);
            return { build: existing, replayed: true };
          }
        }
        throw new AppError({
          httpStatus: 409,
          code: 'name_conflict',
          message: `An environment named ${input.name} already exists.`,
          cause: error,
        });
      }
      throw error;
    }

    await this.enqueueApiEnvironmentCreate(build, input.services ?? null);

    getLogger({ stage: LogStage.BUILD_QUEUED }).info(`Environment: api create queued uuid=${build.uuid}`);
    return { build, replayed: false };
  }

  /**
   * Enforce create/replay repository authority at the service boundary.
   *
   * Stable repository ids deliberately do not require the repository to remain
   * onboarded: a retry promises the already-accepted stored Build. Legacy
   * name-only keys resolve the stored id to its current live repository name
   * and fail closed if that identity can no longer be resolved.
   */
  private async assertApiEnvironmentRepositoryAllowed(
    githubRepositoryId: number | null | undefined,
    authorization: NormalizedCreateApiEnvironmentAuthorization,
    repositoryFullName?: string | null
  ): Promise<void> {
    if (authorization.repositoryAllowlistRepoIds != null) {
      assertRepositoryIdAllowed(githubRepositoryId, authorization.repositoryAllowlistRepoIds);
      return;
    }
    if (authorization.repositoryAllowlist == null) return;

    let resolvedFullName = repositoryFullName ?? null;
    if (!resolvedFullName && githubRepositoryId != null) {
      const repository = await this.db.models.Repository.query()
        .where({ githubRepositoryId })
        .whereNull('deletedAt')
        .first();
      resolvedFullName = repository?.fullName ?? null;
    }

    const allowedNames = authorization.repositoryAllowlist.map(normalizeRepoFullName);
    if (!resolvedFullName || !allowedNames.includes(normalizeRepoFullName(resolvedFullName))) {
      throw forbiddenRepositoryError();
    }
  }

  /** An enqueue failure after the insert would strand the build in `queued`; replay re-enqueues it (jobId dedupes). */
  private async reenqueueCreateIfStranded(
    build: Build,
    serviceOverrides: { name: string; active?: boolean; branchOrExternalUrl?: string }[] | null
  ): Promise<void> {
    if (build.status !== BuildStatus.QUEUED) return;
    await this.enqueueApiEnvironmentCreate(build, serviceOverrides);
  }

  /** Deterministic jobId so an idempotent replay of a still-queued build re-enqueues without duplicating an in-flight job. */
  private async enqueueApiEnvironmentCreate(
    build: Build,
    serviceOverrides: { name: string; active?: boolean; branchOrExternalUrl?: string }[] | null
  ): Promise<void> {
    await this.apiEnvironmentCreateQueue.add(
      'environment-create',
      {
        buildId: build.id,
        buildUuid: build.uuid,
        serviceOverrides,
        ...extractContextForQueue(),
      },
      { jobId: `env-create-${build.id}` }
    );
  }

  /**
   * environment-create job (runs on job nodes):
   *   yaml import → deployables/deploys → EMPTY? → error
   *   → service overrides (OverrideService) → enqueue resolve-and-deploy.
   * Crash ×3 → handleApiEnvironmentCreateFailure patches status=error.
   */
  processApiEnvironmentCreateQueue = async (job) => {
    const { buildId, buildUuid, serviceOverrides, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, buildUuid, sender, _ddTraceContext }, async () => {
      return this.withBuildDeploymentLock(buildId, async () => {
        const build = await this.db.models.Build.query().findById(buildId).withGraphFetched('environment');
        if (!build || build.deletedAt) {
          getLogger().warn(`Environment: api create skipped reason=build_missing buildId=${buildId}`);
          return;
        }
        if (build.status === BuildStatus.TORN_DOWN || build.status === BuildStatus.TEARING_DOWN) {
          getLogger().info(`Environment: api create skipped reason=torn_down buildId=${buildId}`);
          return;
        }
        const environment = build.environment;
        if (!environment) {
          getLogger().error(`Environment: api create failed reason=environment_missing buildId=${buildId}`);
          // Terminal: a retry cannot restore a missing environment row, and a silent return would strand the build in `queued`.
          await this.recordBuildFailure(
            build,
            BuildStatus.ERROR,
            null,
            new Error('environment record missing'),
            'Environment record is missing for this build.'
          );
          return;
        }

        const runUUID = nanoid();
        const claimedRun = await this.db.models.Build.query()
          .patch({ runUUID } as Partial<Build>)
          .where({ id: build.id })
          .whereNotIn('status', [BuildStatus.TORN_DOWN, BuildStatus.TEARING_DOWN])
          .whereNull('deletedAt');
        if (!claimedRun) {
          getLogger().info(`Environment: api create skipped reason=ownership_lost buildId=${buildId}`);
          return;
        }
        build.runUUID = runUUID;

        try {
          await this.importYamlConfigFile(environment, build);

          const deployables = await this.db.models.Deployable.query().where({ buildId: build.id });
          if (deployables.length === 0) {
            await this.recordBuildFailure(
              build,
              BuildStatus.ERROR,
              runUUID,
              new Error('no deployables after lifecycle.yaml import'),
              'lifecycle.yaml import produced no services for this environment.'
            );
            return;
          }

          const deploys = await this.db.services.Deploy.findOrCreateDeploys(environment, build);
          if (!deploys || deploys.length === 0) {
            await this.recordBuildFailure(
              build,
              BuildStatus.ERROR,
              runUUID,
              new Error('no deploys created from deployables'),
              'No deploys could be created for this environment.'
            );
            return;
          }
          build.$setRelated('deploys', deploys);

          if (Array.isArray(serviceOverrides) && serviceOverrides.length > 0) {
            const override = new (await import('./override')).default(
              this.db,
              this.redis,
              this.redlock,
              this.queueManager
            );
            // findOrCreateDeploys returns deploys without the deployable graph; applyServiceOverrides needs it.
            const deploysWithGraph = await this.db.models.Deploy.query()
              .where({ buildId: build.id })
              .withGraphFetched('deployable');
            await override.applyServiceOverrides({
              build,
              deploys: deploysWithGraph,
              pullRequest: null,
              serviceOverrides,
              runUuid: runUUID,
              enqueueRedeploy: false,
            });
          }

          // A DELETE processed while this job ran must win: claim PENDING atomically so a torn-down environment is never resurrected.
          const claimed = await this.db.models.Build.query()
            .patch({ status: BuildStatus.PENDING } as Partial<Build>)
            .where({ id: build.id, runUUID })
            .whereNotIn('status', [BuildStatus.TORN_DOWN, BuildStatus.TEARING_DOWN])
            .whereNull('deletedAt');
          if (!claimed) {
            getLogger().info(`Environment: api create aborted reason=torn_down buildId=${build.id}`);
            return;
          }

          await this.updateStatusAndComment(build, BuildStatus.PENDING, runUUID, true, true);

          if (isDeployEnabled(build)) {
            await this.enqueueResolveAndDeployBuild({
              buildId: build.id,
              runUUID,
            });
          } else {
            getLogger().info('Environment: api create complete deploy=paused');
          }
        } catch (error) {
          const isConfigError = error instanceof ParsingError || error instanceof ValidationError;
          if (isConfigError) {
            await this.recordBuildFailure(
              build,
              BuildStatus.CONFIG_ERROR,
              runUUID,
              error,
              'Lifecycle configuration failed validation.'
            );
            return;
          }
          // Non-config failures rethrow so BullMQ retries (attempts:3); the failed-handler is the backstop.
          throw error;
        }
      });
    });
  };

  /** Backstop: after the create job exhausts its attempts, the build must not sit in `queued` forever. */
  handleApiEnvironmentCreateFailure = async (job, error: Error) => {
    if (!job || (job.attemptsMade ?? 0) < (job.opts?.attempts ?? 1)) return;
    const { buildId } = job.data ?? {};
    if (!buildId) return;
    try {
      await this.db.models.Build.query()
        .patch({
          status: BuildStatus.ERROR,
          statusMessage: `Environment creation failed after ${job.attemptsMade} attempts: ${
            error?.message ?? 'unknown error'
          }`,
        } as Partial<Build>)
        .where({ id: buildId })
        .whereIn('status', [BuildStatus.QUEUED, BuildStatus.PENDING]);
    } catch (patchError) {
      getLogger().error({ error: patchError }, `Environment: failed-handler patch failed buildId=${buildId}`);
    }
  };

  async extendApiEnvironment(
    uuid: string,
    hours?: number | null,
    expectedBuildId?: number,
    options: ExtendApiEnvironmentOptions = {}
  ): Promise<ExtendApiEnvironmentResult> {
    const config = await this.getApiEnvironmentsConfig();
    return this.db.models.Build.transact(async (trx) => {
      const identity = expectedBuildId == null ? { uuid } : { uuid, id: expectedBuildId };
      const build = await this.db.models.Build.query(trx)
        .findOne(identity)
        .where('kind', BuildKind.ENVIRONMENT)
        .whereNull('deletedAt')
        .forUpdate();
      if (!build) {
        throw new AppError({
          httpStatus: 404,
          code: 'env_not_found',
          message: `API environment ${uuid} was not found.`,
        });
      }
      if (build.triggerType !== 'api') {
        if (options.rejectPullRequest) {
          throw new AppError({
            httpStatus: 409,
            code: 'pr_environment_not_extendable',
            message:
              "Environments created from pull requests follow the pull request's lifetime and cannot be extended.",
          });
        }
        throw new AppError({
          httpStatus: 404,
          code: 'env_not_found',
          message: `API environment ${uuid} was not found.`,
        });
      }
      if (build.status === BuildStatus.TEARING_DOWN || build.status === BuildStatus.TORN_DOWN) {
        throw new AppError({
          httpStatus: 409,
          code: 'env_tearing_down',
          message: `Environment ${uuid} is being (or has been) torn down and cannot be extended.`,
        });
      }
      if (options.ifExpiresAt !== undefined) {
        const expectedExpiry = timestampSecond(options.ifExpiresAt);
        if (expectedExpiry == null) {
          throw new BadRequestError('ifExpiresAt must be a valid date-time.', 'invalid_body');
        }
        const currentExpiry = timestampSecond(build.expiresAt);
        if (currentExpiry !== expectedExpiry) {
          throw new AppError({
            httpStatus: 409,
            code: 'expiry_conflict',
            message:
              "The environment's expiry changed after you read it. Read the environment again before extending it.",
            details: { currentExpiresAt: build.expiresAt ?? null },
          });
        }
      }
      const now = new Date();
      const parsedCurrentExpiry = build.expiresAt ? new Date(build.expiresAt) : null;
      const currentExpiry =
        parsedCurrentExpiry && Number.isFinite(parsedCurrentExpiry.getTime()) ? parsedCurrentExpiry : null;
      const effectiveHours = hours ?? config.extensionHours;
      const expiresAt = computeExtendedExpiry(now, currentExpiry, effectiveHours, config.maxTtlHours);
      const updated = await this.db.models.Build.query(trx).patchAndFetchById(build.id, {
        expiresAt: expiresAt.toISOString(),
      } as Partial<Build>);
      const storedExpiryBase = currentExpiry?.getTime() ?? now.getTime();
      const additiveBase = Math.max(now.getTime(), storedExpiryBase);
      const intendedExpiry = additiveBase + Math.max(effectiveHours, 1) * HOUR_MS;
      return {
        build: updated,
        addedHours: Math.round((expiresAt.getTime() - additiveBase) / HOUR_MS),
        maxReached: expiresAt.getTime() < intendedExpiry,
      };
    });
  }

  /** PATCH /environments/{uuid}: build-level toggles + the shared OverrideService machinery. */
  async applyApiEnvironmentPatch(
    build: Build,
    override: import('./override').default,
    patch: {
      services?: { name: string; active?: boolean; branchOrExternalUrl?: string }[] | null;
      env?: Record<string, string | null> | null;
      initEnv?: Record<string, string | null> | null;
      deployEnabled?: boolean;
      autoTrack?: boolean;
      trackDefaultBranches?: boolean;
    },
    options: ApplyApiEnvironmentPatchOptions = {}
  ): Promise<ApplyApiEnvironmentPatchResult> {
    const envMode = options.envMode ?? 'replace';
    rejectSecretRefEnv(patch.env, 'env', envMode === 'merge');
    rejectSecretRefEnv(patch.initEnv, 'initEnv', envMode === 'merge');
    const requestedServiceOverrides = Array.isArray(patch.services) ? patch.services : [];

    const runUuid = nanoid();
    const persistPatch = () =>
      this.db.models.Build.transact(async (trx) => {
        const current = await this.db.models.Build.query(trx)
          .findOne({ id: build.id, uuid: build.uuid, kind: BuildKind.ENVIRONMENT })
          .whereNull('deletedAt')
          .forUpdate();
        if (!current) {
          throw new AppError({
            httpStatus: 404,
            code: 'env_not_found',
            message: `Environment ${build.uuid} was not found.`,
          });
        }
        if (current.status === BuildStatus.TEARING_DOWN || current.status === BuildStatus.TORN_DOWN) {
          throw new AppError({
            httpStatus: 409,
            code: 'env_tearing_down',
            message: `Environment ${build.uuid} is being (or has been) torn down and cannot be updated.`,
          });
        }
        // The caller's graph is a read snapshot; reload relationships only after the row lock, bound to this transaction.
        await current.$fetchGraph('[baseBuild, pullRequest, deploys.[deployable, repository]]', {
          transaction: trx,
        } as any);
        if ((patch.deployEnabled !== undefined || patch.autoTrack !== undefined) && current.triggerType !== 'api') {
          throw new AppError({
            httpStatus: 422,
            code: 'invalid_field_for_trigger',
            message:
              'deployEnabled and autoTrack only apply to API-created environments; PR environments are controlled by their deploy labels.',
          });
        }
        if (patch.autoTrack === true && current.configSha) {
          throw new AppError({
            httpStatus: 422,
            code: 'auto_track_pinned_source',
            message: 'autoTrack cannot be enabled for an environment pinned to an immutable source revision.',
          });
        }

        const serviceOverrides =
          requestedServiceOverrides.length > 0
            ? await override.validateServiceOverrides(current, current.deploys ?? [], requestedServiceOverrides)
            : [];
        const changedServiceOverrides = serviceOverrides.filter((serviceOverride) =>
          serviceOverrideChanges(current.deploys ?? [], serviceOverride)
        );

        const deployWasEnabled = isDeployEnabled(current);
        const buildPatch: Partial<Build> = {};
        if (patch.deployEnabled !== undefined && patch.deployEnabled !== current.deployEnabled) {
          buildPatch.deployEnabled = patch.deployEnabled;
          if (!patch.deployEnabled) buildPatch.runUUID = runUuid;
        }
        if (patch.autoTrack !== undefined && patch.autoTrack !== current.autoTrack) {
          buildPatch.autoTrack = patch.autoTrack;
        }

        const configPatch: {
          commentRuntimeEnv?: Record<string, string>;
          commentInitEnv?: Record<string, string>;
          trackDefaultBranches?: boolean;
        } = {};
        if (patch.env != null) {
          const next = applyEnvironmentMapPatch(current.commentRuntimeEnv, patch.env, envMode);
          if (!_.isEqual(next, current.commentRuntimeEnv ?? {})) configPatch.commentRuntimeEnv = next;
        }
        if (patch.initEnv != null) {
          const next = applyEnvironmentMapPatch(current.commentInitEnv, patch.initEnv, envMode);
          if (!_.isEqual(next, current.commentInitEnv ?? {})) configPatch.commentInitEnv = next;
        }
        if (patch.trackDefaultBranches !== undefined && patch.trackDefaultBranches !== current.trackDefaultBranches) {
          configPatch.trackDefaultBranches = patch.trackDefaultBranches;
        }

        if (Object.keys(buildPatch).length > 0) {
          await current.$query(trx).patch(buildPatch);
          Object.assign(current, buildPatch);
        }

        if (Object.keys(configPatch).length > 0) {
          await override.applyBuildConfigPatch({
            build: current,
            pullRequest: current.pullRequest ?? null,
            patch: configPatch,
            runUuid,
            enqueueRedeploy: false,
            trx,
          });
        }

        if (changedServiceOverrides.length > 0) {
          await override.applyServiceOverrides({
            build: current,
            deploys: current.deploys ?? [],
            pullRequest: current.pullRequest ?? null,
            serviceOverrides: changedServiceOverrides,
            runUuid,
            enqueueRedeploy: false,
            trx,
          });
        }

        Object.assign(current, configPatch, buildPatch);
        // Overrides patch Deploy/Deployable rows; refresh the graph so the returned Build is the post-write snapshot.
        await current.$fetchGraph('[baseBuild, pullRequest, deploys.[deployable, repository]]', {
          transaction: trx,
        } as any);
        Object.assign(build, current);
        const deploymentRelevantChanged = Object.keys(configPatch).length > 0 || changedServiceOverrides.length > 0;
        return {
          build: current,
          changed: Object.keys(buildPatch).length > 0 || deploymentRelevantChanged,
          queueRedeploy: deploymentRelevantChanged && deployWasEnabled,
        };
      });

    return this.withBuildDeploymentLock(build.id, async () => {
      const persisted = await persistPatch();
      if (persisted.queueRedeploy) {
        await this.enqueueResolveAndDeployBuild({
          buildId: build.id,
          runUUID: runUuid,
        });
        return { mode: 'redeploy_queued', changed: true, deployId: runUuid, build: persisted.build };
      }
      return { mode: 'applied', changed: persisted.changed, build: persisted.build };
    });
  }

  /** Shared enqueue-delete helper: the expiry sweep and the TTL scanner drift-repair both call this. */
  async enqueueBuildDeletion(build: Build, reason: string): Promise<void> {
    if (build == null) return;
    const teardownRunUUID =
      (build.status === BuildStatus.TEARING_DOWN || build.status === BuildStatus.TORN_DOWN) && build.runUUID
        ? build.runUUID
        : buildTeardownRunUUID(build.id);
    // Conditional cleanup never reuses a jobId: BullMQ would swallow a fresh close enqueued while a
    // prior job (about to decide authority_restored) still exists; claim-time revalidation absorbs duplicates.
    const jobId = PR_AUTHORITY_REVALIDATED_DELETE_REASONS.has(reason)
      ? `build-delete-${build.id}-conditional-${nanoid()}`
      : `build-delete-${build.id}-authoritative`;
    await this.deleteQueue.add(
      'delete',
      {
        ...extractContextForQueue(),
        buildId: build.id,
        buildUuid: build.uuid,
        reason,
        teardownRunUUID,
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      }
    );
    getLogger({ stage: LogStage.BUILD_QUEUED }).info(`Environment: delete queued uuid=${build.uuid} reason=${reason}`);
  }

  /**
   * Atomically transfers an API delete request from deploy ownership to teardown ownership.
   *
   * The route authorizes a concrete build row before calling this method. Binding the claim to
   * that id prevents a released vanity uuid from resolving to a newly-created successor, while
   * the shared deployment lock prevents PATCH/redeploy from reopening the deploy gate between
   * the claim and the deterministic delete enqueue.
   */
  async requestApiEnvironmentDeletion(
    buildUuid: string,
    expectedBuildId: number,
    guard: LockedApiEnvironmentDeletionGuard = {}
  ): Promise<Build> {
    return this.withBuildDeploymentLock(expectedBuildId, async () => {
      const claim = await this.db.models.Build.transact(async (trx) => {
        const current = await this.db.models.Build.query(trx)
          .findOne({ id: expectedBuildId, uuid: buildUuid })
          .where('kind', BuildKind.ENVIRONMENT)
          .whereNull('deletedAt')
          .forUpdate();

        if (!current) {
          throw new AppError({
            httpStatus: 404,
            code: 'env_not_found',
            message: `Environment ${buildUuid} was not found.`,
          });
        }
        if (current.isStatic) {
          throw new AppError({
            httpStatus: 409,
            code: 'env_static_protected',
            message: 'Static environments cannot be destroyed through the environments API.',
          });
        }
        if (guard.rejectPullRequest && current.triggerType !== 'api') {
          throw new AppError({
            httpStatus: 409,
            code: 'env_pr_protected',
            message:
              'This environment is managed by its pull request. Close the pull request or remove its deploy label to tear it down.',
          });
        }

        const ownsTeardown = current.status === BuildStatus.TEARING_DOWN || current.status === BuildStatus.TORN_DOWN;
        if (ownsTeardown) return { build: current, newlyClaimed: false };

        await guard.validateLockedState?.(current, trx);

        const teardownRunUUID = ownsTeardown && current.runUUID ? current.runUUID : buildTeardownRunUUID(current.id);
        const claimPatch: Partial<Build> = {
          ...(!ownsTeardown ? { status: BuildStatus.TEARING_DOWN } : {}),
          ...(current.runUUID !== teardownRunUUID ? { runUUID: teardownRunUUID } : {}),
          ...(current.pullRequestId == null && current.deployEnabled !== false ? { deployEnabled: false } : {}),
        };

        if (Object.keys(claimPatch).length > 0) {
          await current.$query(trx).patch(claimPatch);
          Object.assign(current, claimPatch);
        }
        return { build: current, newlyClaimed: true };
      });

      await this.enqueueBuildDeletion(claim.build, 'api_delete');
      return claim.build;
    });
  }

  /**
   * This sweep owns `expiresAt` for API environments and is
   * always on (never gated on the api_environments flag: environments created
   * before the flag was turned off must still be reaped). The ttlCleanup scanner
   * only repairs orphaned-namespace drift.
   */
  async sweepExpiredApiEnvironments(): Promise<{ expired: number; stuckTeardowns: number; enqueued: number }> {
    const now = new Date();
    const expired = await this.db.models.Build.query()
      .where('triggerType', 'api')
      .whereNotNull('expiresAt')
      .where('expiresAt', '<=', now.toISOString())
      .whereNotIn('status', [BuildStatus.TORN_DOWN, BuildStatus.TEARING_DOWN])
      .whereNull('deletedAt');

    // A teardown whose delete job exhausted its retries would otherwise strand cleanup or identity release,
    // leaking the namespace or locking the vanity uuid; updatedAt bumps on every teardown attempt.
    const stuckTeardowns = await this.db.models.Build.query()
      .where('triggerType', 'api')
      .whereIn('status', [BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN])
      .where('updatedAt', '<=', new Date(now.getTime() - TEARDOWN_RETRY_GRACE_MS).toISOString())
      .whereNull('deletedAt');

    let enqueued = 0;
    const enqueueAll = async (builds: Build[], reason: string) => {
      for (const build of builds) {
        try {
          await this.enqueueBuildDeletion(build, reason);
          enqueued++;
        } catch (error) {
          getLogger().error({ error }, `Environment: expiry enqueue failed uuid=${build.uuid}`);
        }
      }
    };
    await enqueueAll(expired, 'lease_expired');
    await enqueueAll(stuckTeardowns, 'teardown_stuck');
    return { expired: expired.length, stuckTeardowns: stuckTeardowns.length, enqueued };
  }

  processApiEnvironmentExpiryQueue = async () => {
    const result = await this.sweepExpiredApiEnvironments();
    if (result.expired > 0 || result.stuckTeardowns > 0) {
      getLogger().info(
        `Environment: expiry sweep complete expired=${result.expired} stuckTeardowns=${result.stuckTeardowns} enqueued=${result.enqueued}`
      );
    }
    return result;
  };

  async setupApiEnvironmentExpiryJob() {
    await this.apiEnvironmentExpiryQueue.add(
      'api-env-expiry',
      {},
      {
        jobId: 'api-env-expiry',
        repeat: { every: 10 * 60 * 1000 },
      }
    );
  }

  async invokeWebhooksForBuild(uuid: string, expectedBuildId?: number) {
    const correlationId = `api-webhook-invoke-${Date.now()}-${nanoid(8)}`;

    return withLogContext({ correlationId, buildUuid: uuid }, async () => {
      const identity = expectedBuildId == null ? { uuid } : { uuid, id: expectedBuildId };
      const build = await this.db.models.Build.query().findOne(identity).whereNull('deletedAt');

      if (!build) {
        getLogger().debug('Build not found');
        return {
          status: 'not_found',
          message: `Build not found for ${uuid}.`,
        };
      }

      if (!build.webhooksYaml) {
        getLogger().debug('No webhooks found for build');
        return {
          status: 'no_content',
          message: `No webhooks found for build ${uuid}.`,
        };
      }

      const webhookService = new WebhookService();
      await webhookService.webhookQueue.add('webhook', {
        buildId: build.id,
        correlationId,
      });

      getLogger({ stage: LogStage.WEBHOOK_PROCESSING }).info('Webhook invocation queued via API');

      return {
        status: 'success',
        message: `Webhooks for build ${uuid} have been queued`,
      };
    });
  }

  async getWebhooksForBuild(
    uuid: string,
    expectedBuildId?: number
  ): Promise<{ status: 'not_found'; message: string } | { status: 'success'; data: any[] }> {
    const identity = expectedBuildId == null ? { uuid } : { uuid, id: expectedBuildId };
    const build = await this.db.models.Build.query().select('id').findOne(identity).whereNull('deletedAt');

    if (!build) {
      return { status: 'not_found', message: `Build not found for ${uuid}.` };
    }

    const data = await this.db.models.WebhookInvocations.query()
      .where('buildId', build.id)
      .orderBy('createdAt', 'desc');

    return { status: 'success', data };
  }

  async validateLifecycleSchema(repo: string, branch: string): Promise<{ valid: boolean }> {
    try {
      const content = (await getYamlFileContentFromBranch(repo, branch)) as string;
      const parser = new YamlConfigParser();
      const config = parser.parseYamlConfigFromString(content);
      const isValid = new YamlConfigValidator().validate(config?.version, config);
      return { valid: isValid };
    } catch (error) {
      getLogger().error({ error }, `Build: ${repo}/${branch} lifecycle schema validation failed`);
      return { valid: false };
    }
  }

  /**
   * Returns namespace of a build based on either id or uuid.
   */
  async getNamespace({ id, uuid }: { id?: number; uuid?: string }): Promise<string> {
    if (!id && !uuid) {
      throw new Error('Either "id" or "uuid" must be provided.');
    }
    const queryCondition = id ? { id } : { uuid };
    let query = this.db.models.Build.query().findOne(queryCondition);
    if (uuid) query = query.whereNull('deletedAt');
    const build = await query;

    if (!build) {
      throw new Error(`[BUILD ${uuid ? uuid : id}] Build not found when looking for namespace`);
    }
    return build?.namespace;
  }

  /**
   * Returns an array of domain configurations for this build
   */
  async domainsAndCertificatesForBuild(build: Build, allServices: boolean): Promise<IngressConfiguration[]> {
    await build?.$fetchGraph('deploys.[deployable]');
    const deploys = build?.deploys ?? [];

    const result: IngressConfiguration[] = _.flatten(
      await Promise.all(
        deploys
          .filter(
            (deploy) =>
              deploy &&
              (allServices || deploy.active) &&
              deploy.deployable &&
              deploy.deployable.public &&
              DeployTypes.HELM !== deploy.deployable.type && // helm deploy ingresses will be managed by helm
              (deploy.deployable.type === DeployTypes.DOCKER || deploy.deployable.type === DeployTypes.GITHUB)
          )
          .map(async (deploy) => {
            return this.ingressConfigurationForDeploy(deploy);
          })
      )
    );

    return result;
  }

  /**
   * Generates an ingress configuration for a single deploy
   * @param deploy
   */
  private async ingressConfigurationForDeploy(deploy: Deploy): Promise<IngressConfiguration[]> {
    await deploy.$fetchGraph('[build.[pullRequest], deployable]');
    const { deployable } = deploy;

    if (!deployable) {
      throw new Error(`Deployable not found for deploy ${deploy.uuid}`);
    }

    const getIngressAnnotations = (baseAnnotations: Record<string, any> | undefined): Record<string, any> => {
      if (deployable.envLens) {
        const bannerSnippet = ingressBannerSnippet(deploy);
        const bannerAnnotation = bannerSnippet.metadata?.annotations || {};
        return { ...(baseAnnotations || {}), ...bannerAnnotation };
      }
      return baseAnnotations || {};
    };

    if (deployable.hostPortMapping && Object.keys(deployable.hostPortMapping).length > 0) {
      return Object.keys(deployable.hostPortMapping).map((key) => {
        return {
          host: `${key}-${this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)}`,
          deployUUID: `${key}-${deploy.uuid}`,
          serviceHost: `${deploy.uuid}`,
          ipWhitelist: deployable.ipWhitelist,
          ingressAnnotations: getIngressAnnotations(deployable.ingressAnnotations),
          pathPortMapping: {
            '/': parseInt(deployable.hostPortMapping[key], 10),
          },
        };
      });
    } else if (deployable.pathPortMapping && Object.keys(deployable.pathPortMapping).length > 0) {
      return [
        {
          host: `${this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)}`,
          deployUUID: `${deploy.uuid}`,
          serviceHost: `${deploy.uuid}`,
          ipWhitelist: deployable.ipWhitelist,
          ingressAnnotations: getIngressAnnotations(deployable.ingressAnnotations),
          pathPortMapping: deployable.pathPortMapping,
        },
      ];
    } else {
      return [
        {
          host: this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)!,
          deployUUID: deploy.uuid,
          serviceHost: `${deploy.uuid}`,
          ipWhitelist: deployable.ipWhitelist,
          ingressAnnotations: getIngressAnnotations(deployable.ingressAnnotations),
          pathPortMapping: {
            '/': parseInt(deployable.port, 10),
          },
        },
      ];
    }
  }

  /**
   * Returns an array of all of the domain configurations & certificates for ingress purposes
   */
  async activeDomainsAndCertificatesForIngress(): Promise<IngressConfiguration[]> {
    const activeBuilds = await this.activeBuilds();
    return _.compact(
      _.flatten(
        // Active services only
        await Promise.all(activeBuilds.map(async (build) => this.domainsAndCertificatesForBuild(build, false)))
      )
    );
  }

  /**
   * Returns an array of all of the domain configurations & certificates for ingress purposes
   */
  async configurationsForBuildId(buildId: number, allServices: boolean = false): Promise<IngressConfiguration[]> {
    const build = await this.db.models.Build.findOne({ id: buildId });
    await build?.$fetchGraph('deploys.[deployable.[repository]]');
    return this.domainsAndCertificatesForBuild(build, allServices);
  }

  public async createBuildAndDeploys({
    repositoryId,
    repositoryBranchName,
    installationId,
    pullRequestId,
    environmentId,
    lifecycleConfig,
  }: DeployOptions & { repositoryId: number }) {
    const environments = await this.getEnvironmentsToBuild(environmentId, repositoryId);

    if (!environments.length) {
      getLogger().debug('Build: no matching environments');
      return;
    }

    try {
      const promises = environments.map((environment) => {
        return this.createBuild(
          environment,
          {
            repositoryId,
            repositoryBranchName,
            installationId,
            pullRequestId,
          },
          lifecycleConfig
        );
      });
      await Promise.all(promises);
    } catch (err) {
      getLogger().fatal({ error: err }, 'Build: create and deploy failed');
    }
  }

  private async importYamlConfigFile(
    environment: Environment,
    build: Build,
    filterGithubRepositoryId?: number,
    options: {
      skipDeletedServiceReconciliation?: boolean;
      sourceRef?: string | null;
      sourceBranch?: string | null;
      sourceGithubRepositoryId?: number | null;
      runUUID?: string;
      expectedGeneration?: number;
    } = {}
  ) {
    const buildSource = getBuildSource(build);
    const sourceGithubRepositoryId = options.sourceGithubRepositoryId ?? filterGithubRepositoryId;
    const sourceRefTargetsRoot =
      options.sourceRef != null &&
      options.sourceBranch != null &&
      sourceGithubRepositoryId != null &&
      buildSource.githubRepositoryId != null &&
      Number(sourceGithubRepositoryId) === Number(buildSource.githubRepositoryId) &&
      options.sourceBranch === buildSource.branchName;
    const rootSourceRef = sourceRefTargetsRoot ? options.sourceRef : null;
    // Write the deployables here for now and not going to use them yet.
    try {
      const buildId = build?.id;
      const reconciliationResult = await this.db.services.Deployable.upsertDeployables(
        buildId,
        build.uuid,
        build.pullRequest,
        environment,
        build,
        filterGithubRepositoryId,
        options.sourceRef,
        options.sourceBranch,
        sourceGithubRepositoryId
      );

      if (options.skipDeletedServiceReconciliation) {
        getLogger({
          buildUuid: build.uuid,
          filterGithubRepositoryId,
        }).info('Stale deploy reconciliation: skipped for service redeploy');
      } else {
        await this.reconcileDeletedDeployables(
          build,
          reconciliationResult,
          filterGithubRepositoryId,
          options.sourceBranch,
          options.runUUID,
          options.expectedGeneration
        );
      }
    } catch (error) {
      if (error instanceof ParsingError) {
        getLogger().error({ error }, 'Config: parsing failed');

        throw error;
      } else if (error instanceof ValidationError) {
        getLogger().error({ error }, 'Config: validation failed');

        throw error;
      } else {
        getLogger().warn({ error }, 'Config: import warning');
        throw error;
      }
    }

    await this.db.services.Webhook.upsertWebhooksWithYaml(build, build.pullRequest, rootSourceRef).catch((error) => {
      getLogger().warn({ error }, 'Config: webhook import warning');
    });
  }

  private async reconcileDeletedDeployables(
    build: Build,
    reconciliationResult: DeployableReconciliationResult,
    filterGithubRepositoryId?: number,
    sourceBranch?: string | null,
    runUUID?: string,
    expectedGeneration?: number
  ) {
    if (!reconciliationResult?.canReconcile) {
      return;
    }

    const reconcileEnabled = await GlobalConfigService.getInstance().isFeatureEnabled('reconcileDeletedServices');
    if (!reconcileEnabled) {
      getLogger({ buildUuid: build.uuid }).debug('Stale deploy reconciliation: disabled');
      return;
    }

    const buildId = build.id;
    const expectedDeployables = reconciliationResult.reconcileEligibleDeployables.filter((deployable) => {
      if (!deployable.reconcileEligible || deployable.source !== 'yaml') {
        return false;
      }

      if (filterGithubRepositoryId) {
        return (
          deployable.resolvedFromRepositoryId === filterGithubRepositoryId &&
          (!sourceBranch || deployable.branchName === sourceBranch)
        );
      }

      return true;
    });
    const expectedNames = new Set(expectedDeployables.map((deployable) => deployable.name));

    let existingQuery = this.db.models.Deployable.query()
      .where({
        buildId,
        buildUUID: build.uuid,
        reconcileEligible: true,
        source: 'yaml',
      })
      .whereNot('type', DeployTypes.CONFIGURATION);

    if (filterGithubRepositoryId) {
      existingQuery = existingQuery
        .where('resolvedFromRepositoryId', filterGithubRepositoryId)
        .whereNotNull('resolvedFromRepositoryId');
    }

    const existingDeployables = (await existingQuery).filter(
      (deployable) =>
        !filterGithubRepositoryId ||
        !sourceBranch ||
        (deployable.commentBranchName ?? deployable.branchName) === sourceBranch
    );
    const staleDeployables = existingDeployables.filter((deployable) => !expectedNames.has(deployable.name));

    if (staleDeployables.length === 0) {
      getLogger({
        buildUuid: build.uuid,
        filterGithubRepositoryId,
        sourceBranch,
        expectedCount: expectedNames.size,
      }).debug('Stale deploy reconciliation: no stale deployables');
      return;
    }

    const cleanup = async () => {
      const staleDeployableIds = staleDeployables.map((deployable) => deployable.id);
      const staleDeploys = await this.db.models.Deploy.query()
        .where({ buildId })
        .whereIn('deployableId', staleDeployableIds)
        .withGraphFetched('[build, deployable]');
      const cleanupService =
        this.db.services?.DeployCleanupService ||
        new DeployCleanupService(this.db, this.redis, this.redlock, this.queueManager);

      getLogger({
        buildUuid: build.uuid,
        filterGithubRepositoryId,
        sourceBranch,
        staleDeployableNames: staleDeployables.map((deployable) => deployable.name),
        staleDeployCount: staleDeploys.length,
      }).warn('Stale deploy reconciliation: cleaning deleted deployables');

      // Retained rows are the retry handle for failed external cleanup; a failure must not fail the deploy run.
      const failedCleanupDeployableIds = new Set<number>();
      await Promise.all(
        staleDeploys.map(async (deploy) => {
          try {
            const cleaned = await cleanupService.cleanupDeploy(deploy, {
              mode: 'service',
              ...(runUUID
                ? {
                    nativeMutationGate: async <T>(action: () => Promise<T>) => {
                      const result = await this.withCurrentBuildPromotionLock(
                        buildId,
                        () => this.isDeploymentRunCurrent(buildId, runUUID, expectedGeneration),
                        action
                      );
                      if (!result.admitted) throw new DeploymentSupersededError();
                      return result.value as T;
                    },
                  }
                : {}),
            });
            if (!cleaned && deploy.deployableId != null) failedCleanupDeployableIds.add(deploy.deployableId);
          } catch (error) {
            if (error instanceof DeploymentSupersededError) throw error;
            if (deploy.deployableId != null) failedCleanupDeployableIds.add(deploy.deployableId);
            getLogger({
              error,
              buildUuid: build.uuid,
              deployUuid: deploy.uuid,
              deployableId: deploy.deployableId,
            }).error('Stale deploy reconciliation: cleanup failed rows_retained=true continuing=true');
          }
        })
      );

      const cleanedDeployableIds = staleDeployableIds.filter((id) => !failedCleanupDeployableIds.has(id));
      if (cleanedDeployableIds.length > 0) {
        await cleanupService.deleteServiceRows({ buildId, deployableIds: cleanedDeployableIds });
      }
      await build.$fetchGraph('[deployables, deploys]');

      getLogger({
        buildUuid: build.uuid,
        filterGithubRepositoryId,
        sourceBranch,
        staleDeployableNames: staleDeployables
          .filter((deployable) => cleanedDeployableIds.includes(deployable.id))
          .map((deployable) => deployable.name),
        retainedDeployableCount: failedCleanupDeployableIds.size,
      }).warn('Stale deploy reconciliation: deleted stale deploy database rows');
    };

    await cleanup();
  }

  public async createBuild(
    environment: Environment,
    options: DeployOptions,
    lifecycleConfig: LifecycleYamlConfigOptions | undefined
  ) {
    try {
      const build = await this.findOrCreateBuild(environment, options, lifecycleConfig);

      if (build?.uuid) {
        updateLogContext({ buildUuid: build.uuid });
      }

      // After a build is susccessfully created or retrieved,
      // we need to create or update the deployables to be used for build and deploy.
      if (build && options != null) {
        await this.withBuildDeploymentLock(build.id, async () => {
          // A close webhook can queue teardown while the open/reopen handler is
          // still importing YAML. Re-read after the shared lock so setup cannot
          // steal run ownership from deletion or revive a closed PR.
          const current = await this.loadBuildDeploymentAuthority(build.id);
          const blocked = this.buildSetupBlockReason(current);
          if (!current || blocked) {
            getLogger().info(`Build: setup skipped reason=${blocked ?? 'build_missing'}`);
            return;
          }

          const runUUID = nanoid();
          const claimed = await this.db.models.Build.query()
            .patch({ runUUID } as Partial<Build>)
            .where({ id: current.id })
            .whereNull('deletedAt');
          if (!claimed) {
            getLogger().info('Build: setup skipped reason=ownership_lost');
            return;
          }
          current.runUUID = runUUID;

          try {
            if (!(await this.isBuildSetupRunCurrent(current.id, runUUID))) return;
            await this.importYamlConfigFile(environment, current);

            if (!(await this.isBuildSetupRunCurrent(current.id, runUUID))) return;
            const deploys = await this.db.services.Deploy.findOrCreateDeploys(environment, current);

            if (deploys) {
              current.$setRelated('deploys', deploys);
              await current.$fetchGraph('pullRequest');

              if (!(await this.isBuildSetupRunCurrent(current.id, runUUID))) return;
              await this.updateStatusAndComment(current, BuildStatus.PENDING, runUUID, true, true);
            } else {
              throw new Error(
                `[BUILD ${current.id}] [${environment.id}] Unable to find or create deploys by using build and environment.`
              );
            }
          } catch (error) {
            if (!(await this.isBuildSetupRunCurrent(current.id, runUUID).catch(() => false))) return;
            const isConfigError = error instanceof ParsingError || error instanceof ValidationError;
            await this.recordBuildFailure(
              current,
              isConfigError ? BuildStatus.CONFIG_ERROR : BuildStatus.ERROR,
              runUUID,
              error,
              isConfigError
                ? 'Lifecycle configuration failed validation.'
                : 'Build setup failed before deploys could be created.'
            );
          }
        });
      } else {
        throw new Error('Missing build or deployment options from environment.');
      }
    } catch (error) {
      getLogger().fatal({ error }, 'Build: create deploys failed');
    }
  }

  /**
   * Return the live authority that every queued deployment run must respect.
   *
   * A PR label/close webhook updates the PullRequest row before its asynchronous
   * teardown can acquire the build lock. Reading that row here is what prevents a
   * queued or in-flight PR job from recreating resources while deletion waits.
   */
  private deploymentBlockReason(build: Build | null | undefined): string | null {
    if (!build) return 'build_missing';
    if (build.deletedAt != null) return 'build_deleted';

    if (build.pullRequest || build.pullRequestId != null) {
      if (!build.pullRequest) return 'pull_request_missing';
      if (build.pullRequest.status !== PullRequestStatus.OPEN) return 'pull_request_closed';
      if (!isDeployEnabled(build)) return 'deploy_disabled';
      // Re-adding the deploy label to an open PR historically recreates an
      // environment after teardown. The current PR authority may reclaim that
      // row; API environments remain terminal below.
      return null;
    }

    if (build.status === BuildStatus.TEARING_DOWN || build.status === BuildStatus.TORN_DOWN) return 'torn_down';
    return build.deployEnabled === true ? null : 'deploy_disabled';
  }

  /** PR setup is allowed without a deploy label, but never after close/teardown. */
  private buildSetupBlockReason(build: Build | null | undefined): string | null {
    if (!build) return 'build_missing';
    if (build.deletedAt != null) return 'build_deleted';
    if (!build.pullRequest) return 'pull_request_missing';
    return build.pullRequest.status === PullRequestStatus.OPEN ? null : 'pull_request_closed';
  }

  private async loadBuildDeploymentAuthority(buildId: number): Promise<Build | null> {
    const build = await this.db.models.Build.query().findOne({ id: buildId });
    await build?.$fetchGraph('[pullRequest.[repository], environment]');
    return build ?? null;
  }

  private async isBuildSetupRunCurrent(buildId: number, runUUID: string): Promise<boolean> {
    const current = await this.loadBuildDeploymentAuthority(buildId);
    return Boolean(current && current.runUUID === runUUID && this.buildSetupBlockReason(current) == null);
  }

  /**
   * Claim the run while the caller holds the deployment lock. The post-claim
   * authority read closes the race with a PR label/close update, which lives on
   * a separate row and therefore cannot be guarded by the Build patch alone.
   */
  private async claimDeploymentRun(
    build: Build,
    requestedRunUUID?: string | null,
    expectedGeneration?: number
  ): Promise<string | null> {
    const blocked = this.deploymentBlockReason(build);
    if (blocked) {
      getLogger().info(`Deploy: skipping reason=${blocked}`);
      return null;
    }

    const runUUID = requestedRunUUID || nanoid();
    let claim = this.db.models.Build.query()
      .patch({
        runUUID,
        // deployId equality is observable only with this non-ready state, so a deploy-bound wait cannot accept prior success.
        status: BuildStatus.PENDING,
        statusMessage: null,
      } as Partial<Build>)
      .where({ id: build.id })
      .whereNull('deletedAt');

    if (expectedGeneration != null) {
      claim = claim.where('desiredGeneration', expectedGeneration);
    }

    // API-created environments keep their kill switch on the Build row, so make
    // that half of the claim atomic. PR authority is re-read immediately below.
    if (!build.pullRequest && build.pullRequestId == null) {
      claim = claim
        .whereNotIn('status', [BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN])
        .where('deployEnabled', true);
    }

    const claimed = await claim;
    if (!claimed) {
      getLogger().info('Deploy: aborting run reason=ownership_lost');
      return null;
    }

    build.runUUID = runUUID;
    build.status = BuildStatus.PENDING;
    build.statusMessage = null;
    if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) {
      getLogger().info('Deploy: aborting run reason=authority_changed');
      return null;
    }
    return runUUID;
  }

  /**
   * Reconcile shared Build/Deploy rows while the short configuration lock is held.
   * The expensive image/provider phase deliberately runs after this returns.
   */
  private async prepareDeploymentScope(
    build: Build,
    githubRepositoryId: number | null,
    sourceRef: string | null | undefined,
    options: DeploymentScopeOptions
  ): Promise<DeploymentScopePreparation | null> {
    const runUUID = options.runUUID;
    const expectedGeneration = options.expectedGeneration;

    if (build.uuid) updateLogContext({ buildUuid: build.uuid });
    await build.$fetchGraph('[environment, pullRequest.[repository]]');

    if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) {
      getLogger().info('Deploy: preparation skipped reason=ownership_lost');
      return null;
    }
    build.runUUID = runUUID;

    const deploys = await this.db.services.Deploy.findOrCreateDeploys(
      build.environment!,
      build,
      githubRepositoryId ?? undefined,
      sourceRef,
      options.sourceBranch,
      options.sourceGithubRepositoryId ?? githubRepositoryId
    );
    build.$setRelated('deploys', deploys);
    await build.$fetchGraph('pullRequest');
    await new BuildEnvironmentVariables(this.db).resolve(build, githubRepositoryId ?? undefined, options.sourceBranch);

    if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) {
      getLogger().info('Deploy: preparation skipped after config reason=ownership_lost');
      return null;
    }

    let deployClaim = this.db.models.Deploy.query().patch({ runUUID }).where({ buildId: build.id });
    if (githubRepositoryId != null) {
      deployClaim = deployClaim.where('githubRepositoryId', githubRepositoryId);
      if (options.sourceBranch) deployClaim = deployClaim.where('branchName', options.sourceBranch);
    }
    await deployClaim;
    for (const deploy of deploys ?? []) {
      if (
        (githubRepositoryId == null || deploy.githubRepositoryId === githubRepositoryId) &&
        (githubRepositoryId == null || !options.sourceBranch || deploy.branchName === options.sourceBranch)
      ) {
        deploy.runUUID = runUUID;
      }
    }

    await this.markConfigurationsAsBuilt(build, runUUID, githubRepositoryId, options.sourceBranch);
    await this.updateStatusAndComment(build, BuildStatus.BUILDING, runUUID, true, true, null, expectedGeneration);
    await build.pullRequest?.$fetchGraph('repository');

    try {
      const dependencyGraph = await generateGraph(build, 'TB');
      let graphPatch = this.db.models.Build.query().patch({ dependencyGraph }).where({ id: build.id, runUUID });
      if (expectedGeneration != null) graphPatch = graphPatch.where('desiredGeneration', expectedGeneration);
      await graphPatch;
    } catch (error) {
      getLogger().warn({ error }, 'Graph: generation failed');
    }

    return {
      build,
      runUUID,
      githubRepositoryId,
      sourceGithubRepositoryId: options.sourceGithubRepositoryId ?? githubRepositoryId,
      sourceRef,
      sourceBranch: options.sourceBranch,
    };
  }

  private async executeDeploymentScope(
    preparation: DeploymentScopePreparation,
    expectedGeneration?: number
  ): Promise<DeploymentScopeOutcome | null> {
    const { build, runUUID, githubRepositoryId, sourceGithubRepositoryId, sourceRef, sourceBranch } = preparation;

    try {
      if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) return null;

      const results = await Promise.all([
        this.buildImages(
          build,
          runUUID,
          githubRepositoryId,
          sourceRef,
          sourceBranch,
          expectedGeneration,
          sourceGithubRepositoryId
        ),
        this.deployCLIServices(build, runUUID, githubRepositoryId, sourceRef, sourceBranch, sourceGithubRepositoryId),
      ]);
      getLogger().debug(`Build results: buildImages=${results[0]} deployCLIServices=${results[1]}`);

      // A/B may finish the expensive operation they already entered, but may not
      // enter native promotion after C has become authoritative.
      if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) {
        getLogger().info('Deploy: rollout skipped reason=ownership_lost');
        return null;
      }

      if (!_.every(results)) {
        getLogger({ buildId: build.id, githubRepositoryId, sourceBranch }).warn('Build: errored skipping=rollout');
        return { status: BuildStatus.ERROR };
      }

      await this.updateStatusAndComment(build, BuildStatus.DEPLOYING, runUUID, true, true, null, expectedGeneration);
      if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) return null;

      const applySuccess = await this.generateAndApplyManifests({
        build,
        runUUID,
        expectedGeneration,
        githubRepositoryId,
        sourceBranch,
        namespace: build.namespace,
        enqueueIngress: false,
      });
      if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) return null;

      return { status: applySuccess ? BuildStatus.DEPLOYED : BuildStatus.ERROR };
    } catch (error) {
      if (error instanceof DeploymentSupersededError) {
        getLogger().info('Build: deployment phase stopped reason=superseded');
        return null;
      }
      if (error instanceof AuthorityLockLostError) throw error;
      getLogger().error({ error }, 'Build: deploy failed');
      if (!(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration).catch(() => false))) {
        getLogger().info('Build: failure ignored reason=ownership_lost');
        return null;
      }

      return { status: BuildStatus.ERROR, error };
    }
  }

  private async isDeploymentRunCurrent(
    buildId: number,
    runUUID: string,
    expectedGeneration?: number
  ): Promise<boolean> {
    const current = await this.db.models.Build.query()
      .findById(buildId)
      .select('id', 'runUUID', 'status', 'deployEnabled', 'deletedAt', 'pullRequestId', 'desiredGeneration');
    if (current?.pullRequestId != null) {
      await current.$fetchGraph('pullRequest');
    }
    return Boolean(
      current &&
        current.runUUID === runUUID &&
        (expectedGeneration == null || Number(current.desiredGeneration) === expectedGeneration) &&
        this.deploymentBlockReason(current) == null
    );
  }

  async withBuildDeploymentLock<T>(buildId: number, action: () => Promise<T>): Promise<T> {
    if (!this.redlock?.lock) return action();

    const resource = `build-deployment.${buildId}`;
    const lock = await this.redlock.lock(resource, BUILD_DEPLOYMENT_LOCK_TTL_MS);
    return this.runWithRenewableLock(resource, lock, action);
  }

  private async withBuildPromotionLock<T>(buildId: number, action: () => Promise<T>): Promise<T> {
    if (!this.redlock?.lock) return action();

    const resource = `build-promotion.${buildId}`;
    const lock = await this.redlock.lock(resource, BUILD_DEPLOYMENT_LOCK_TTL_MS);
    return this.runWithRenewableLock(resource, lock, action);
  }

  /**
   * Waits only at the irreducible native-mutation boundary. Unlike the global
   * Redlock retry budget, this wait ends when the caller loses generation
   * authority and therefore can never consume the latest generation as a
   * terminal lock-acquisition failure.
   */
  async withCurrentBuildPromotionLock<T>(
    buildId: number,
    isCurrent: () => Promise<boolean>,
    action: () => Promise<T>
  ): Promise<AuthorityLockResult<T>> {
    return withAuthorityLock({
      redlock: this.redlock,
      resource: `build-promotion.${buildId}`,
      ttlMs: BUILD_DEPLOYMENT_LOCK_TTL_MS,
      isCurrent,
      action,
      onWait: (error) => getLogger({ error, buildId }).warn('Build promotion: waiting for admitted native mutation'),
    });
  }

  async withCurrentDeploySecretMutationLock<T>(
    deployId: number,
    isCurrent: () => Promise<boolean>,
    action: () => Promise<T>
  ): Promise<AuthorityLockResult<T>> {
    return withAuthorityLock({
      redlock: this.redlock,
      resource: `deploy-external-secrets.${deployId}`,
      ttlMs: DEPLOY_SECRET_MUTATION_LOCK_TTL_MS,
      isCurrent,
      action,
      onWait: (error) => getLogger({ error, deployId }).warn('Deploy secrets: waiting for current resource writer'),
    });
  }

  private async withCurrentBuildDeploymentLock<T>(
    buildId: number,
    isCurrent: () => Promise<boolean>,
    action: () => Promise<T>
  ): Promise<AuthorityLockResult<T>> {
    return withAuthorityLock({
      redlock: this.redlock,
      resource: `build-deployment.${buildId}`,
      ttlMs: BUILD_DEPLOYMENT_LOCK_TTL_MS,
      isCurrent,
      action,
      onWait: (error) => getLogger({ error, buildId }).warn('Build reconciliation: waiting for configuration mutation'),
    });
  }

  /** A duplicate delivery of one generation coalesces; newer generations use a different resource. */
  private async tryWithDeploymentGenerationLock(
    buildId: number,
    generation: number,
    action: () => Promise<void>
  ): Promise<void> {
    if (!this.redlock?.lock) {
      await action();
      return;
    }

    const resource = `build-reconcile.${buildId}.${generation}`;
    const lockWithOptions = (this.redlock as any).lockWithOptions;
    let lock: any;
    try {
      lock =
        typeof lockWithOptions === 'function'
          ? await lockWithOptions.call(this.redlock, resource, BUILD_DEPLOYMENT_LOCK_TTL_MS, {
              retryCount: 1,
              retryDelay: 1,
            })
          : await this.redlock.lock(resource, BUILD_DEPLOYMENT_LOCK_TTL_MS);
    } catch {
      getLogger({ buildId, generation }).info('Build reconciliation: duplicate generation signal coalesced');
      return;
    }

    await this.runWithRenewableLock(resource, lock, action);
  }

  private async runWithRenewableLock<T>(resource: string, acquiredLock: any, action: () => Promise<T>): Promise<T> {
    let lock = acquiredLock;
    if (!lock?.unlock) return action();
    let renewalError: unknown;
    let renewal = Promise.resolve();
    const renewalTimer = setInterval(() => {
      renewal = renewal
        .then(async () => {
          lock = await lock.extend(BUILD_DEPLOYMENT_LOCK_TTL_MS);
        })
        .catch((error) => {
          renewalError = error;
        });
    }, BUILD_DEPLOYMENT_LOCK_TTL_MS / 3);

    try {
      const result = await action();
      clearInterval(renewalTimer);
      await renewal;
      if (renewalError) throw renewalError;
      return result;
    } finally {
      clearInterval(renewalTimer);
      await renewal;
      await lock.unlock().catch((error) => {
        getLogger().warn({ error, resource }, 'Build: lock release failed');
      });
    }
  }

  /**
   * Creates a build if no build exists for the given UUID
   * @param environment the environment to use for this build
   * @param options
   */
  private async findOrCreateBuild(
    environment: Environment,
    options: DeployOptions,
    lifecycleConfig: LifecycleYamlConfigOptions | undefined
  ) {
    const haikunator = new Haikunator({
      defaults: {
        tokenLength: 6,
      },
    });
    const nanoId = customAlphabet('1234567890abcdef', 6);

    if (options.pullRequestId == null) {
      throw new Error('findOrCreateBuild requires a pullRequestId; API-created builds use createApiEnvironment');
    }
    const env = lifecycleConfig?.environment;
    const enabledFeatures = env?.enabledFeatures || [];
    const githubDeployments = env?.githubDeployments || false;
    const existing = await this.db.models.Build.query()
      .where('pullRequestId', options.pullRequestId)
      .where('environmentId', environment.id)
      .whereNull('deletedAt')
      .first();
    let build = existing;
    if (!build) {
      const rootRepository =
        options.repositoryId == null
          ? null
          : await this.db.models.Repository.query().findById(options.repositoryId).select('githubRepositoryId');
      // insertOnUuid retries haikunator collisions against the live-uuid unique index.
      build = await insertOnUuid(
        (uuid: string) =>
          this.db.models.Build.create({
            uuid,
            environmentId: environment.id,
            status: BuildStatus.QUEUED,
            pullRequestId: options.pullRequestId,
            githubRepositoryId: rootRepository?.githubRepositoryId ?? null,
            sha: nanoId(),
            enabledFeatures: JSON.stringify(enabledFeatures),
            githubDeployments,
            namespace: `env-${uuid}`,
          }),
        haikunator
      );
    }
    getLogger().info(`Build: created branch=${options.repositoryBranchName}`);
    return build;
  }

  async deleteBuild(build: Build, options: DeleteBuildOptions = {}) {
    if (build == null) return;
    if (!options.deploymentLockAlreadyHeld) {
      return this.withBuildDeploymentLock(build.id, () =>
        this.deleteBuild(build, { ...options, deploymentLockAlreadyHeld: true })
      );
    }
    try {
      await build.reload();
      if (build.uuid) {
        updateLogContext({ buildUuid: build.uuid });
      }

      if (PR_AUTHORITY_REVALIDATED_DELETE_REASONS.has(options.reason ?? '') && build.pullRequestId != null) {
        await build.$fetchGraph('pullRequest');
        if (
          build.pullRequest != null &&
          build.pullRequest.status === PullRequestStatus.OPEN &&
          isDeployEnabled(build)
        ) {
          getLogger().info('Build: delete skipped reason=pr_authority_restored');
          return;
        }
      }

      // PR-less teardown closes the deploy gate and takes runUUID ownership so queued or in-flight
      // deploy runs abort instead of resurrecting the environment (PR builds get this from the label kill-switch).
      let teardownRunUUID = options.runUUID ?? build.runUUID;
      if (!options.runUUID && build.pullRequestId == null && build.status !== BuildStatus.TORN_DOWN) {
        teardownRunUUID = nanoid();
        await build.$query().patch({ deployEnabled: false, runUUID: teardownRunUUID } as Partial<Build>);
        build.runUUID = teardownRunUUID;
        build.deployEnabled = false;
      }

      if (options.runUUID && build.runUUID !== options.runUUID) {
        getLogger().info('Build: delete skipped reason=teardown_ownership_lost');
        return;
      }

      await build.reload();
      if (teardownRunUUID && build.runUUID !== teardownRunUUID) {
        getLogger().info('Build: delete skipped after lock reason=teardown_ownership_lost');
        return;
      }
      if (build.status === BuildStatus.TORN_DOWN) {
        await this.releaseBuildIdentity(build);
        return;
      }

      await build.$fetchGraph('[services, deploys.[build]]');
      getLogger().debug('Build: triggering cleanup');
      await this.updateStatusAndComment(build, BuildStatus.TEARING_DOWN, teardownRunUUID, true, true);
      if (teardownRunUUID) {
        // Revoke every in-flight Deploy writer before cleanup starts. This one
        // bulk fence prevents detached readiness/provider waits from restoring
        // READY or failure state after teardown records TORN_DOWN.
        await this.db.models.Deploy.query().where({ buildId: build.id }).patch({ runUUID: teardownRunUUID });
      }
      // A failing cleanup step must never block namespace deletion below; retries pick up the rest.
      const cleanupResults = await Promise.allSettled([
        k8s.deleteBuild(build),
        cli.deleteBuild(build),
        uninstallHelmReleases(build),
      ]);
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          getLogger().error({ error: result.reason }, 'Build: cleanup failed');
        }
      }

      await Promise.all(
        (build.deploys ?? []).map(async (deploy) => {
          await deploy.$query().patch({ status: DeployStatus.TORN_DOWN });
          if (build.githubDeployments)
            await this.db.services.GithubService.githubDeploymentQueue.add('deployment', {
              deployId: deploy.id,
              action: 'delete',
              ...extractContextForQueue(),
            });
        })
      );

      await k8s.deleteNamespace(build.namespace);
      if (this.db.services?.Ingress?.ingressCleanupQueue) {
        await this.ingressService.ingressCleanupQueue.add('cleanup', {
          buildId: build.id,
          ...extractContextForQueue(),
        });
      }

      await build.reload();
      if (teardownRunUUID && build.runUUID !== teardownRunUUID) {
        getLogger().info('Build: identity retained reason=teardown_ownership_lost');
        return;
      }
      getLogger().info('Build: deleted');
      await this.updateStatusAndComment(build, BuildStatus.TORN_DOWN, teardownRunUUID, true, true);
      await this.releaseBuildIdentity(build);
    } catch (e) {
      getLogger().error({ error: e instanceof LifecycleError ? e.getMessage() : e }, 'Build: delete failed');
      if (options.rethrow) throw e;
    }
  }

  private async releaseBuildIdentity(build: Build): Promise<void> {
    const releasePatch: Partial<Build> = {};
    if (build.idempotencyKey != null) releasePatch.idempotencyKey = null;
    if (build.kind === BuildKind.ENVIRONMENT && build.triggerType === 'api' && build.deletedAt == null) {
      releasePatch.deletedAt = getUtcTimestamp();
    }
    if (Object.keys(releasePatch).length > 0) {
      await build.$query().patch(releasePatch);
    }
  }

  /**
   * Helper method to update github activity messages for the given build.
   * Takes in a runUUID, which is compared before issu
   * @param build
   * @param status
   * @param runUUID
   * @param force
   * @returns
   */
  async updateStatusAndComment(
    build: Build,
    status: BuildStatus,
    runUUID: string,
    updateMissionControl: boolean,
    updateStatus: boolean,
    error: Error | null = null,
    expectedGeneration?: number
  ) {
    return withLogContext({ buildUuid: build.uuid }, async () => {
      let published = false;
      try {
        await build.reload();
        await build?.$fetchGraph('[deploys.[deployable], pullRequest.[repository]]');

        const deploys = build.deploys ?? [];
        const { pullRequest } = build;
        const isSandboxBuild = build.kind === BuildKind.SANDBOX;
        const repository = pullRequest?.repository;

        const statusMessage = this.resolveBuildStatusMessage(status, deploys || [], error);
        let patch = this.db.models.Build.query()
          .patch({ status, statusMessage })
          .where({ id: build.id, runUUID })
          .whereNull('deletedAt');
        if (expectedGeneration != null) patch = patch.where('desiredGeneration', expectedGeneration);
        if ((await patch) !== 1) return;

        published = true;
        build.status = status;
        build.statusMessage = statusMessage;
        if (!isSandboxBuild && pullRequest && repository) {
          await this.db.services.ActivityStream.updatePullRequestActivityStream(
            build,
            deploys,
            pullRequest,
            repository,
            updateMissionControl,
            updateStatus,
            error
          ).catch((e) => {
            getLogger().error({ error: e }, 'ActivityStream: update failed');
          });
        }
      } finally {
        getLogger().debug(`Build status changed: status=${build.status}`);

        if (published && build.kind !== BuildKind.SANDBOX) {
          await this.db.services.Webhook.webhookQueue
            .add('webhook', {
              buildId: build.id,
              ...extractContextForQueue(),
            })
            .catch((error) => getLogger().warn({ error }, 'Webhook: status notification enqueue failed'));
        }
      }
    });
  }

  private async recordBuildFailure(
    build: Build,
    status: BuildStatus,
    runUUID: string | null | undefined,
    error: unknown,
    fallbackMessage: string,
    expectedGeneration?: number
  ): Promise<void> {
    const activeRunUUID = runUUID || build.runUUID || nanoid();
    if (expectedGeneration != null) {
      if (!(await this.isDeploymentRunCurrent(build.id, activeRunUUID, expectedGeneration))) return;
    } else if (build.runUUID !== activeRunUUID) {
      if (build.pullRequestId != null) {
        await build.$query().patch({ runUUID: activeRunUUID });
      } else {
        // The failure path must not steal ownership back from a completed teardown.
        const claimed = await this.db.models.Build.query()
          .patch({ runUUID: activeRunUUID } as Partial<Build>)
          .where({ id: build.id })
          .whereNotIn('status', [BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN])
          .whereNull('deletedAt');
        if (!claimed) {
          getLogger().info('Build: failure record skipped reason=torn_down');
          return;
        }
      }
      build.runUUID = activeRunUUID;
    }

    const statusError = error instanceof Error ? error : new Error(statusMessageFromError(error, fallbackMessage));
    await this.updateStatusAndComment(build, status, activeRunUUID, true, true, statusError, expectedGeneration);
  }

  private resolveBuildStatusMessage(status: BuildStatus, deploys: Deploy[], error: Error | null): string {
    if (status === BuildStatus.CONFIG_ERROR) {
      return compactStatusMessage(error?.message || 'Lifecycle configuration failed validation.');
    }

    if (status !== BuildStatus.ERROR) {
      return '';
    }

    if (error) {
      return compactStatusMessage(error.message || 'Build failed unexpectedly.');
    }

    const failedDeployMessages = (deploys || [])
      .filter(
        (deploy) =>
          deploy.active !== false &&
          [DeployStatus.ERROR, DeployStatus.BUILD_FAILED, DeployStatus.DEPLOY_FAILED].includes(
            deploy.status as DeployStatus
          )
      )
      .map((deploy) => {
        const serviceName = deploy.deployable?.name || deploy.uuid || 'unknown service';
        return deploy.statusMessage ? `${serviceName}: ${deploy.statusMessage}` : `${serviceName}: ${deploy.status}`;
      });

    if (failedDeployMessages.length === 0) {
      return 'Build failed. Check service status messages for details.';
    }

    return compactStatusMessage(`Build failed because ${failedDeployMessages.slice(0, 3).join('; ')}`);
  }

  async markConfigurationsAsBuilt(
    build: Build,
    runUUID: string,
    githubRepositoryId?: number | null,
    sourceBranch?: string | null
  ) {
    try {
      await build?.$fetchGraph({
        deploys: {
          deployable: true,
        },
      });
      const deploys = build?.deploys || [];
      const configType = DeployTypes.CONFIGURATION;
      if (!deploys) return;
      const configDeploys = deploys.filter(
        ({ deployable, githubRepositoryId: deployRepositoryId, branchName }) =>
          deployable?.type === configType &&
          (!githubRepositoryId || deployRepositoryId === githubRepositoryId) &&
          (!githubRepositoryId || !sourceBranch || branchName === sourceBranch)
      );
      if (configDeploys?.length === 0) {
        return;
      }
      for (const deploy of configDeploys) {
        await this.db.models.Deploy.query().patch({ status: DeployStatus.BUILT }).where({ id: deploy.id, runUUID });
      }
      const configUUIDs = configDeploys.map((deploy) => deploy?.uuid).join(',');
      getLogger().info(`Build: config deploys marked built uuids=${configUUIDs}`);
    } catch (error) {
      getLogger().error({ error }, 'Config: deploy update failed');
    }
  }

  async deployCLIServices(
    build: Build,
    runUUID: string,
    githubRepositoryId: number | null = null,
    sourceRef?: string | null,
    sourceBranch?: string | null,
    sourceGithubRepositoryId: number | null | undefined = githubRepositoryId
  ): Promise<boolean> {
    await build?.$fetchGraph({
      deploys: {
        deployable: true,
      },
    });
    const buildId = build?.id;
    if (!buildId) {
      getLogger().error('Build: id missing for=deployCLIServices');
    }
    const deploys = await Deploy.query()
      .where({
        buildId,
        runUUID,
        ...(githubRepositoryId ? { githubRepositoryId } : {}),
        ...(githubRepositoryId && sourceBranch ? { branchName: sourceBranch } : {}),
      })
      .withGraphFetched({ deployable: true });
    try {
      return _.every(
        await Promise.all(
          deploys
            .filter((deploy): deploy is Deploy & { deployable: Deployable } => {
              if (!deploy.active) return false;
              if (!deploy.deployable) {
                throw new Error(`Deployable not found for deploy ${deploy.uuid}`);
              }
              return CLIDeployTypes.has(deploy.deployable.type);
            })
            .map(async (deploy) => {
              try {
                const result = await this.db.services.Deploy.deployCLI(
                  deploy,
                  runUUID,
                  sourceRef,
                  sourceGithubRepositoryId,
                  sourceBranch
                );
                return result;
              } catch (err) {
                getLogger().error({ error: err }, `CLI: deploy failed uuid=${deploy?.uuid}`);
                return this.db.services.Deploy.recordDeployFailure(deploy, runUUID, {
                  status: DeployStatus.ERROR,
                  error: err,
                  fallbackMessage: 'CLI deploy failed.',
                });
              }
            })
        )
      );
    } catch (error) {
      getLogger().error({ error }, 'CLI: build failed');
      return false;
    }
  }

  /**
   * Builds the images for each deploy for a given build
   * @param build the parent build to build the images for
   * @param options
   */
  async buildImages(
    build: Build,
    runUUID: string,
    githubRepositoryId: number | null = null,
    sourceRef?: string | null,
    sourceBranch?: string | null,
    expectedGeneration?: number,
    sourceGithubRepositoryId: number | null | undefined = githubRepositoryId
  ): Promise<boolean> {
    const buildId = build?.id;
    if (!buildId) {
      getLogger().error('Build: id missing for=buildImages');
    }

    const deploys = await Deploy.query()
      .where({
        buildId,
        runUUID,
        ...(githubRepositoryId ? { githubRepositoryId } : {}),
        ...(githubRepositoryId && sourceBranch ? { branchName: sourceBranch } : {}),
      })
      .withGraphFetched({
        deployable: true,
      });

    try {
      const deploysToBuild = deploys.filter((deploy): deploy is Deploy & { deployable: Deployable } => {
        if (!deploy.active) return false;
        if (!deploy.deployable) {
          throw new Error(`Deployable not found for deploy ${deploy.uuid}`);
        }
        return (
          deploy.deployable.type === DeployTypes.DOCKER ||
          deploy.deployable.type === DeployTypes.GITHUB ||
          deploy.deployable.type === DeployTypes.HELM
        );
      });
      getLogger().debug(
        `Processing deploys for build: count=${deploysToBuild.length} deployUuids=${deploysToBuild
          .map((d) => d.uuid)
          .join(',')}`
      );

      let nativeServiceAccount: string | undefined;
      if (deploysToBuild.some((deploy) => isNativeBuilderEngine(deploy.deployable.builder?.engine))) {
        await build.$fetchGraph('pullRequest');
        const setup = await this.withCurrentBuildDeploymentLock(
          build.id,
          () => this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration),
          async () => {
            await k8s.createOrUpdateNamespace({
              name: build.namespace,
              buildUUID: build.uuid,
              staticEnv: build.isStatic,
              pullRequest: build.pullRequest,
              waitForReady: true,
            });
            return ensureServiceAccountForJob(build.namespace, 'build');
          }
        );
        if (!setup.admitted) throw new DeploymentSupersededError();
        nativeServiceAccount = setup.value;
      }

      const results = await Promise.all(
        deploysToBuild.map(async (deploy, index) => {
          await this.db.models.Deploy.query()
            .patch({ deployPipelineId: null, deployOutput: null } as unknown as Partial<Deploy>)
            .where({ id: deploy.id, runUUID });
          const result = await this.db.services.Deploy.buildImage(
            deploy,
            index,
            runUUID,
            sourceRef,
            sourceGithubRepositoryId,
            sourceBranch,
            expectedGeneration,
            nativeServiceAccount
          );
          getLogger().debug(`buildImage completed: deployUuid=${deploy.uuid} result=${result}`);
          return result;
        })
      );
      const finalResult = _.every(results);
      getLogger().debug(`Build results: results=${results.join(',')} final=${finalResult}`);
      return finalResult;
    } catch (error) {
      if (error instanceof AuthorityLockLostError || error instanceof DeploymentSupersededError) throw error;
      getLogger().error({ error }, 'Docker: build error');
      return false;
    }
  }

  /**
   * Generates a k8s manifest for a given build, and applies it to the k8s cluster
   * @param build the build for which we are generating and deploying a manifest for
   */
  async generateAndApplyManifests({
    build,
    runUUID,
    expectedGeneration,
    githubRepositoryId = null,
    sourceBranch,
    namespace,
    enqueueIngress = true,
  }: {
    build: Build;
    runUUID?: string;
    expectedGeneration?: number;
    githubRepositoryId: number | null;
    sourceBranch?: string | null;
    namespace: string;
    enqueueIngress?: boolean;
  }): Promise<boolean> {
    try {
      const buildId = build?.id;

      const { serviceAccount } = await GlobalConfigService.getInstance().getAllConfigs();
      const serviceAccountName = serviceAccount?.name || 'default';
      const prepareNativeDeployment = async () => {
        await k8s.createOrUpdateNamespace({
          name: build.namespace,
          buildUUID: build.uuid,
          staticEnv: build.isStatic,
          pullRequest: build.pullRequest,
          // API-created environments are reaped by the expiresAt sweep, never by namespace-label TTL.
          ...(build.triggerType === 'api' ? { ttl: false } : {}),
        });
        await ensureServiceAccountForJob(build.namespace, 'deploy');
      };
      if (runUUID) {
        const isCurrent = () => this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration);
        const setup = await this.withCurrentBuildDeploymentLock(build.id, isCurrent, prepareNativeDeployment);
        if (!setup.admitted) throw new DeploymentSupersededError();
      } else {
        await prepareNativeDeployment();
      }
      if (build.kind === BuildKind.ENVIRONMENT && build.uuid) {
        await new AgentPrewarmService(this.db, this.redis, this.redlock, this.queueManager)
          .queueBuildPrewarm(build.uuid)
          .catch((error) => {
            getLogger().warn(
              { error, buildUuid: build.uuid, namespace: build.namespace },
              'Agent prewarm queueing failed before deployment rollout'
            );
          });
      }

      const allDeploys = await Deploy.query()
        .where({
          buildId,
          ...(runUUID ? { runUUID } : {}),
          ...(githubRepositoryId ? { githubRepositoryId } : {}),
          ...(githubRepositoryId && sourceBranch ? { branchName: sourceBranch } : {}),
        })
        .withGraphFetched({
          deployable: true,
        });

      const activeDeploys = allDeploys.filter((deploy): deploy is Deploy & { deployable: Deployable } => {
        if (!deploy.active) return false;
        if (!deploy.deployable) {
          throw new Error(`Deployable not found for deploy ${deploy.uuid}`);
        }
        return true;
      });

      // Generate manifests for GitHub/Docker/CLI deploys
      for (const deploy of activeDeploys) {
        const deployType = deploy.deployable.type;
        if (deployType === DeployTypes.GITHUB || deployType === DeployTypes.DOCKER || CLIDeployTypes.has(deployType)) {
          // Generate individual manifest for this deploy
          const manifest = k8s.generateDeployManifest({
            deploy,
            build,
            namespace,
            serviceAccountName,
          });

          // Store manifest in deploy record
          if (manifest && manifest.trim().length > 0) {
            let manifestPatch = this.db.models.Deploy.query().patch({ manifest }).where({ id: deploy.id });
            if (runUUID) manifestPatch = manifestPatch.where('runUUID', runUUID);
            await manifestPatch;
            deploy.manifest = manifest;
          }
        }
      }

      // Use DeploymentManager for all active deploys (both Helm and GitHub types)
      if (activeDeploys.length > 0) {
        // we should ignore Codefresh and Configuration services here since we dont deploy anything
        const managedDeploys = activeDeploys.filter(
          (d) => d.deployable.type !== DeployTypes.CODEFRESH && d.deployable.type !== DeployTypes.CONFIGURATION
        );
        const isCurrent = runUUID
          ? () => this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration)
          : undefined;
        const deploymentManager = new DeploymentManager(managedDeploys, {
          isCurrent,
          nativeMutationGate: runUUID
            ? (action) => this.withCurrentBuildPromotionLock(build.id, isCurrent!, action)
            : undefined,
          nativeSecretMutationGate: runUUID
            ? (deploy, action) => this.withCurrentDeploySecretMutationLock(deploy.id, isCurrent!, action)
            : undefined,
        });
        await deploymentManager.deploy();
      }

      if (runUUID && !(await this.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration))) {
        throw new DeploymentSupersededError();
      }

      if (enqueueIngress) {
        await this.enqueueIngressManifest(buildId, runUUID, expectedGeneration);
      }

      // Legacy manifest generation for backwards compatibility
      const githubTypeDeploys = activeDeploys.filter(
        (d) =>
          d.deployable.type === DeployTypes.GITHUB ||
          d.deployable.type === DeployTypes.DOCKER ||
          CLIDeployTypes.has(d.deployable.type)
      );

      if (githubTypeDeploys.length > 0) {
        const legacyManifest = k8s.generateManifest({
          build,
          deploys: githubTypeDeploys,
          uuid: build.uuid,
          namespace,
          serviceAccountName,
        });
        if (legacyManifest && legacyManifest.replace(/---/g, '').trim().length > 0) {
          let manifestPatch = this.db.models.Build.query().patch({ manifest: legacyManifest }).where({ id: build.id });
          if (runUUID) manifestPatch = manifestPatch.where('runUUID', runUUID);
          if (expectedGeneration != null) manifestPatch = manifestPatch.where('desiredGeneration', expectedGeneration);
          await manifestPatch;
        }
      }
      await this.updateDeploysImageDetails(build, runUUID, githubRepositoryId, sourceBranch);
      return true;
    } catch (e) {
      if (e instanceof DeploymentSupersededError) {
        getLogger().info('K8s: deployment stopped reason=superseded');
        throw e;
      }
      getLogger().warn({ error: e }, 'K8s: deploy failed');
      throw e;
    }
  }

  private async enqueueIngressManifest(buildId: number, runUUID?: string, expectedGeneration?: number) {
    await this.ingressService.ingressManifestQueue.add('manifest', {
      buildId,
      ...(runUUID ? { runUUID } : {}),
      ...(expectedGeneration != null ? { expectedGeneration } : {}),
      ...extractContextForQueue(),
    });
  }

  /**
   * Returns an array of environments to build.
   * @param environmentId the default environmentId (if one exists)
   * @param repositoryId the repository to use for finding relevant environments, if needed
   */
  private async getEnvironmentsToBuild(environmentId: number | undefined, repositoryId: number) {
    let environments: Environment[] = [];
    if (environmentId != null) {
      environments.push(await this.db.models.Environment.findOne({ id: environmentId }));
    } else {
      environments = environments.concat(
        await this.db.models.Environment.find().withGraphJoined('services').where('services.repositoryId', repositoryId)
      );
    }

    return environments;
  }

  private async updateDeploysImageDetails(
    build: Build,
    runUUID?: string,
    githubRepositoryId?: number | null,
    sourceBranch?: string | null
  ) {
    await build?.$fetchGraph('deploys');
    const deploys = (build.deploys ?? []).filter(
      (deploy) =>
        (!githubRepositoryId || deploy.githubRepositoryId === githubRepositoryId) &&
        (!githubRepositoryId || !sourceBranch || deploy.branchName === sourceBranch)
    );
    await Promise.all(
      deploys.map((deploy) => {
        let update = this.db.models.Deploy.query()
          .patch({ isRunningLatest: true, runningImage: deploy?.dockerImage })
          .where({ id: deploy.id });
        if (runUUID) update = update.where('runUUID', runUUID);
        return update;
      })
    );
    getLogger().debug('Deploy: updated running image and status');
  }

  /**
   * A queue entrypoint for the purpose of performing builds and deploying to K8
   */
  deleteQueue = this.queueManager.registerQueue(QUEUE_NAMES.DELETE_QUEUE, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  deploymentReconciliationQueue = this.queueManager.registerQueue(QUEUE_NAMES.DEPLOYMENT_RECONCILIATION, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 10,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  apiEnvironmentCreateQueue = this.queueManager.registerQueue(QUEUE_NAMES.API_ENV_CREATE, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

  apiEnvironmentExpiryQueue = this.queueManager.registerQueue(QUEUE_NAMES.API_ENV_EXPIRY, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  private async claimBuildForDeletion(
    buildId: number,
    reason: string | undefined,
    teardownRunUUID: string
  ): Promise<{
    build: Build | null;
    outcome: 'claimed' | 'already_claimed' | 'lease_extended' | 'authority_restored' | 'missing';
  }> {
    return this.db.models.Build.transact(async (trx) => {
      const build = await this.db.models.Build.query(trx).findById(buildId).whereNull('deletedAt').forUpdate();

      if (!build) return { build: null, outcome: 'missing' };

      if (PR_AUTHORITY_REVALIDATED_DELETE_REASONS.has(reason ?? '') && build.pullRequestId != null) {
        await build.$fetchGraph('pullRequest', { transaction: trx } as any);
        // Close/disable cleanup is asynchronous. A later reopen/re-enable event
        // is authoritative, even when BullMQ coalesced multiple reasons onto the
        // same deterministic delete job.
        if (
          build.pullRequest != null &&
          build.pullRequest.status === PullRequestStatus.OPEN &&
          isDeployEnabled(build)
        ) {
          return { build: null, outcome: 'authority_restored' };
        }
      }

      if (reason === 'lease_expired' && (build.kind !== BuildKind.ENVIRONMENT || build.triggerType !== 'api')) {
        return { build: null, outcome: 'missing' };
      }

      // A retry must be able to finish cleanup (or identity release) once teardown owns the row.
      if (build.status === BuildStatus.TEARING_DOWN || build.status === BuildStatus.TORN_DOWN) {
        return build.runUUID === teardownRunUUID
          ? { build, outcome: 'claimed' }
          : { build: null, outcome: 'already_claimed' };
      }

      // Extension takes the same row lock, so whichever transaction commits first wins deterministically.
      if (reason === 'lease_expired' && !isExpired(new Date(), build.expiresAt)) {
        return { build: null, outcome: 'lease_extended' };
      }

      const claimPatch: Partial<Build> = {
        runUUID: teardownRunUUID,
        // Keep a PR's visible status unchanged until cleanup starts. If a
        // reopen/re-enable races this claim, the second authority check can
        // cancel teardown without leaving the build stranded in TEARING_DOWN.
        ...(build.pullRequestId == null ? { status: BuildStatus.TEARING_DOWN, deployEnabled: false } : {}),
      };
      await build.$query(trx).patch(claimPatch);
      Object.assign(build, claimPatch);
      return { build, outcome: 'claimed' };
    });
  }

  /**
   * Process the deleion of a build async
   * @param job the BullMQ job with the buildId
   */
  processDeleteQueue = async (job) => {
    const { buildId, buildUuid, sender, correlationId, reason, teardownRunUUID, _ddTraceContext } = job.data;
    const activeTeardownRunUUID = teardownRunUUID ?? buildTeardownRunUUID(buildId);

    return withLogContext({ correlationId, buildUuid, sender, _ddTraceContext }, async () => {
      try {
        await this.withBuildDeploymentLock(buildId, async () => {
          const claim = await this.claimBuildForDeletion(buildId, reason, activeTeardownRunUUID);
          if (claim.outcome === 'lease_extended') {
            getLogger().info('Build: delete skipped reason=lease_extended');
            return;
          }
          if (claim.outcome === 'already_claimed') {
            getLogger().info('Build: delete skipped reason=teardown_owned');
            return;
          }
          if (claim.outcome === 'authority_restored') {
            getLogger().info('Build: delete skipped reason=pr_authority_restored');
            return;
          }
          const build = claim.build;

          if (build?.uuid) {
            updateLogContext({ buildUuid: build.uuid });
          }

          if (!build) {
            getLogger({ stage: LogStage.CLEANUP_FAILED }).warn(`Build: not found for deletion buildId=${buildId}`);
            return;
          }

          getLogger({ stage: LogStage.CLEANUP_STARTING }).info('Build: deleting');
          await this.withBuildPromotionLock(buildId, () =>
            this.db.services.BuildService.deleteBuild(build, {
              rethrow: true,
              runUUID: activeTeardownRunUUID,
              reason,
              deploymentLockAlreadyHeld: true,
            })
          );
          getLogger({ stage: LogStage.CLEANUP_COMPLETE }).info('Build: deleted');
        });
      } catch (error) {
        getLogger({ stage: LogStage.CLEANUP_FAILED }).error(
          { error },
          `Queue: delete processing failed buildId=${buildId}`
        );
        // Only jobs enqueued with a retry budget (enqueueBuildDeletion) rethrow so attempts:3 fires; legacy jobs keep log-and-drop.
        if ((job.opts?.attempts ?? 1) > 1) throw error;
      }
    });
  };

  private async claimDeploymentReconciliation(
    buildId: number,
    generation: number
  ): Promise<DeploymentReconciliationClaim | null> {
    const build = await this.db.models.Build.query().findById(buildId).whereNull('deletedAt');
    if (!build) return null;

    const desiredGeneration = Number(build.desiredGeneration);
    const observedGeneration = Number(build.observedGeneration);
    if (!Number.isSafeInteger(desiredGeneration) || !Number.isSafeInteger(observedGeneration)) {
      throw new Error(`Build ${buildId} has invalid deployment generations`);
    }
    // One signal owns exactly one generation. B must never wake up later and
    // read/execute C's mailbox contents.
    if (desiredGeneration !== generation || generation <= observedGeneration) return null;

    const dirty = dirtyDeploymentIntents(build.acceptedRefs, observedGeneration).filter(
      ({ intent }) => intent.gen <= generation
    );
    const latest = dirty.find(({ intent }) => intent.gen === generation)?.intent;
    if (!latest?.requestId) throw new Error(`Build ${buildId} generation ${generation} has no request token`);

    return { generation, token: latest.requestId, dirty };
  }

  private deploymentReconciliationScopes(dirty: DirtyDeploymentIntent[]): DeploymentReconciliationScope[] {
    const newestBroadIndex = _.findLastIndex(
      dirty,
      ({ intent }) => intent.type === 'all' || (intent.type === 'source' && intent.target === 'all')
    );

    // A full pass subsumes older unpinned requests, but it must not erase a
    // delivered source SHA. Run unpinned/live-head work first and immutable
    // source floors last so a temporarily stale provider read cannot roll C
    // back to B. A source-targeted full pass still precedes selective pins.
    const retained = dirty.filter(
      ({ intent }, index) => newestBroadIndex < 0 || index >= newestBroadIndex || intent.type === 'source'
    );
    const ordered = _.orderBy(
      retained,
      [
        ({ intent }) => {
          if (intent.type === 'all') return 0;
          if (intent.type === 'repository') return 1;
          return intent.target === 'all' ? 2 : 3;
        },
        ({ intent }) => intent.gen,
      ],
      ['asc', 'desc']
    );

    return ordered.map(({ intent }) => {
      if (intent.type === 'all') return { githubRepositoryId: null };
      if (intent.type === 'source') {
        return {
          githubRepositoryId: intent.target === 'all' ? null : intent.githubRepositoryId,
          sourceGithubRepositoryId: intent.githubRepositoryId,
          sourceRef: intent.sha,
          sourceBeforeRef: intent.beforeSha,
          sourceBranch: intent.branch,
        };
      }
      return {
        githubRepositoryId: intent.githubRepositoryId,
        skipDeletedServiceReconciliation: true,
      };
    });
  }

  /**
   * The delivered SHA is the acceptance floor. A live head may advance it, but
   * a lagging GitHub read must never move accepted C back to A/B.
   */
  private async resolveCurrentSourceRef(scope: DeploymentReconciliationScope): Promise<string | undefined> {
    if (!scope.sourceBranch || !scope.sourceRef || scope.sourceGithubRepositoryId == null) return scope.sourceRef;

    const repository: Repository | undefined = await this.db.models.Repository.query()
      .findOne({ githubRepositoryId: scope.sourceGithubRepositoryId })
      .whereNull('deletedAt');
    const repositoryFullName = repository?.fullName;
    const [owner, name] = repositoryFullName?.split('/') ?? [];
    if (!repositoryFullName || !owner || !name) return scope.sourceRef;

    let currentRef: string;
    try {
      currentRef = await github.getSHAForBranch(scope.sourceBranch, owner, name);
    } catch (error) {
      getLogger({ error, repositoryFullName, branch: scope.sourceBranch }).warn(
        'Build reconciliation: branch head lookup failed; using accepted source'
      );
      return scope.sourceRef;
    }
    if (!currentRef || currentRef === scope.sourceRef || currentRef === scope.sourceBeforeRef) return scope.sourceRef;

    try {
      const comparison = await github.compareCommits({
        fullName: repositoryFullName,
        base: scope.sourceRef,
        head: currentRef,
      });
      if (comparison === 'ahead') return currentRef;
    } catch (error) {
      getLogger({ error, repositoryFullName, branch: scope.sourceBranch }).warn(
        'Build reconciliation: commit comparison failed; using accepted source'
      );
    }
    return scope.sourceRef;
  }

  private async markDeploymentReconciliationObserved(
    buildId: number,
    generation: number,
    token?: string
  ): Promise<boolean> {
    let update = this.db.models.Build.query()
      .patch({ observedGeneration: generation })
      .where({ id: buildId, desiredGeneration: generation })
      .whereNull('deletedAt');
    if (token) update = update.where('runUUID', token);
    return (await update) === 1;
  }

  private async signalPendingDeploymentReconciliation(buildId: number, generation: number): Promise<void> {
    const data: DeploymentReconciliationJobData = {
      ...extractContextForQueue(),
      buildId,
      generation,
    };
    await this.deploymentReconciliationQueue.add('reconcile', data, {
      jobId: `reconcile-${buildId}-${generation}`,
    });
  }

  private async adoptLegacyDeploymentJob(request: DeploymentReconciliationRequest): Promise<void> {
    const requestId = request.runUUID || nanoid();
    const accepted = await acceptDeploymentIntent(request.buildId, this.deploymentIntentForRequest(request, requestId));
    if (!accepted) return;
    await this.signalPendingDeploymentReconciliation(request.buildId, accepted.generation);
  }

  async enqueuePendingDeploymentReconciliations(): Promise<void> {
    const pendingAfter = (id: number) =>
      this.db.models.Build.query()
        .select('id', 'desiredGeneration')
        .whereRaw('?? > ??', ['desiredGeneration', 'observedGeneration'])
        .whereNull('deletedAt')
        .where('id', '>', id)
        .orderBy('id')
        .limit(500);

    let builds = await pendingAfter(this.deploymentReconciliationSweepCursor);
    if (builds.length === 0 && this.deploymentReconciliationSweepCursor !== 0) {
      this.deploymentReconciliationSweepCursor = 0;
      builds = await pendingAfter(0);
    }
    if (builds.length > 0) this.deploymentReconciliationSweepCursor = Number(builds[builds.length - 1].id);

    await Promise.all(
      builds.map((build) =>
        this.signalPendingDeploymentReconciliation(build.id, Number(build.desiredGeneration)).catch((error) => {
          getLogger({ error, buildId: build.id }).warn('Build reconciliation: sweep signal failed');
        })
      )
    );
  }

  setupDeploymentReconciliationSweep(intervalMs = DEPLOYMENT_RECONCILIATION_SWEEP_MS): NodeJS.Timeout {
    void this.enqueuePendingDeploymentReconciliations().catch((error) =>
      getLogger({ error }).warn('Build reconciliation: initial sweep failed')
    );
    const timer = setInterval(() => {
      void this.enqueuePendingDeploymentReconciliations().catch((error) =>
        getLogger({ error }).warn('Build reconciliation: sweep failed')
      );
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  private isFinalDeploymentReconciliationAttempt(job: DeploymentReconciliationQueueJob): boolean {
    const attempts = Math.max(1, Number(job.opts?.attempts ?? 1));
    return Number(job.attemptsMade ?? 0) + 1 >= attempts;
  }

  /**
   * A failure can happen before the normal run claim finishes. On the final
   * BullMQ attempt, reacquire the short mutation lock and establish the same
   * generation token before publishing one terminal failure.
   */
  private async recordFinalDeploymentReconciliationFailure(
    buildId: number,
    claim: DeploymentReconciliationClaim,
    build: Build | null,
    runUUID: string | null,
    error: unknown
  ): Promise<boolean> {
    let failureBuild = build;
    let failureRunUUID = runUUID;

    if (!failureBuild || !failureRunUUID) {
      const terminalClaim = await this.withCurrentBuildDeploymentLock(
        buildId,
        async () => Boolean(await this.claimDeploymentReconciliation(buildId, claim.generation)),
        async () => {
          const currentClaim = await this.claimDeploymentReconciliation(buildId, claim.generation);
          if (!currentClaim || currentClaim.token !== claim.token) return null;

          const currentBuild = await this.loadBuildDeploymentAuthority(buildId);
          if (!currentBuild) return null;
          const claimedRunUUID = await this.claimDeploymentRun(currentBuild, claim.token, claim.generation);
          return claimedRunUUID ? { build: currentBuild, runUUID: claimedRunUUID } : null;
        }
      );
      if (!terminalClaim.admitted || !terminalClaim.value) return false;
      failureBuild = terminalClaim.value.build;
      failureRunUUID = terminalClaim.value.runUUID;
    }

    if (!(await this.isDeploymentRunCurrent(buildId, failureRunUUID, claim.generation))) return false;
    await this.recordBuildFailure(
      failureBuild,
      BuildStatus.ERROR,
      failureRunUUID,
      error,
      'Build queue processing failed.',
      claim.generation
    );
    return this.markDeploymentReconciliationObserved(buildId, claim.generation, failureRunUUID);
  }

  processDeploymentReconciliationQueue = async (job: DeploymentReconciliationQueueJob) => {
    const { buildId, generation, sender, correlationId, _ddTraceContext } = job.data;
    return withLogContext({ correlationId, sender, _ddTraceContext }, async () => {
      if (!buildId || !Number.isSafeInteger(Number(generation))) {
        throw new Error('buildId and generation are required');
      }

      await this.tryWithDeploymentGenerationLock(buildId, Number(generation), async () => {
        const claim = await this.claimDeploymentReconciliation(buildId, Number(generation));
        if (!claim) return;

        let build: Build | null = null;
        let activeBuild: Build | null = null;
        let activeRunUUID: string | null = null;
        try {
          const initialClaim = await this.withCurrentBuildDeploymentLock(
            buildId,
            async () => Boolean(await this.claimDeploymentReconciliation(buildId, claim.generation)),
            async () => {
              const currentClaim = await this.claimDeploymentReconciliation(buildId, claim.generation);
              if (!currentClaim) return;
              build = await this.loadBuildDeploymentAuthority(buildId);
              if (!build) return;
              if (build.uuid) updateLogContext({ buildUuid: build.uuid });

              const blocked = this.deploymentBlockReason(build);
              if (blocked) {
                getLogger({ buildId, generation: claim.generation }).info(
                  `Build reconciliation: observed without execution reason=${blocked}`
                );
                await this.markDeploymentReconciliationObserved(buildId, claim.generation);
                return;
              }
              activeRunUUID = await this.claimDeploymentRun(build, claim.token, claim.generation);
            }
          );

          if (!initialClaim.admitted || !build || !activeRunUUID) return;
          const reconciliationBuild = build;
          activeBuild = reconciliationBuild;
          const terminalOutcomes: Array<{ status: BuildStatus; error?: unknown }> = [];
          const scopes = this.deploymentReconciliationScopes(claim.dirty);
          getLogger({ stage: LogStage.BUILD_STARTING, buildId, generation: claim.generation }).info(
            `Build reconciliation: started scopes=${scopes.length}`
          );

          for (const scope of scopes) {
            const sourceRef = await this.resolveCurrentSourceRef(scope);
            let preparation: DeploymentScopePreparation | null = null;
            const configuration = await this.withCurrentBuildDeploymentLock(
              buildId,
              () => this.isDeploymentRunCurrent(buildId, claim.token, claim.generation),
              async () => {
                if (!(await this.isDeploymentRunCurrent(buildId, claim.token, claim.generation))) return;

                await this.importYamlConfigFile(
                  reconciliationBuild.environment!,
                  reconciliationBuild,
                  scope.githubRepositoryId ?? undefined,
                  {
                    skipDeletedServiceReconciliation: scope.skipDeletedServiceReconciliation,
                    sourceRef,
                    sourceBranch: scope.sourceBranch,
                    sourceGithubRepositoryId: scope.sourceGithubRepositoryId,
                    runUUID: claim.token,
                    expectedGeneration: claim.generation,
                  }
                );
                preparation = await this.prepareDeploymentScope(
                  reconciliationBuild,
                  scope.githubRepositoryId,
                  sourceRef,
                  {
                    runUUID: claim.token,
                    sourceBranch: scope.sourceBranch,
                    sourceGithubRepositoryId: scope.sourceGithubRepositoryId,
                    expectedGeneration: claim.generation,
                  }
                );
              }
            );

            if (!configuration.admitted || !preparation) return;
            const outcome = await this.executeDeploymentScope(preparation, claim.generation);
            if (!outcome) return;
            terminalOutcomes.push(outcome);
            if (!(await this.isDeploymentRunCurrent(buildId, claim.token, claim.generation))) return;
          }

          // Scope workers mutate one shared ingress snapshot. Publish it once,
          // after every selected scope has settled, so an earlier scope cannot
          // overwrite the final configuration for the same generation.
          if (terminalOutcomes.some(({ status }) => status === BuildStatus.DEPLOYED)) {
            await this.enqueueIngressManifest(buildId, claim.token, claim.generation);
          }

          const failedOutcome = terminalOutcomes.find(({ status }) => status === BuildStatus.ERROR);
          const finalStatus = failedOutcome
            ? BuildStatus.ERROR
            : isDeployEnabled(reconciliationBuild)
            ? BuildStatus.DEPLOYED
            : BuildStatus.BUILT;
          await this.updateStatusAndComment(
            reconciliationBuild,
            finalStatus,
            claim.token,
            true,
            true,
            failedOutcome?.error instanceof Error ? failedOutcome.error : null,
            claim.generation
          );

          if (await this.markDeploymentReconciliationObserved(buildId, claim.generation, claim.token)) {
            getLogger({ stage: LogStage.BUILD_COMPLETE, buildId, generation: claim.generation }).info(
              'Build reconciliation: completed'
            );
          }
        } catch (error) {
          if (error instanceof AuthorityLockLostError) {
            const stillCurrent = activeRunUUID
              ? await this.isDeploymentRunCurrent(buildId, activeRunUUID, claim.generation)
              : Boolean(await this.claimDeploymentReconciliation(buildId, claim.generation));
            if (stillCurrent) {
              getLogger({ error, buildId, generation: claim.generation }).warn(
                'Build reconciliation: mutation lock lost; leaving generation pending for retry'
              );
              throw error;
            }
          }
          const stillCurrent = activeRunUUID
            ? await this.isDeploymentRunCurrent(buildId, activeRunUUID, claim.generation)
            : Boolean(await this.claimDeploymentReconciliation(buildId, claim.generation));
          if (stillCurrent) {
            const configError = error instanceof ParsingError || error instanceof ValidationError;
            if (configError && activeBuild && activeRunUUID) {
              await this.recordBuildFailure(
                activeBuild,
                BuildStatus.CONFIG_ERROR,
                activeRunUUID,
                error,
                'Lifecycle configuration failed validation.',
                claim.generation
              );
              await this.markDeploymentReconciliationObserved(buildId, claim.generation, activeRunUUID);
              return;
            }

            if (!this.isFinalDeploymentReconciliationAttempt(job)) {
              getLogger({ error, buildId, generation: claim.generation }).warn(
                'Build reconciliation: transient failure; leaving generation pending for queue retry'
              );
              throw error;
            }

            if (
              await this.recordFinalDeploymentReconciliationFailure(buildId, claim, activeBuild, activeRunUUID, error)
            ) {
              getLogger({ stage: LogStage.BUILD_FAILED, buildId, generation: claim.generation }).error(
                { error },
                'Build reconciliation: failed after final queue attempt'
              );
              return;
            }

            // Authority may have changed while the final failure was being
            // recorded. Stale failures are intentionally silent; a still-current
            // failure must remain retryable if its terminal write could not land.
            if (!(await this.claimDeploymentReconciliation(buildId, claim.generation))) return;
            throw error;
          }
          getLogger({ buildId, generation: claim.generation }).info('Build reconciliation: stale failure ignored');
        }
      });
    });
  };

  /** Mixed-version rollout adapters; remove after no old queue payloads can remain. */
  processBuildQueue = async (job) => {
    await this.adoptLegacyDeploymentJob(job.data);
  };

  processResolveAndDeployBuildQueue = async (job) => {
    await this.adoptLegacyDeploymentJob(job.data);
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Stable SHA-256 over the SEMANTIC create-request only: repo, branch, sha, environmentId, name,
 * service overrides (order-independent), env/initEnv, and the deploy/track/ttl flags — never the
 * idempotencyKey or any auth/attribution field. Backs an idempotent replay's conflict check.
 */
export function computeIdempotencyRequestDigest(input: CreateApiEnvironmentInput): string {
  const services = (input.services ?? [])
    .map((service) => ({
      name: service.name,
      active: service.active ?? null,
      branchOrExternalUrl: service.branchOrExternalUrl ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const semantic = {
    repositoryFullName: normalizeRepoFullName(input.repositoryFullName ?? ''),
    branch: (input.branch ?? '').trim(),
    sha: input.sha ?? null,
    environmentId: input.environmentId ?? null,
    name: input.name ?? null,
    services,
    env: input.env ?? {},
    initEnv: input.initEnv ?? input.env ?? {},
    deployEnabled: input.deployEnabled ?? true,
    trackDefaultBranches: input.trackDefaultBranches ?? false,
    autoTrack: input.autoTrack ?? false,
    ttlHours: input.ttlHours ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(semantic)))
    .digest('hex');
}

/**
 * Re-guard an idempotent replay before returning the stored Build: a different request body
 * under the same key is a 409 conflict; a repo-constrained principal (non-null authorizedRepoIds)
 * may only replay a Build whose repository it still holds, else 403.
 */
export function assertIdempotentReplayAllowed(
  existing: { idempotencyRequestDigest?: string | null; githubRepositoryId?: number | null },
  incomingDigest: string,
  authorizedRepoIds: number[] | null | undefined
): void {
  if (existing.idempotencyRequestDigest && existing.idempotencyRequestDigest !== incomingDigest) {
    throw new AppError({
      httpStatus: 409,
      code: 'idempotency_conflict',
      message: 'This idempotency key was already used with a different request.',
    });
  }
  if (authorizedRepoIds != null) {
    assertRepositoryIdAllowed(existing.githubRepositoryId, authorizedRepoIds);
  }
}

interface NormalizedCreateApiEnvironmentAuthorization {
  repositoryAllowlistRepoIds: number[] | null;
  repositoryAllowlist: string[] | null;
}

function normalizeCreateApiEnvironmentAuthorization(
  authorization: CreateApiEnvironmentAuthorization | null | undefined
): NormalizedCreateApiEnvironmentAuthorization {
  if (authorization == null) {
    return { repositoryAllowlistRepoIds: null, repositoryAllowlist: null };
  }
  return {
    repositoryAllowlistRepoIds:
      authorization.repositoryAllowlistRepoIds == null
        ? null
        : authorization.repositoryAllowlistRepoIds.map(Number).filter(Number.isFinite),
    repositoryAllowlist:
      authorization.repositoryAllowlist == null ? null : authorization.repositoryAllowlist.map(normalizeRepoFullName),
  };
}

function forbiddenRepositoryError(): AppError {
  return new AppError({
    httpStatus: 403,
    code: 'forbidden_repository',
    message: 'This API key is not authorized for the repository of the referenced environment.',
  });
}

function assertRepositoryIdAllowed(githubRepositoryId: number | null | undefined, authorizedRepoIds: number[]): void {
  const allowed = githubRepositoryId != null && authorizedRepoIds.map(Number).includes(Number(githubRepositoryId));
  if (!allowed) throw forbiddenRepositoryError();
}

export interface CreateApiEnvironmentInput {
  repositoryFullName: string;
  branch: string;
  sha?: string | null;
  environmentId?: number | null;
  name?: string | null;
  services?: { name: string; active?: boolean; branchOrExternalUrl?: string }[] | null;
  env?: Record<string, string> | null;
  initEnv?: Record<string, string> | null;
  deployEnabled?: boolean;
  trackDefaultBranches?: boolean;
  autoTrack?: boolean;
  ttlHours?: number | null;
  idempotencyKey?: string | null;
  createdByTokenId?: number | null;
  createdBy?: string | null;
  createdByUserId?: string | null;
  createdByGithubLogin?: string | null;
}

export interface CreateApiEnvironmentResult {
  build: Build;
  replayed: boolean;
}

interface EnvironmentConfigPreviewService {
  name: string;
  type: string | null;
  defaultActive: boolean;
  editable: boolean;
  branchRepository?: string | null;
  branchConfigurationRepository?: string | null;
  effectiveBranch?: string | null;
  repository?: string | null;
  resolvedFromRepositoryId?: number | null;
  status?: YamlService.EnvironmentServiceResolutionStatus;
  reason?: string;
  previewOnly?: boolean;
}

interface EnvironmentConfigPreviewResult {
  valid: boolean;
  error?: string;
  services: EnvironmentConfigPreviewService[];
  complete?: boolean;
  pending?: YamlService.PendingEnvironmentService[];
  unresolved?: Array<{
    name: string;
    repository: string;
    branch: string;
    status: YamlService.UnresolvedEnvironmentService['status'];
    reason: string;
  }>;
  truncated?: boolean;
}

function hasExtendedPreviewReferences(config: LifecycleConfig): boolean {
  const references = [
    ...(config?.environment?.defaultServices ?? []),
    ...(config?.environment?.optionalServices ?? []),
  ];
  return references.some((reference) => reference?.serviceId != null || reference?.repository != null);
}

function hasServiceIdPreviewReferences(config: LifecycleConfig): boolean {
  const references = [
    ...(config?.environment?.defaultServices ?? []),
    ...(config?.environment?.optionalServices ?? []),
  ];
  return references.some((reference) => reference?.serviceId != null);
}

function environmentServiceResolutionReasonText(reason: YamlService.EnvironmentServiceResolutionReason): string {
  switch (reason) {
    case 'repo_not_onboarded':
      return 'Repository is not onboarded in Lifecycle.';
    case 'repository_name_missing':
      return 'Service reference is missing a repository name.';
    case 'config_unavailable':
      return 'lifecycle.yaml was not found or is empty at this branch.';
    case 'config_fetch_failed':
      return 'lifecycle.yaml could not be loaded from this repository.';
    case 'invalid_lifecycle_yaml':
      return 'lifecycle.yaml is invalid.';
    case 'github_rate_limited':
      return 'GitHub rate limit reached. Try again shortly.';
    case 'service_name_missing':
      return 'Service reference is missing a name.';
    case 'service_not_found':
      return "Service was not found in this repository's lifecycle.yaml.";
    case 'service_id_not_supported':
      return 'serviceId references in lifecycle.yaml are no longer supported.';
    case 'max_references_exceeded':
      return 'Service resolution exceeded the maximum reference count.';
    default:
      return 'Service could not be resolved.';
  }
}

function buildResolvedServicePreviews(
  services: YamlService.ResolvedEnvironmentService[],
  rootRepositoryFullName: string
): EnvironmentConfigPreviewService[] {
  const rowCountByOriginalName = new Map<string, number>();
  for (const service of services) {
    rowCountByOriginalName.set(service.originalName, (rowCountByOriginalName.get(service.originalName) ?? 0) + 1);
  }
  const collisionOriginalNames = new Set(
    [...rowCountByOriginalName].filter(([, count]) => count > 1).map(([originalName]) => originalName)
  );
  return services.map((service) =>
    buildResolvedServicePreview(service, rootRepositoryFullName, collisionOriginalNames)
  );
}

function buildResolvedServicePreview(
  service: YamlService.ResolvedEnvironmentService,
  rootRepositoryFullName: string,
  collisionOriginalNames: Set<string>
): EnvironmentConfigPreviewService {
  const preview: EnvironmentConfigPreviewService = {
    name: service.name,
    type: service.type ?? null,
    defaultActive: service.defaultActive,
    editable: isBranchOrExternalUrlEditable(service.type ?? undefined),
    ...(service.branchRepository !== undefined ? { branchRepository: service.branchRepository } : {}),
    ...(service.branchConfigurationRepository !== undefined
      ? { branchConfigurationRepository: service.branchConfigurationRepository }
      : {}),
    ...(service.effectiveBranch !== undefined ? { effectiveBranch: service.effectiveBranch } : {}),
  };
  const collision = service.name !== service.originalName || collisionOriginalNames.has(service.originalName);
  const previewOnly = collision;
  const rootLocalResolved =
    service.status === 'resolved' &&
    !previewOnly &&
    normalizeRepoFullName(service.repository) === normalizeRepoFullName(rootRepositoryFullName);
  if (rootLocalResolved) return preview;

  let reason: string | undefined;
  if (service.reason) {
    reason = environmentServiceResolutionReasonText(service.reason);
  } else if (collision) {
    reason = 'Service-name collisions are preview-only until collision-safe build names are persisted.';
  }

  return {
    ...preview,
    editable: previewOnly ? false : preview.editable,
    repository: service.repository,
    resolvedFromRepositoryId: service.resolvedFromRepositoryId,
    status: service.status,
    ...(reason ? { reason } : {}),
    ...(previewOnly ? { previewOnly: true } : {}),
  };
}

/** Service list for the create-env UI preview: default-services active, optional-services inactive, type-derived editability. */
function buildServicePreview(
  config: LifecycleConfig,
  rootRepositoryFullName: string,
  rootBranch: string
): EnvironmentConfigPreviewService[] {
  const serviceByName = new Map<string, Service>();
  for (const service of config?.services ?? []) {
    if (service?.name) serviceByName.set(service.name, service);
  }

  const rowIndexByName = new Map<string, number>();
  const out: EnvironmentConfigPreviewService[] = [];
  const env = config?.environment;
  const defaultServices = env?.defaultServices ?? [];
  const optionalServices = env?.optionalServices ?? [];
  const catalogFallback = defaultServices.length === 0 && optionalServices.length === 0;
  const push = (
    name: string | undefined | null,
    defaultActive: boolean,
    referenceRepository?: string,
    referenceBranch?: string
  ) => {
    if (!name) return;
    const incomingBranchConfigurationRepository = canonicalBranchConfigurationRepository(referenceRepository);
    const existingIndex = rowIndexByName.get(name);
    if (existingIndex != null) {
      const existing = out[existingIndex];
      const promoteBranchConfigurationRepository =
        existing.branchRepository !== undefined &&
        existing.branchConfigurationRepository == null &&
        incomingBranchConfigurationRepository != null;
      if ((defaultActive && !existing.defaultActive) || promoteBranchConfigurationRepository) {
        out[existingIndex] = {
          ...existing,
          defaultActive: existing.defaultActive || defaultActive,
          ...(promoteBranchConfigurationRepository
            ? { branchConfigurationRepository: incomingBranchConfigurationRepository }
            : {}),
        };
      }
      return;
    }
    const service = serviceByName.get(name);
    const type = service ? getDeployType(service) : undefined;
    const branchRepository =
      service && (type === DeployTypes.GITHUB || type === DeployTypes.HELM)
        ? getRepositoryName(service)?.trim() || null
        : undefined;
    const contextRepository = referenceRepository ?? rootRepositoryFullName;
    const contextBranch = referenceRepository != null ? referenceBranch ?? 'main' : rootBranch;
    const effectiveBranch =
      branchRepository !== undefined
        ? catalogFallback
          ? rootBranch
          : branchRepository != null &&
            normalizeRepoFullName(branchRepository) === normalizeRepoFullName(contextRepository)
          ? contextBranch
          : branchRepository == null
          ? 'main'
          : getBranchName(service!) ?? 'main'
        : undefined;
    out.push({
      name,
      type: type ?? null,
      defaultActive,
      editable: isBranchOrExternalUrlEditable(type),
      ...(branchRepository !== undefined ? { branchRepository } : {}),
      ...(branchRepository !== undefined
        ? { branchConfigurationRepository: incomingBranchConfigurationRepository }
        : {}),
      ...(effectiveBranch !== undefined ? { effectiveBranch } : {}),
    });
    rowIndexByName.set(name, out.length - 1);
  };

  const canonicalBranchConfigurationRepository = (repository: string | undefined): string | null => {
    if (repository == null) return null;
    return normalizeRepoFullName(repository) === normalizeRepoFullName(rootRepositoryFullName)
      ? rootRepositoryFullName
      : repository.trim() || null;
  };

  defaultServices.forEach((service) => push(service?.name, true, service?.repository, service?.branch));
  optionalServices.forEach((service) => push(service?.name, false, service?.repository, service?.branch));
  // No environment service lists (e.g. minimal yaml): fall back to the catalog, all active.
  if (out.length === 0) {
    for (const service of config?.services ?? []) push(service?.name, true);
  }
  return out;
}

/** SECURITY: API-supplied env overrides must not smuggle secret references ({{vault:...}}) into pods — non-string values would carry them past a string-only scan. */
function rejectSecretRefEnv(
  env: Record<string, string | null> | null | undefined,
  field: string,
  allowNull = false
): void {
  if (!env) return;
  for (const [key, value] of Object.entries(env)) {
    if (value === null && allowNull) continue;
    if (typeof value !== 'string') {
      throw new AppError({
        httpStatus: 422,
        code: 'override_not_allowed',
        message: `${field}.${key} must be a string.`,
      });
    }
    if (containsSecretRefTemplate(value)) {
      throw new AppError({
        httpStatus: 422,
        code: 'override_not_allowed',
        message: `${field}.${key} contains a secret reference; secret refs are not allowed in API overrides.`,
      });
    }
  }
}

function applyEnvironmentMapPatch(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, string | null>,
  mode: 'merge' | 'replace'
): Record<string, string> {
  const result: Record<string, string> = mode === 'merge' ? { ...(current as Record<string, string>) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

function serviceOverrideChanges(
  deploys: Deploy[],
  serviceOverride: { name: string; active?: boolean; branchOrExternalUrl?: string }
): boolean {
  const deploy = deploys.find((candidate) => candidate.deployable?.name === serviceOverride.name);
  if (!deploy) return true;
  if (serviceOverride.active !== undefined && serviceOverride.active !== deploy.active) return true;
  if (serviceOverride.branchOrExternalUrl !== undefined) {
    const current =
      deploy.deployable!.type === DeployTypes.EXTERNAL_HTTP
        ? deploy.publicUrl ?? undefined
        : deploy.branchName ?? undefined;
    if (serviceOverride.branchOrExternalUrl !== current) return true;
  }
  return false;
}

function timestampSecond(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.trunc(timestamp / 1000) : null;
}

async function insertOnUuid(
  insert: (uuid: string) => Promise<Build>,
  haikunator: { haikunate: () => string }
): Promise<Build> {
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await insert(haikunator.haikunate());
    } catch (error) {
      lastError = error;
      if (!(error instanceof UniqueViolationError)) throw error;
    }
  }
  throw lastError;
}
