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
import DeploymentAnalyticsService, {
  parseDeploymentRequestsQuery,
} from 'server/services/analytics/DeploymentAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/deployments/requests:
 *   get:
 *     summary: List the deploy requests behind a summary number
 *     description: Administrator-only list of recorded deploy requests. The rows come from the same facts as the summary, cut by the slice parameters, so the total matches the summary count for that slice.
 *     tags: [Admin Analytics]
 *     operationId: getDeploymentAnalyticsRequests
 *     parameters:
 *       - { in: query, name: repositoryId, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: unattributed, schema: { type: boolean, default: false }, description: Mutually exclusive with repositoryId. }
 *       - { in: query, name: organization, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: environmentType, schema: { type: string, enum: [all, ephemeral, static], default: all } }
 *       - { in: query, name: environmentAuthor, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive local calendar date. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive local calendar date. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone. }
 *       - { in: query, name: compare, schema: { type: boolean, default: true }, description: Required for period=previous. }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day } }
 *       - { in: query, name: outcome, schema: { type: string }, description: 'Comma-separated list of succeeded, failed, superseded, blocked, torn_down, unresolved. Empty means every outcome.' }
 *       - { in: query, name: origin, schema: { type: string, enum: [push, label, pr_open, config_push, api, redeploy, mcp, comment, agent, unknown] } }
 *       - { in: query, name: reason, schema: { type: string, maxLength: 300 }, description: A grouped failure reason from the summary. Selects failed requests only. }
 *       - { in: query, name: date, schema: { type: string, format: date }, description: Start date of one chart bucket. With period=previous it addresses the previous bucket shown at that date. }
 *       - { in: query, name: period, schema: { type: string, enum: [current, previous], default: current } }
 *       - { in: query, name: sort, schema: { type: string, default: 'requestedAt:desc' }, description: 'One of requestedAt, timeToReady, queueWait, with an optional :asc or :desc.' }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, maximum: 10000, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }
 *     responses:
 *       '200':
 *         description: Deploy request records.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetDeploymentAnalyticsRequestsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
export const GET = createApiHandler(
  async (req: NextRequest) => {
    const result = await new DeploymentAnalyticsService().getRequests(
      parseDeploymentRequestsQuery(req.nextUrl.searchParams)
    );
    return withNoStore(successResponse(result, { status: 200 }, req));
  },
  { auth: 'session', roles: ['admin'] }
);
