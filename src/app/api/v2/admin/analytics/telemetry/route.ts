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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, withNoStore } from 'server/lib/response';
import TelemetryService, { parseTelemetryStatsQuery } from 'server/services/telemetry';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/telemetry:
 *   get:
 *     summary: Get telemetry statistics
 *     description: Returns aggregated telemetry statistics (usage over time, top events, active clients, versions, and platforms) for one source over a calendar window. Administrator-only.
 *     tags: [Admin Analytics]
 *     operationId: getTelemetryStats
 *     parameters:
 *       - name: source
 *         in: query
 *         required: true
 *         description: Which client type to aggregate.
 *         schema:
 *           type: string
 *           enum: [cli, ui]
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive local calendar date. Defaults to 30 complete days before to. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive local calendar date. Defaults to today in timezone. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone for boundaries and buckets. }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day } }
 *     responses:
 *       '200':
 *         description: Aggregated telemetry statistics.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetTelemetryStatsSuccessResponse'
 *       '400':
 *         description: Invalid query parameters.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
const getHandler = async (req: NextRequest) => {
  const query = parseTelemetryStatsQuery(req.nextUrl.searchParams);
  const result = await new TelemetryService().getStats(query);
  return withNoStore(successResponse(result, { status: 200 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
