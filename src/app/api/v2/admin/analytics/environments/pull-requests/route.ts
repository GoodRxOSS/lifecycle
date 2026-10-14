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
import EnvironmentAnalyticsService, {
  parseEnvironmentAnalyticsPullRequestsQuery,
} from 'server/services/analytics/EnvironmentAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/environments/pull-requests:
 *   get:
 *     summary: Get paginated pull requests first recorded in the window
 *     description: Administrator-only list of the pull requests behind the PRs recorded and PRs deployed counts. Static environments have no pull requests.
 *     tags: [Admin Analytics]
 *     operationId: getEnvironmentAnalyticsPullRequests
 *     parameters:
 *       - { in: query, name: repositoryId, schema: { type: integer, minimum: 1 }, description: Stable installation-aware repository row ID. }
 *       - { in: query, name: unattributed, schema: { type: boolean, default: false }, description: Mutually exclusive with repositoryId. }
 *       - { in: query, name: organization, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: environmentType, schema: { type: string, enum: [all, ephemeral], default: all }, description: Static environments are not tied to pull requests. }
 *       - { in: query, name: environmentAuthor, schema: { type: string, maxLength: 128 }, description: Stored GitHub login of the pull request author. }
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive local calendar date. Defaults to 30 complete days before to. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive local calendar date. Defaults to today in timezone. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone for boundaries and buckets. }
 *       - { in: query, name: compare, schema: { type: boolean, default: true } }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day } }
 *       - { in: query, name: evidence, schema: { type: string, enum: [requested, rolled_out] }, description: Lists the pull requests behind the deploy requested or deployed count. }
 *       - { in: query, name: date, schema: { type: string, format: date }, description: Start date of one chart bucket. }
 *       - { in: query, name: period, schema: { type: string, enum: [current, previous], default: current }, description: Lists the comparison window when previous. }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, maximum: 1000000, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }
 *     responses:
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '200':
 *         description: Analytics result.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetEnvironmentAnalyticsPullRequestsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
const getHandler = async (req: NextRequest) => {
  const query = parseEnvironmentAnalyticsPullRequestsQuery(req.nextUrl.searchParams);
  const result = await new EnvironmentAnalyticsService().getPullRequests(query);
  return withNoStore(successResponse(result, { status: 200 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
