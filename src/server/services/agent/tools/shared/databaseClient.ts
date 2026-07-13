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

interface QueryOptions {
  table: string;
  filters?: Record<string, any>;
  relations?: string[];
  limit?: number;
  select?: string[];
  orderBy?: string;
  offset?: number;
}

interface QueryResult {
  records: any[];
  totalCount: number;
  warnings?: string[];
}

interface TableSchema {
  primaryKey?: string;
  columns: string[];
  columnAliases?: Record<string, string>;
  relations: Record<string, string>;
}

/** SECURITY: the single build a session is scoped to; every query is constrained to its rows so a model can't read other tenants'. */
export interface DatabaseBuildScope {
  buildId: number;
  buildUuid: string;
  pullRequestId?: number | null;
  environmentId?: number | null;
  repositoryIds?: number[];
}

export class DatabaseClient {
  // SECURITY: when set, a mandatory per-table WHERE is ANDed onto every query and can't be widened by model filters.
  private buildScope: DatabaseBuildScope | null = null;

  constructor(private db: any) {}

  setBuildScope(scope: DatabaseBuildScope | null | undefined): void {
    this.buildScope = scope ?? null;
  }

  /** Mandatory scope clause for a table; throws if the build doesn't constrain it (table not queryable) or scope is unresolved. */
  private buildScopeClause(table: string): { column: string; value?: any; in?: any[] } {
    const scope = this.buildScope;
    if (!scope) {
      // Without a resolved build scope these tools must not expose any rows.
      throw new Error('Database access is not scoped to a build; query rejected.');
    }

    switch (table) {
      case 'builds':
        return { column: 'uuid', value: scope.buildUuid };
      case 'deploys':
        return { column: 'buildId', value: scope.buildId };
      case 'deployables':
        return { column: 'buildId', value: scope.buildId };
      case 'pull_requests':
        if (scope.pullRequestId == null) {
          throw new Error('This build has no associated pull request; pull_requests is not queryable.');
        }
        return { column: 'id', value: scope.pullRequestId };
      case 'repositories':
        if (!scope.repositoryIds || scope.repositoryIds.length === 0) {
          throw new Error('This build has no associated repositories; repositories is not queryable.');
        }
        return { column: 'id', in: scope.repositoryIds };
      case 'environments':
        if (scope.environmentId == null) {
          throw new Error('This build has no associated environment; environments is not queryable.');
        }
        return { column: 'id', value: scope.environmentId };
      default:
        throw new Error(`Table '${table}' cannot be scoped to a build; query rejected.`);
    }
  }

  async queryTable(options: QueryOptions): Promise<QueryResult>;
  async queryTable(
    table: string,
    filters?: Record<string, any>,
    relations?: string[],
    limit?: number
  ): Promise<QueryResult>;
  async queryTable(
    tableOrOptions: string | QueryOptions,
    filters?: Record<string, any>,
    relations?: string[],
    limit?: number
  ): Promise<QueryResult> {
    const opts: QueryOptions =
      typeof tableOrOptions === 'string' ? { table: tableOrOptions, filters, relations, limit } : tableOrOptions;

    const allowedTables = ['builds', 'deploys', 'deployables', 'pull_requests', 'repositories', 'environments'];
    const tableMap: Record<string, string> = {
      builds: 'Build',
      deploys: 'Deploy',
      deployables: 'Deployable',
      pull_requests: 'PullRequest',
      repositories: 'Repository',
      environments: 'Environment',
    };

    if (!allowedTables.includes(opts.table)) {
      throw new Error(`Table '${opts.table}' not allowed. Allowed tables: ${allowedTables.join(', ')}`);
    }

    const modelName = tableMap[opts.table];
    const Model = this.db.models[modelName];

    if (!Model) {
      throw new Error(`Model '${modelName}' not found`);
    }

    const schema = this.getTableSchema(opts.table);

    let query = Model.query();
    let countQuery = Model.query();

    // SECURITY: build scope applied first and ANDed with all model filters, which can only narrow within it.
    const scopeClause = this.buildScopeClause(opts.table);
    if (scopeClause.in !== undefined) {
      query = query.whereIn(scopeClause.column, scopeClause.in);
      countQuery = countQuery.whereIn(scopeClause.column, scopeClause.in);
    } else {
      query = query.where(scopeClause.column, scopeClause.value);
      countQuery = countQuery.where(scopeClause.column, scopeClause.value);
    }

    if (opts.filters) {
      const validFilters: Record<string, any> = {};
      const likeFilters: Array<{ column: string; pattern: string }> = [];
      const invalidKeys: string[] = [];
      for (const [key, value] of Object.entries(opts.filters)) {
        const column = this.normalizeColumnName(schema, key);
        if (schema.columns.includes(column)) {
          if (typeof value === 'string' && (value.includes('%') || value.includes('_'))) {
            // SECURITY: reject wildcard-only / empty LIKE patterns that would match every row.
            const literal = value.replace(/[%_]/g, '').trim();
            if (literal.length === 0) {
              throw new Error(
                `Filter for '${key}' is a wildcard-only pattern ("${value}") which would match all rows. Provide a specific value.`
              );
            }
            likeFilters.push({ column, pattern: value });
          } else {
            validFilters[column] = value;
          }
        } else {
          invalidKeys.push(key);
        }
      }
      if (Object.keys(validFilters).length > 0) {
        query = query.where(validFilters);
        countQuery = countQuery.where(validFilters);
      }
      for (const { column, pattern } of likeFilters) {
        query = query.where(column, 'like', pattern);
        countQuery = countQuery.where(column, 'like', pattern);
      }
      if (invalidKeys.length > 0) {
        throw new Error(
          `Invalid filter columns: ${invalidKeys.join(', ')}. Valid columns for ${opts.table}: ${schema.columns.join(
            ', '
          )}`
        );
      }
    }

    const topLevelRelations = opts.relations ? [...new Set(opts.relations.map((r: string) => r.split('.')[0]))] : [];
    const invalidRelations = topLevelRelations.filter((relation) => !schema.relations[relation]);
    if (invalidRelations.length > 0) {
      throw new Error(
        `Invalid relations: ${invalidRelations.join(', ')}. Valid relations for ${opts.table}: ${Object.keys(
          schema.relations
        ).join(', ')}`
      );
    }

    const totalCount = await countQuery.resultSize();

    const warnings: string[] = [];
    if (opts.select && opts.select.length > 0) {
      const unknownSelectColumns = opts.select.filter(
        (col: string) => !schema.columns.includes(this.normalizeColumnName(schema, col))
      );
      if (unknownSelectColumns.length > 0) {
        warnings.push(
          `Ignored unknown select columns: ${unknownSelectColumns.join(', ')}. Valid columns for ${
            opts.table
          }: ${schema.columns.join(', ')}`
        );
      }
      const validColumns = opts.select
        .map((col: string) => this.normalizeColumnName(schema, col))
        .filter(
          (col: string, index: number, columns: string[]) =>
            schema.columns.includes(col) && columns.indexOf(col) === index
        );
      if (validColumns.length > 0) {
        query = query.select(validColumns);
      }
    }

    if (opts.orderBy) {
      const [column, direction = 'asc'] = opts.orderBy.split(':');
      const normalizedColumn = this.normalizeColumnName(schema, column);
      if (schema.columns.includes(normalizedColumn)) {
        query = query.orderBy(normalizedColumn, direction === 'desc' ? 'desc' : 'asc');
      }
    }

    if (topLevelRelations.length > 0) {
      const relationsString = `[${topLevelRelations.join(', ')}]`;
      query = query.withGraphFetched(relationsString);
    }

    const maxLimit = 100;
    const actualLimit = Math.min(opts.limit || 20, maxLimit);
    query = query.limit(actualLimit);

    if (opts.offset) {
      query = query.offset(opts.offset);
    }

    const records = await query;

    const compactedRecords =
      topLevelRelations.length > 0
        ? records.map((record: any) => this.compactRelations(record, topLevelRelations))
        : records;

    return { records: compactedRecords, totalCount, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  private compactRelations(record: any, relationNames: string[]): any {
    const result = { ...record };
    for (const rel of relationNames) {
      if (result[rel] == null) continue;
      if (Array.isArray(result[rel])) {
        result[rel] = result[rel].map((r: any) => this.compactRelationObject(r));
      } else if (typeof result[rel] === 'object') {
        result[rel] = this.compactRelationObject(result[rel]);
      }
    }
    return result;
  }

  private compactRelationObject(obj: any): any {
    return {
      id: obj.id || obj.uuid,
      name: obj.name || obj.status,
    };
  }

  private normalizeColumnName(schema: TableSchema, column: string): string {
    return schema.columnAliases?.[column] ?? column;
  }

  getTableSchema(table: string): TableSchema {
    const schemas: Record<string, TableSchema> = {
      builds: {
        primaryKey: 'uuid',
        columns: [
          'id',
          'uuid',
          'status',
          'statusMessage',
          'manifest',
          'environmentId',
          'pullRequestId',
          'buildRequestId',
          'sha',
          'runUUID',
          'capacityType',
          'kind',
          'namespace',
          'createdAt',
          'updatedAt',
        ],
        columnAliases: {
          created_at: 'createdAt',
          updated_at: 'updatedAt',
          pull_request_id: 'pullRequestId',
          build_request_id: 'buildRequestId',
          run_uuid: 'runUUID',
        },
        relations: {
          pullRequest: 'belongs to PullRequest',
          environment: 'belongs to Environment',
          deploys: 'has many Deploys',
          deployables: 'has many Deployables',
        },
      },
      deploys: {
        primaryKey: 'uuid',
        columns: [
          'uuid',
          'status',
          'statusMessage',
          'dockerImage',
          'buildPipelineId',
          'deployPipelineId',
          'branch',
          'repoName',
          'buildNumber',
          'buildId',
          'deployableId',
          'createdAt',
          'updatedAt',
        ],
        relations: {
          build: 'belongs to Build',
          deployable: 'belongs to Deployable',
          repository: 'belongs to Repository',
        },
      },
      deployables: {
        primaryKey: 'id',
        columns: ['id', 'name', 'type', 'repositoryId', 'defaultBranchName', 'createdAt', 'updatedAt'],
        relations: {
          repository: 'belongs to Repository',
          deploys: 'has many Deploys',
        },
      },
      pull_requests: {
        primaryKey: 'id',
        columns: [
          'id',
          'githubPullRequestId',
          'repositoryId',
          'pullRequestNumber',
          'title',
          'status',
          'deployOnUpdate',
          'branchName',
          'fullName',
          'githubLogin',
          'commentId',
          'consoleId',
          'statusCommentId',
          'latestCommit',
          'createdAt',
          'updatedAt',
        ],
        columnAliases: {
          number: 'pullRequestNumber',
          pull_request_number: 'pullRequestNumber',
          github_pull_request_id: 'githubPullRequestId',
          repository_id: 'repositoryId',
          branch_name: 'branchName',
          full_name: 'fullName',
          github_login: 'githubLogin',
          comment_id: 'commentId',
          console_id: 'consoleId',
          status_comment_id: 'statusCommentId',
          latest_commit: 'latestCommit',
          created_at: 'createdAt',
          updated_at: 'updatedAt',
        },
        relations: {
          repository: 'belongs to Repository',
          build: 'has one Build',
        },
      },
      repositories: {
        primaryKey: 'id',
        columns: ['id', 'name', 'url', 'githubRepositoryId', 'createdAt', 'updatedAt'],
        relations: {
          pullRequests: 'has many PullRequests',
          deployables: 'has many Deployables',
        },
      },
      environments: {
        primaryKey: 'id',
        columns: ['id', 'name', 'config', 'createdAt', 'updatedAt'],
        relations: {
          builds: 'has many Builds',
        },
      },
    };

    return schemas[table] || { columns: [], relations: {} };
  }
}
