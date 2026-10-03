/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, withNoStore } from 'server/lib/response';
import AgentAnalyticsService, {
  parseAgentAnalyticsRunsQuery,
  parseAgentAnalyticsPagination,
} from 'server/services/analytics/AgentAnalyticsService';

/**
 * @openapi
 * /api/v2/admin/analytics/agents/runs:
 *   get:
 *     summary: Drill into retained submitted Agent runs without conversation content
 *     operationId: getAgentAnalyticsRuns
 *     tags: [Admin Analytics]
 *     parameters:
 *       - {in: query, name: from, schema: {type: string, format: date}}
 *       - {in: query, name: to, schema: {type: string, format: date}}
 *       - {in: query, name: timezone, schema: {type: string, default: UTC}}
 *       - {in: query, name: compare, schema: {type: boolean, default: true}}
 *       - {in: query, name: interval, schema: {type: string, enum: [day, week], default: day}}
 *       - {in: query, name: repository, schema: {type: string}, description: Exact recorded owner/repository name or unattributed.}
 *       - {in: query, name: organization, schema: {type: string}}
 *       - {in: query, name: owner, schema: {type: string}}
 *       - {in: query, name: sessionKind, schema: {type: string, enum: [chat, environment, sandbox]}}
 *       - {in: query, name: agentId, schema: {type: string}}
 *       - {in: query, name: provider, schema: {type: string}}
 *       - {in: query, name: model, schema: {type: string}}
 *       - {in: query, name: runStatus, schema: {type: string, enum: [queued, starting, running, waiting_for_approval, waiting_for_input, transitioned, completed, failed, cancelled, unknown]}}
 *       - {in: query, name: page, schema: {type: integer, minimum: 1, maximum: 10000, default: 1}}
 *       - {in: query, name: limit, schema: {type: integer, minimum: 1, maximum: 100, default: 25}}
 *     responses:
 *       '200':
 *         description: SQL-paginated run metadata and recorded usage.
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/GetAgentAnalyticsRunsSuccessResponse'}
 *       '400':
 *         description: Invalid range, scope, or pagination.
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/ApiErrorResponse'}
 *       '401':
 *         description: Authentication required.
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/ApiErrorResponse'}
 *       '403':
 *         description: Admin permission required.
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/ApiErrorResponse'}
 */
export const GET = createApiHandler(
  async (req: NextRequest) => {
    const { page, limit } = parseAgentAnalyticsPagination(req.nextUrl.searchParams);
    const result = await new AgentAnalyticsService().listRuns(
      parseAgentAnalyticsRunsQuery(req.nextUrl.searchParams),
      page,
      limit
    );
    return withNoStore(successResponse(result, { status: 200 }, req));
  },
  { auth: 'session', roles: ['admin'] }
);
