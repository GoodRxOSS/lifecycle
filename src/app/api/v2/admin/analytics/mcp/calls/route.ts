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
import McpAnalyticsService, { parseMcpCallsQuery } from 'server/services/analytics/McpAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/mcp/calls:
 *   get:
 *     summary: List the MCP tool calls behind a summary number
 *     description: Administrator-only list of recorded MCP tool calls. The rows come from the same facts as the summary, cut by the slice parameters, so the total matches the summary count for that slice. Tool arguments are never recorded.
 *     tags: [Admin Analytics]
 *     operationId: getMcpAnalyticsCalls
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive local calendar date. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive local calendar date. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone. }
 *       - { in: query, name: compare, schema: { type: boolean, default: true }, description: Required for period=previous. }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day } }
 *       - { in: query, name: tool, schema: { type: string, maxLength: 128 }, description: Exact tool name. }
 *       - { in: query, name: userId, schema: { type: string, maxLength: 255 }, description: 'Exact user ID, or unknown for calls without one.' }
 *       - { in: query, name: client, schema: { type: string, maxLength: 255 }, description: 'Client application name as the summary shows it, including Unregistered client and Unknown client.' }
 *       - { in: query, name: outcome, schema: { type: string, maxLength: 64 }, description: 'succeeded, error, or one recorded error code.' }
 *       - { in: query, name: date, schema: { type: string, format: date }, description: Start date of one chart bucket. With period=previous it addresses the previous bucket shown at that date. }
 *       - { in: query, name: period, schema: { type: string, enum: [current, previous], default: current } }
 *       - { in: query, name: sort, schema: { type: string, default: 'createdAt:desc' }, description: 'One of createdAt, durationMs, with an optional :asc or :desc.' }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, maximum: 10000, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }
 *     responses:
 *       '200':
 *         description: MCP tool call records.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetMcpAnalyticsCallsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
export const GET = createApiHandler(
  async (req: NextRequest) => {
    const result = await new McpAnalyticsService().getCalls(parseMcpCallsQuery(req.nextUrl.searchParams));
    return withNoStore(successResponse(result, { status: 200 }, req));
  },
  { auth: 'session', roles: ['admin'] }
);
