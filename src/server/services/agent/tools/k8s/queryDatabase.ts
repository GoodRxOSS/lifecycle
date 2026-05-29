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
import { ToolResult, ToolSafetyLevel } from '../types';
import { DatabaseClient } from '../shared/databaseClient';

export class QueryDatabaseTool extends BaseTool {
  static readonly Name = 'query_database';

  constructor(private databaseClient: DatabaseClient) {
    super(
      "Read-only database query to fetch fresh Lifecycle data for THIS build only. Every query is automatically scoped to this build's own records (builds.uuid = this build, deploys/deployables of this build, this build's pull request / environment / repositories); you cannot read other tenants' rows. Use this to get current build/deploy status, check deployables, or verify configuration. CRITICAL: READ-ONLY - no write operations allowed. TABLE-SPECIFIC RELATIONS: builds (pullRequest, environment, deploys, deployables), deploys (build, deployable, repository, service), deployables (repository, deploys), pull_requests (repository, build), repositories (pullRequests, deployables), environments (builds). Use dot notation for nested relations like \"deploys.repository\".",
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
              'WHERE conditions as key-value pairs. Deploy uuid format is "{serviceName}-{buildUuid}" (e.g., "sample-service-broad-lab-080573"). Use SQL LIKE patterns with % for partial matching: {"uuid": "sample-service-%"} finds all deploys for sample-service. Use "uuid" for builds/deploys, "pullRequestNumber" for PR numbers, and "pullRequestId" for the build-to-PR foreign key. Common aliases such as "number", "pull_request_id", and "created_at" are accepted. IMPORTANT: To find all deploys for a build, query the builds table with relations: ["deploys"], e.g., {"table": "builds", "filters": {"uuid": "my-build-uuid"}, "relations": ["deploys"]}. Do NOT filter deploys by buildId — it is a numeric FK, not the build UUID string.',
          },
          relations: {
            type: 'array',
            description:
              'Relations to eager load (top-level only). Valid per table - builds: [pullRequest, environment, deploys, deployables], deploys: [build, deployable, repository, service], deployables: [repository, deploys], pull_requests: [repository, build], repositories: [pullRequests, deployables], environments: [builds]. Relations are returned as compact {id, name} objects.',
            items: { type: 'string' },
          },
          limit: {
            type: 'number',
            description: 'Maximum number of records to return (default: 20, max: 100)',
          },
          select: {
            type: 'array',
            items: { type: 'string' },
            description: 'Columns to return (default: all). Use exact column names from the table schema.',
          },
          orderBy: {
            type: 'string',
            description:
              'Column and direction, e.g., "createdAt:desc". Common aliases such as "created_at:desc" are accepted.',
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

      const { records, totalCount, warnings } = await this.databaseClient.queryTable({
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
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
      };

      const displayContent = `Found ${records.length} ${table} (${totalCount} total)`;

      return this.createSuccessResult(JSON.stringify(agentContent), displayContent);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Database query failed', 'EXECUTION_ERROR');
    }
  }
}
