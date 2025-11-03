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

export class DatabaseClient {
  constructor(private db: any) {}

  async queryTable(table: string, filters?: Record<string, any>, relations?: string[], limit?: number): Promise<any> {
    const allowedTables = ['builds', 'deploys', 'deployables', 'pull_requests', 'repositories', 'environments'];
    const tableMap: Record<string, string> = {
      builds: 'Build',
      deploys: 'Deploy',
      deployables: 'Deployable',
      pull_requests: 'PullRequest',
      repositories: 'Repository',
      environments: 'Environment',
    };

    if (!allowedTables.includes(table)) {
      throw new Error(`Table '${table}' not allowed. Allowed tables: ${allowedTables.join(', ')}`);
    }

    const modelName = tableMap[table];
    const Model = this.db.models[modelName];

    if (!Model) {
      throw new Error(`Model '${modelName}' not found`);
    }

    let query = Model.query();

    if (filters) {
      query = query.where(filters);
    }

    if (relations && relations.length > 0) {
      const relationsString = `[${relations.join(', ')}]`;
      query = query.withGraphFetched(relationsString);
    }

    const maxLimit = 100;
    const actualLimit = Math.min(limit || 10, maxLimit);
    query = query.limit(actualLimit);

    return await query;
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
