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

import { BaseTool } from '../baseTool';
import { ToolResult, ToolSafetyLevel } from '../../types/tool';
import { DatabaseClient } from '../shared/databaseClient';

export class QueryDatabaseTool extends BaseTool {
  static readonly Name = 'query_database';

  constructor(private databaseClient: DatabaseClient) {
    super(
      'Read-only database query to fetch fresh Lifecycle data. Use this to get current build/deploy status, check deployables, or verify configuration. CRITICAL: READ-ONLY - no write operations allowed. TABLE-SPECIFIC RELATIONS: builds (pullRequest, environment, deploys, deployables), deploys (build, deployable, repository, service), deployables (repository, deploys), pull_requests (repository, builds), repositories (pullRequests, deployables), environments (builds). Use dot notation for nested relations like "deploys.repository".',
      {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description:
              'Table name: "builds" (environments), "deploys" (service deployments), "deployables" (service definitions), "pull_requests", "repositories", "environments"',
          },
          filters: {
            type: 'object',
            description:
              'WHERE conditions as key-value pairs. Example: {"uuid": "abc123", "status": "ERROR"}. Use "uuid" for builds/deploys, "id" for others.',
          },
          relations: {
            type: 'array',
            description:
              'Relations to eager load. IMPORTANT: Only use relations valid for the table - builds: [pullRequest, environment, deploys, deployables], deploys: [build, deployable, repository, service], deployables: [repository, deploys], pull_requests: [repository, builds], repositories: [pullRequests, deployables], environments: [builds]. Use dot notation for nested: "deploys.repository"',
            items: { type: 'string' },
          },
          limit: {
            type: 'number',
            description: 'Maximum number of records to return (default: 10, max: 100)',
          },
        },
        required: ['table'],
      },
      ToolSafetyLevel.SAFE,
      'database'
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED', false);
    }

    try {
      const table = args.table as string;
      const filters = args.filters as Record<string, any> | undefined;
      const relations = args.relations as string[] | undefined;
      const limit = args.limit as number | undefined;

      const results = await this.databaseClient.queryTable(table, filters, relations, limit);

      const schema = this.databaseClient.getTableSchema(table);

      const result = {
        success: true,
        table,
        count: Array.isArray(results) ? results.length : 0,
        records: results,
        schema,
      };

      return this.createSuccessResult(JSON.stringify(result));
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Database query failed', 'EXECUTION_ERROR');
    }
  }
}
