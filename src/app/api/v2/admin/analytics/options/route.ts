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
  parseEnvironmentAnalyticsScope,
} from 'server/services/analytics/EnvironmentAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/options:
 *   get:
 *     summary: Get bounded administrator analytics filter options
 *     description: Administrator-only installation-wide aggregation over retained records; no historical attempt tracking.
 *     tags: [Admin Analytics]
 *     operationId: getAnalyticsOptions
 *     parameters:
 *       - { in: query, name: repositoryId, schema: { type: integer, minimum: 1 }, description: Stable installation-aware repository row ID. }
 *       - { in: query, name: unattributed, schema: { type: boolean, default: false }, description: Mutually exclusive with repositoryId. }
 *       - { in: query, name: organization, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: environmentType, schema: { type: string, enum: [all, ephemeral, static], default: all } }
 *       - { in: query, name: environmentAuthor, schema: { type: string, maxLength: 128 }, description: Stored GitHub login; distinct from Agent Session owner. }


 *     responses:
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '200':
 *         description: Analytics result.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetAnalyticsOptionsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
const getHandler = async (req: NextRequest) => {
  const query = parseEnvironmentAnalyticsScope(req.nextUrl.searchParams);
  const result = await new EnvironmentAnalyticsService().getOptions(query);
  return withNoStore(successResponse(result, { status: 200 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
