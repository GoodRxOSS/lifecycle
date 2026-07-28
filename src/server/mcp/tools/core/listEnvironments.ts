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

import { createHash } from 'crypto';
import BuildService from 'server/services/build';
import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { normalizeMcpDateTime } from '../../dateTime';
import { McpExecutionError } from '../../errors';
import { BUILD_STATUSES, ENVIRONMENT_PHASES } from '../statusValues';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import { decodeListCursor, encodeListCursor } from '../../state/listCursor';
import { buildLifecycleUiEnvironmentUrl, lifecycleUiUrlSchema } from './environmentUrl';
import { defaultFindRepository, mapCoreToolError, safeCoreText, type CoreRepositoryRecord } from './listRepositories';

const DESCRIPTION =
  'Lists environments you can see, newest first. Each `lifecycleUiUrl` opens that environment in Lifecycle; show it when the user needs deployment status. Use `mine: true` for only the ones you created, `search` for free-text matching, and `repository` for an exact repo filter. Destroyed environments are hidden unless you set `includeTornDown`.';

interface EnvironmentListResult {
  data: Record<string, unknown>[];
  paginationMetadata: {
    current: number;
    total: number;
    items: number;
    limit: number;
  };
}

export interface ListEnvironmentsToolDependencies {
  listEnvironments?: (params: {
    excludeStatuses?: string | null;
    statuses?: string[] | null;
    search?: string | null;
    trigger?: string | null;
    repositoryGithubRepositoryId?: number | null;
    githubLogin?: string | null;
    ownerUserId?: string | null;
    createdBefore?: string | null;
    createdAfter?: string | null;
    expiresBefore?: string | null;
    pagination?: { page?: number; limit?: number };
  }) => Promise<EnvironmentListResult>;
  findRepository?: (fullName: string) => Promise<CoreRepositoryRecord | null>;
  nowSeconds?: () => number;
}

export const listEnvironmentsInputSchema = closedObjectSchema({
  search: { type: 'string', maxLength: 200 },
  repository: {
    type: 'string',
    maxLength: 140,
    pattern: '^[^/]+/[^/]+$',
  },
  mine: { type: 'boolean' },
  trigger: { type: 'string', enum: ['api', 'github_pr'] },
  status: {
    type: 'array',
    minItems: 0,
    maxItems: 10,
    uniqueItems: true,
    items: { type: 'string', enum: BUILD_STATUSES },
  },
  createdBefore: { type: 'string', format: 'date-time' },
  createdAfter: { type: 'string', format: 'date-time' },
  expiresBefore: { type: 'string', format: 'date-time' },
  includeTornDown: { type: 'boolean', default: false },
  cursor: { type: 'string', maxLength: 500 },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
});

const pullRequestSchema = closedObjectSchema(
  {
    number: { type: 'integer', minimum: 1 },
    title: { type: 'string', maxLength: 500 },
    status: { type: 'string', minLength: 1, maxLength: 100 },
  },
  ['number', 'title', 'status']
);

export const conciseEnvironmentSummarySchema = closedObjectSchema(
  {
    uuid: { type: 'string', minLength: 1, maxLength: 63 },
    environmentId: { type: 'integer', minimum: 1 },
    lifecycleUiUrl: lifecycleUiUrlSchema,
    status: { type: 'string', enum: BUILD_STATUSES },
    phase: { type: 'string', enum: ENVIRONMENT_PHASES },
    statusMessage: { type: 'string', minLength: 1, maxLength: 1000 },
    repository: { type: 'string', maxLength: 140, pattern: '^[^/]+/[^/]+$' },
    branch: { type: 'string', maxLength: 255 },
    trigger: { type: 'string', enum: ['api', 'github_pr'] },
    isStatic: { type: 'boolean' },
    deployEnabled: { type: 'boolean' },
    expiresAt: { type: 'string', format: 'date-time' },
    activeServiceCount: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    ready: { type: 'boolean' },
    author: { type: 'string', minLength: 1, maxLength: 255 },
    pullRequest: { oneOf: [pullRequestSchema, { type: 'null' }] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    deletedAt: { type: 'string', format: 'date-time' },
  },
  [
    'uuid',
    'environmentId',
    'status',
    'phase',
    'repository',
    'branch',
    'trigger',
    'isStatic',
    'deployEnabled',
    'activeServiceCount',
    'ready',
    'pullRequest',
    'createdAt',
    'updatedAt',
  ]
);

export const listEnvironmentsOutputSchema = successObjectSchema(
  {
    environments: {
      type: 'array',
      minItems: 0,
      maxItems: 100,
      items: conciseEnvironmentSummarySchema,
    },
    nextCursor: { type: 'string', maxLength: 500 },
  },
  ['environments']
);

function safeOptionalText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return safeCoreText(value, maxBytes) || undefined;
}

function environmentSummary(row: Record<string, unknown>): McpJsonObject | null {
  const repository = safeOptionalText(row.repository, 140);
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) return null;
  const phase = ENVIRONMENT_PHASES.find((candidate) => candidate === row.phase) ?? 'in_progress';
  const status = BUILD_STATUSES.find((candidate) => candidate === row.status) ?? 'pending';
  const pullRequest =
    row.pullRequest && typeof row.pullRequest === 'object' && !Array.isArray(row.pullRequest)
      ? (row.pullRequest as Record<string, unknown>)
      : null;
  const pullRequestNumber = pullRequest ? Number(pullRequest.number) : NaN;
  const createdAt = normalizeMcpDateTime(row.createdAt);
  const updatedAt = normalizeMcpDateTime(row.updatedAt);
  if (!createdAt || !updatedAt) return null;
  const expiresAt = normalizeMcpDateTime(row.expiresAt);
  const deletedAt = normalizeMcpDateTime(row.deletedAt);
  const statusMessage = phase === 'failed' ? safeOptionalText(row.statusMessage, 1000) : undefined;
  const author = safeOptionalText(row.author, 255);
  const environmentId = Number(row.environmentId);
  if (!Number.isSafeInteger(environmentId) || environmentId < 1) return null;
  const uuid = safeCoreText(row.uuid, 63);
  const lifecycleUiUrl = buildLifecycleUiEnvironmentUrl(uuid);
  return {
    uuid,
    environmentId,
    ...(lifecycleUiUrl ? { lifecycleUiUrl } : {}),
    status,
    phase,
    ...(statusMessage ? { statusMessage } : {}),
    repository,
    branch: safeCoreText(row.branch, 255),
    trigger: row.trigger === 'api' ? 'api' : 'github_pr',
    isStatic: row.isStatic === true,
    deployEnabled: row.deployEnabled === true,
    ...(expiresAt ? { expiresAt } : {}),
    activeServiceCount: Math.max(0, Number(row.activeServiceCount) || 0),
    ready: row.ready === true,
    ...(author ? { author } : {}),
    pullRequest:
      pullRequest && Number.isSafeInteger(pullRequestNumber) && pullRequestNumber > 0
        ? {
            number: pullRequestNumber,
            title: safeCoreText(pullRequest.title, 500),
            status: safeCoreText(pullRequest.status, 100) || 'unknown',
          }
        : null,
    createdAt,
    updatedAt,
    ...(deletedAt ? { deletedAt } : {}),
  };
}

export function createListEnvironmentsToolDefinition(
  dependencies: ListEnvironmentsToolDependencies = {}
): McpToolDefinition {
  let defaultBuildService: BuildService | undefined;
  const listEnvironments =
    dependencies.listEnvironments ??
    ((params) => (defaultBuildService ??= new BuildService()).listEnvironments(params));
  const findRepository = dependencies.findRepository ?? defaultFindRepository;
  const nowSeconds = dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  return {
    name: 'list_environments',
    title: 'List environments',
    description: DESCRIPTION,
    inputSchema: listEnvironmentsInputSchema,
    outputSchema: listEnvironmentsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'understand-environments',
    access: 'read',
    async handler(input, context): Promise<McpJsonObject> {
      try {
        const repositoryName = typeof input.repository === 'string' ? input.repository : undefined;
        const repository = repositoryName ? await findRepository(repositoryName) : null;
        if (repositoryName && !repository) {
          throw new McpExecutionError(
            'repo_not_onboarded',
            'That repository is not onboarded. Call list_repositories to see repositories you can use.'
          );
        }
        const mine = input.mine === true;
        const ownerUserId = mine ? context.principal.userId : null;
        const githubLogin = mine ? context.principal.identity?.githubUsername ?? null : null;
        if (mine && ownerUserId == null && githubLogin == null) {
          return { environments: [] };
        }

        const limit = typeof input.limit === 'number' ? input.limit : 25;
        const search = typeof input.search === 'string' ? input.search.trim().toLowerCase() : '';
        const filterState: McpJsonObject = {
          search,
          repository: repository?.fullName ?? '',
          mine,
          trigger: typeof input.trigger === 'string' ? input.trigger : '',
          status: Array.isArray(input.status) ? [...input.status].map(String).sort() : [],
          createdBefore: typeof input.createdBefore === 'string' ? input.createdBefore : '',
          createdAfter: typeof input.createdAfter === 'string' ? input.createdAfter : '',
          expiresBefore: typeof input.expiresBefore === 'string' ? input.expiresBefore : '',
          includeTornDown: input.includeTornDown === true,
          owner: mine ? `user:${ownerUserId ?? ''}:${githubLogin ?? ''}` : '',
        };
        const filters: McpJsonObject = {
          binding: createHash('sha256').update(JSON.stringify(filterState), 'utf8').digest('base64url'),
        };
        const cursor =
          typeof input.cursor === 'string' ? decodeListCursor(input.cursor, filters, limit, nowSeconds()) : null;
        const result = await listEnvironments({
          excludeStatuses: input.includeTornDown === true ? '' : 'torn_down',
          statuses: Array.isArray(input.status) ? (input.status as string[]) : null,
          search: search || null,
          trigger: typeof input.trigger === 'string' ? input.trigger : null,
          repositoryGithubRepositoryId: repository?.githubRepositoryId ?? null,
          githubLogin,
          ownerUserId,
          createdBefore: typeof input.createdBefore === 'string' ? input.createdBefore : null,
          createdAfter: typeof input.createdAfter === 'string' ? input.createdAfter : null,
          expiresBefore: typeof input.expiresBefore === 'string' ? input.expiresBefore : null,
          pagination: { page: cursor ? cursor.position + 1 : 1, limit },
        });
        const environments = result.data.map(environmentSummary).filter((row): row is McpJsonObject => row !== null);
        const nextCursor =
          result.paginationMetadata.current < result.paginationMetadata.total
            ? encodeListCursor(
                {
                  position: result.paginationMetadata.current,
                  filters,
                  limit,
                },
                nowSeconds()
              )
            : undefined;
        return {
          environments,
          ...(nextCursor ? { nextCursor } : {}),
        };
      } catch (error) {
        throw mapCoreToolError(error);
      }
    },
  };
}
