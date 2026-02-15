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
            enum: ['builds', 'deploys', 'deployables', 'pull_requests', 'repositories', 'environments'],
          },
          filters: {
            type: 'object',
            description:
              'WHERE conditions as key-value pairs. Deploy uuid format is "{serviceName}-{buildUuid}" (e.g., "vpii-events-broad-lab-080573"). Use SQL LIKE patterns with % for partial matching: {"uuid": "vpii-events-%"} finds all deploys for service vpii-events. Use "uuid" for builds/deploys, "id" for others. Only use actual table columns as keys. IMPORTANT: To find all deploys for a build, query the builds table with relations: ["deploys"], e.g., {"table": "builds", "filters": {"uuid": "my-build-uuid"}, "relations": ["deploys"]}. Do NOT filter deploys by buildId — it is a numeric FK, not the build UUID string.',
          },
          relations: {
            type: 'array',
            description:
              'Relations to eager load (top-level only). Valid per table - builds: [pullRequest, environment, deploys, deployables], deploys: [build, deployable, repository, service], deployables: [repository, deploys], pull_requests: [repository, builds], repositories: [pullRequests, deployables], environments: [builds]. Relations are returned as compact {id, name} objects.',
            items: { type: 'string' },
          },
          limit: {
            type: 'number',
            description: 'Maximum number of records to return (default: 20, max: 100)',
          },
          select: {
            type: 'array',
            items: { type: 'string' },
            description: 'Columns to return (default: all). Invalid column names are silently ignored.',
          },
          orderBy: {
            type: 'string',
            description: 'Column and direction, e.g., "created_at:desc". Default: primary key descending.',
          },
          offset: {
            type: 'number',
            description: 'Records to skip for pagination. Use with limit.',
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
      const select = args.select as string[] | undefined;
      const orderBy = args.orderBy as string | undefined;
      const offset = args.offset as number | undefined;

      const { records, totalCount } = await this.databaseClient.queryTable({
        table,
        filters,
        relations,
        limit,
        select,
        orderBy,
        offset,
      });

      const agentContent = {
        success: true,
        table,
        count: records.length,
        totalCount,
        records,
      };

      const displayContent = `Found ${records.length} ${table} (${totalCount} total)`;

      return this.createSuccessResult(JSON.stringify(agentContent), displayContent);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Database query failed', 'EXECUTION_ERROR');
    }
  }
}
