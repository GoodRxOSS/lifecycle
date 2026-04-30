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
}

export class DatabaseClient {
  constructor(private db: any) {}

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

    if (opts.filters) {
      const validFilters: Record<string, any> = {};
      const likeFilters: Array<{ column: string; pattern: string }> = [];
      const invalidKeys: string[] = [];
      for (const [key, value] of Object.entries(opts.filters)) {
        if (schema.columns.includes(key)) {
          if (typeof value === 'string' && (value.includes('%') || value.includes('_'))) {
            likeFilters.push({ column: key, pattern: value });
          } else {
            validFilters[key] = value;
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
      if (invalidKeys.length > 0 && Object.keys(validFilters).length === 0 && likeFilters.length === 0) {
        throw new Error(
          `Invalid filter columns: ${invalidKeys.join(', ')}. Valid columns for ${opts.table}: ${schema.columns.join(
            ', '
          )}`
        );
      }
    }

    const totalCount = await countQuery.resultSize();

    if (opts.select && opts.select.length > 0) {
      const validColumns = opts.select.filter((col: string) => schema.columns.includes(col));
      if (validColumns.length > 0) {
        query = query.select(validColumns);
      }
    }

    if (opts.orderBy) {
      const [column, direction = 'asc'] = opts.orderBy.split(':');
      if (schema.columns.includes(column)) {
        query = query.orderBy(column, direction === 'desc' ? 'desc' : 'asc');
      }
    }

    const topLevelRelations = opts.relations ? [...new Set(opts.relations.map((r: string) => r.split('.')[0]))] : [];

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

    return { records: compactedRecords, totalCount };
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

  getTableSchema(table: string): any {
    const schemas: Record<string, any> = {
      builds: {
        primaryKey: 'uuid',
        columns: ['uuid', 'status', 'statusMessage', 'namespace', 'sha', 'capacityType', 'createdAt', 'updatedAt'],
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
          service: 'belongs to Service',
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
          'number',
          'title',
          'status',
          'branchName',
          'fullName',
          'githubLogin',
          'commentId',
          'createdAt',
          'updatedAt',
        ],
        relations: {
          repository: 'belongs to Repository',
          builds: 'has many Builds',
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
