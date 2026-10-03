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
import AgentAnalyticsService, { parseAgentAnalyticsQuery } from 'server/services/analytics/AgentAnalyticsService';

/**
 * @openapi
 * /api/v2/admin/analytics/agents:
 *   get:
 *     summary: Summarize retained Agent activity and recorded model usage
 *     description: Submitted-run cohorts with current outcomes, cumulative usage, independent reported and estimated cost coverage, and first-recorded-run session attribution. Repository names do not carry GitHub installation identity.
 *     operationId: getAgentAnalytics
 *     tags: [Admin Analytics]
 *     parameters:
 *       - {in: query, name: from, schema: {type: string, format: date}, description: Inclusive local calendar date.}
 *       - {in: query, name: to, schema: {type: string, format: date}, description: Exclusive local calendar date.}
 *       - {in: query, name: timezone, schema: {type: string, default: UTC}, description: IANA timezone.}
 *       - {in: query, name: compare, schema: {type: boolean, default: true}}
 *       - {in: query, name: interval, schema: {type: string, enum: [day, week], default: day}}
 *       - {in: query, name: repository, schema: {type: string}, description: Exact recorded owner/repository name or unattributed.}
 *       - {in: query, name: organization, schema: {type: string}, description: Recorded repository owner grouping.}
 *       - {in: query, name: owner, schema: {type: string}, description: Exact session owner identity.}
 *       - {in: query, name: sessionKind, schema: {type: string, enum: [chat, environment, sandbox]}}
 *       - {in: query, name: agentId, schema: {type: string}}
 *       - {in: query, name: provider, schema: {type: string}}
 *       - {in: query, name: model, schema: {type: string}}
 *     responses:
 *       '200':
 *         description: Bounded aggregate data and coverage metadata.
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/GetAgentAnalyticsSuccessResponse'}
 *       '400':
 *         description: Invalid calendar range or scope.
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
    const result = await new AgentAnalyticsService().getSummary(parseAgentAnalyticsQuery(req.nextUrl.searchParams));
    return withNoStore(successResponse(result, { status: 200 }, req));
  },
  { auth: 'session', roles: ['admin'] }
);
