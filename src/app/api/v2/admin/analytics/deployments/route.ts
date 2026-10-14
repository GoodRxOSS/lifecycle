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
  parseDeploymentAnalyticsQuery,
} from 'server/services/analytics/DeploymentAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/deployments:
 *   get:
 *     summary: Summarize deploy requests, outcomes and timing
 *     description: Administrator-only aggregation over recorded deploy requests. Each request resolves to succeeded, failed, superseded, not run, torn down or unresolved from the events its own run recorded.
 *     tags: [Admin Analytics]
 *     operationId: getDeploymentAnalytics
 *     parameters:
 *       - { in: query, name: repositoryId, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: unattributed, schema: { type: boolean, default: false }, description: Mutually exclusive with repositoryId. }
 *       - { in: query, name: organization, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: environmentType, schema: { type: string, enum: [all, ephemeral, static], default: all } }
 *       - { in: query, name: environmentAuthor, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive local calendar date. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive local calendar date. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone. }
 *       - { in: query, name: compare, schema: { type: boolean, default: true } }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day } }
 *     responses:
 *       '200':
 *         description: Deploy request analytics.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetDeploymentAnalyticsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
export const GET = createApiHandler(
  async (req: NextRequest) => {
    const result = await new DeploymentAnalyticsService().getSummary(
      parseDeploymentAnalyticsQuery(req.nextUrl.searchParams)
    );
    return withNoStore(successResponse(result, { status: 200 }, req));
  },
  { auth: 'session', roles: ['admin'] }
);
