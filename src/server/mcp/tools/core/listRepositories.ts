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

import { isAppError } from 'server/lib/appError';
import { listBranchesForRepo } from 'server/lib/github';
import { redactExternalText } from 'server/lib/externalText';
import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { MCP_EXECUTION_ERROR_CODES, McpExecutionError, type McpExecutionErrorCode } from '../../errors';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import { decodeListCursor, encodeListCursor } from '../../state/listCursor';
import Environment from 'server/models/Environment';
import Repository from 'server/models/Repository';
import Service from 'server/models/Service';
import RepositoryService, { type RepositoryListResult, type RepositoryResponse } from 'server/services/repository';

const DESCRIPTION =
  "Lists the repositories you can create environments from. Pass `repository` to get one repository's detail with its branches. Repositories must be onboarded to Lifecycle before environments can be created from them.";

const REPOSITORY_PATTERN = '^[^/]+/[^/]+$';

export interface CoreRepositoryRecord {
  githubRepositoryId: number;
  fullName: string;
  defaultEnvId: number | null;
}

export interface CoreRepositoryEnvironment {
  environmentConfigId: number;
  name: string;
  isDefault: boolean;
}

export interface ListRepositoriesToolDependencies {
  listOnboardedRepositories?: (input: {
    query: string;
    page: number;
    limit: number;
    allowedGithubRepositoryIds: number[] | null;
    allowedRepositoryFullNames: string[] | null;
  }) => Promise<RepositoryListResult<RepositoryResponse>>;
  findRepository?: (fullName: string) => Promise<CoreRepositoryRecord | null>;
  listBranches?: (fullName: string) => Promise<{ branches: string[]; defaultBranch: string | null }>;
  listRepositoryEnvironments?: (repository: CoreRepositoryRecord) => Promise<CoreRepositoryEnvironment[]>;
  nowSeconds?: () => number;
}

const repositoryNameSchema = {
  type: 'string',
  maxLength: 140,
  pattern: REPOSITORY_PATTERN,
} as const;

const listRequestSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'list' },
    q: { type: 'string', maxLength: 100 },
    cursor: { type: 'string', maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  },
  ['mode']
);

const detailRequestSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'detail' },
    repository: repositoryNameSchema,
  },
  ['mode', 'repository']
);

export const listRepositoriesInputSchema = closedObjectSchema(
  {
    request: { oneOf: [listRequestSchema, detailRequestSchema] },
  },
  ['request']
);

const repositoryListRowSchema = closedObjectSchema(
  {
    fullName: repositoryNameSchema,
    hasDefaultEnvironment: { type: 'boolean' },
  },
  ['fullName', 'hasDefaultEnvironment']
);

const repositoryEnvironmentSchema = closedObjectSchema(
  {
    environmentConfigId: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    isDefault: { type: 'boolean' },
  },
  ['environmentConfigId', 'name', 'isDefault']
);

const listResultSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'list' },
    repositories: {
      type: 'array',
      minItems: 0,
      maxItems: 100,
      items: repositoryListRowSchema,
    },
    nextCursor: { type: 'string', maxLength: 500 },
  },
  ['mode', 'repositories']
);

const detailResultSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'detail' },
    repository: closedObjectSchema(
      {
        fullName: repositoryNameSchema,
        defaultBranch: { type: 'string', maxLength: 255 },
        hasDefaultEnvironment: { type: 'boolean' },
        environments: {
          type: 'array',
          minItems: 0,
          maxItems: 100,
          items: repositoryEnvironmentSchema,
        },
        branches: {
          type: 'array',
          minItems: 0,
          maxItems: 101,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 255 },
        },
      },
      ['fullName', 'defaultBranch', 'hasDefaultEnvironment', 'environments', 'branches']
    ),
  },
  ['mode', 'repository']
);

export const listRepositoriesOutputSchema = successObjectSchema(
  {
    result: { oneOf: [listResultSchema, detailResultSchema] },
  },
  ['result']
);

export function safeCoreText(value: unknown, maxBytes: number): string {
  return redactExternalText(value, maxBytes);
}

export function mapCoreToolError(error: unknown): McpExecutionError {
  if (error instanceof McpExecutionError) return error;
  if (isAppError(error) && MCP_EXECUTION_ERROR_CODES.includes(error.code as McpExecutionErrorCode)) {
    return new McpExecutionError(error.code as McpExecutionErrorCode, error.message, {
      ...(error.details ? { details: error.details as McpJsonObject } : {}),
    });
  }
  return new McpExecutionError(
    'internal_error',
    'Lifecycle could not complete this request. Ask an administrator for help.'
  );
}

async function defaultListOnboardedRepositories(input: {
  query: string;
  page: number;
  limit: number;
  allowedGithubRepositoryIds: number[] | null;
  allowedRepositoryFullNames: string[] | null;
}): Promise<RepositoryListResult<RepositoryResponse>> {
  return new RepositoryService().listOnboardedRepositories(input);
}

export async function defaultFindRepository(fullName: string): Promise<CoreRepositoryRecord | null> {
  const repository = await Repository.query()
    .whereRaw('lower("fullName") = ?', [fullName.trim().toLowerCase()])
    .whereNull('deletedAt')
    .first();
  return repository
    ? {
        githubRepositoryId: Number(repository.githubRepositoryId),
        fullName: repository.fullName,
        defaultEnvId: repository.defaultEnvId == null ? null : Number(repository.defaultEnvId),
      }
    : null;
}

export async function defaultListRepositoryEnvironments(
  repository: CoreRepositoryRecord
): Promise<CoreRepositoryEnvironment[]> {
  const [defaultMemberships, optionalMemberships] = await Promise.all([
    Service.query()
      .alias('service')
      .join('environmentDefaultServices as membership', 'membership.serviceId', 'service.id')
      .distinct('membership.environmentId as environmentId')
      .where('service.repositoryId', repository.githubRepositoryId)
      .whereNull('service.deletedAt')
      .whereNotNull('membership.environmentId'),
    Service.query()
      .alias('service')
      .join('environmentOptionalServices as membership', 'membership.serviceId', 'service.id')
      .distinct('membership.environmentId as environmentId')
      .where('service.repositoryId', repository.githubRepositoryId)
      .whereNull('service.deletedAt')
      .whereNotNull('membership.environmentId'),
  ]);
  const ids = [
    ...new Set([
      ...[...defaultMemberships, ...optionalMemberships]
        .map((service) => Number(service.environmentId))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
      ...(repository.defaultEnvId == null ? [] : [Number(repository.defaultEnvId)]),
    ]),
  ];
  if (ids.length === 0) return [];

  const environments = await Environment.query().whereIn('id', ids);
  return environments
    .map((environment) => ({
      environmentConfigId: Number(environment.id),
      name: environment.name,
      isDefault: repository.defaultEnvId != null && Number(repository.defaultEnvId) === Number(environment.id),
    }))
    .filter(
      (environment) =>
        Number.isSafeInteger(environment.environmentConfigId) &&
        environment.environmentConfigId > 0 &&
        environment.name.length > 0
    )
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .slice(0, 100);
}

function resolveDependencies(
  dependencies: ListRepositoriesToolDependencies
): Required<ListRepositoriesToolDependencies> {
  return {
    listOnboardedRepositories: dependencies.listOnboardedRepositories ?? defaultListOnboardedRepositories,
    findRepository: dependencies.findRepository ?? defaultFindRepository,
    listBranches: dependencies.listBranches ?? listBranchesForRepo,
    listRepositoryEnvironments: dependencies.listRepositoryEnvironments ?? defaultListRepositoryEnvironments,
    nowSeconds: dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
  };
}

function safeBranches(result: { branches: string[]; defaultBranch: string | null }): {
  branches: string[];
  defaultBranch: string;
} {
  const defaultBranch = safeCoreText(result.defaultBranch ?? '', 255);
  const branches = [...new Set(result.branches.map((branch) => safeCoreText(branch, 255)).filter(Boolean))];
  const bounded = branches.slice(0, 100);
  if (defaultBranch && !bounded.includes(defaultBranch)) bounded.push(defaultBranch);
  return { branches: bounded, defaultBranch };
}

export function createListRepositoriesToolDefinition(
  providedDependencies: ListRepositoriesToolDependencies = {}
): McpToolDefinition {
  const dependencies = resolveDependencies(providedDependencies);
  return {
    name: 'list_repositories',
    title: 'List repositories',
    description: DESCRIPTION,
    inputSchema: listRepositoriesInputSchema,
    outputSchema: listRepositoriesOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    capabilityId: 'understand-environments',
    access: 'read',
    async handler(input): Promise<McpJsonObject> {
      try {
        const request = input.request as McpJsonObject;
        if (request.mode === 'detail') {
          const requestedName = request.repository as string;
          const repository = await dependencies.findRepository(requestedName);
          if (!repository) {
            throw new McpExecutionError(
              'repo_not_onboarded',
              'That repository is not onboarded. Call list_repositories in list mode to see repositories you can use.'
            );
          }
          const [branchResult, environments] = await Promise.all([
            dependencies.listBranches(repository.fullName),
            dependencies.listRepositoryEnvironments(repository),
          ]);
          const branchInfo = safeBranches(branchResult);
          return {
            result: {
              mode: 'detail',
              repository: {
                fullName: safeCoreText(repository.fullName, 140),
                defaultBranch: branchInfo.defaultBranch,
                hasDefaultEnvironment: repository.defaultEnvId != null,
                environments: environments.slice(0, 100).map((environment) => ({
                  environmentConfigId: environment.environmentConfigId,
                  name: safeCoreText(environment.name, 100),
                  isDefault: environment.isDefault,
                })),
                branches: branchInfo.branches,
              },
            },
          };
        }

        const q = typeof request.q === 'string' ? request.q.trim().toLowerCase() : '';
        const limit = typeof request.limit === 'number' ? request.limit : 25;
        const filters: McpJsonObject = {
          mode: 'list',
          q,
        };
        const cursor =
          typeof request.cursor === 'string'
            ? decodeListCursor(request.cursor, filters, limit, dependencies.nowSeconds())
            : null;
        const page = cursor ? cursor.position + 1 : 1;
        const result = await dependencies.listOnboardedRepositories({
          query: q,
          page,
          limit,
          allowedGithubRepositoryIds: null,
          allowedRepositoryFullNames: null,
        });
        const rows = result.repositories.map((repository) => ({
          fullName: safeCoreText(repository.fullName, 140),
          hasDefaultEnvironment: repository.defaultEnvId != null,
        }));
        const nextCursor =
          result.pagination.current < result.pagination.total
            ? encodeListCursor(
                {
                  position: result.pagination.current,
                  filters,
                  limit,
                },
                dependencies.nowSeconds()
              )
            : undefined;
        return {
          result: {
            mode: 'list',
            repositories: rows,
            ...(nextCursor ? { nextCursor } : {}),
          },
        };
      } catch (error) {
        throw mapCoreToolError(error);
      }
    },
  };
}
