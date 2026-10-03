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
import EnvironmentLifetimeAnalyticsService, {
  parseEnvironmentLifetimeRecordsQuery,
} from 'server/services/analytics/EnvironmentLifetimeAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/lifetimes/records:
 *   get:
 *     summary: Get paginated lifetime or current-age environment records
 *     description: Administrator-only retained-record analytics. API uses createdAt to deletedAt; torn-down PR estimates use createdAt to updatedAt and may include inactive gaps or later edits. Current age is independent of the retirement window.
 *     tags: [Admin Analytics]
 *     operationId: getEnvironmentLifetimeAnalyticsRecords
 *     parameters:
 *       - { in: query, name: repositoryId, schema: { type: integer, minimum: 1 }, description: Stable installation-aware repository row ID. }
 *       - { in: query, name: unattributed, schema: { type: boolean, default: false }, description: Mutually exclusive with repositoryId. }
 *       - { in: query, name: organization, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: environmentType, schema: { type: string, enum: [all, ephemeral, static], default: all } }
 *       - { in: query, name: environmentAuthor, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive retirement calendar date. Defaults to 30 complete days before to. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive retirement calendar date. Defaults to today in timezone. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone for boundaries and buckets. }
 *       - { in: query, name: compare, schema: { type: boolean, default: true } }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day } }
 *       - { in: query, name: cohort, schema: { type: string, enum: [completed, current], default: completed }, description: Current age ignores all calendar controls and returns range null. }
 *       - { in: query, name: group, schema: { type: string, enum: [all, api, pr, other], default: all }, description: Other is current age only. Completed all combines records without combining summary statistics. }
 *       - { in: query, name: bin, schema: { type: string, enum: [under_1h, 1_to_6h, 6_to_24h, 1_to_3d, 3_to_7d, 7_to_30d, 30d_plus, missing, invalid] }, description: Half-open duration hours or sample coverage bucket. Unplaced end dates are excluded from completed window records. }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, maximum: 10000, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }
 *     responses:
 *       '200':
 *         description: Lifetime analytics result.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetEnvironmentLifetimeAnalyticsRecordsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
const getHandler = async (req: NextRequest) => {
  const query = parseEnvironmentLifetimeRecordsQuery(req.nextUrl.searchParams);
  const result = await new EnvironmentLifetimeAnalyticsService().getRecords(query);
  return withNoStore(successResponse(result, { status: 200 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
