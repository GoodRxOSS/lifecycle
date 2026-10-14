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
import McpAnalyticsService, { parseMcpAnalyticsQuery } from 'server/services/analytics/McpAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/mcp:
 *   get:
 *     summary: Summarize MCP tool usage
 *     description: Administrator-only aggregation over recorded MCP tool calls by tool, user and client application.
 *     tags: [Admin Analytics]
 *     operationId: getMcpAnalytics
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive local calendar date. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive local calendar date. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone. }
 *       - { in: query, name: compare, schema: { type: boolean, default: true } }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day } }
 *     responses:
 *       '200':
 *         description: MCP usage analytics.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetMcpAnalyticsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
export const GET = createApiHandler(
  async (req: NextRequest) => {
    const result = await new McpAnalyticsService().getSummary(parseMcpAnalyticsQuery(req.nextUrl.searchParams));
    return withNoStore(successResponse(result, { status: 200 }, req));
  },
  { auth: 'session', roles: ['admin'] }
);
