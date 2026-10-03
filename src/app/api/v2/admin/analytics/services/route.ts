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
  parseManagedServiceRecordsQuery,
} from 'server/services/analytics/EnvironmentAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/services:
 *   get:
 *     summary: Get current managed Services
 *     description: Administrator-only paginated configured Services and current instance counts. Historical date controls are ignored. External and build-only units are excluded.
 *     tags: [Admin Analytics]
 *     operationId: getManagedServiceRecords
 *     parameters:
 *       - { in: query, name: repositoryId, schema: { type: integer, minimum: 1 }, description: Owning environment repository row ID, with installation identity. }
 *       - { in: query, name: unattributed, schema: { type: boolean, default: false }, description: Mutually exclusive with repositoryId. Unresolved identities remain separate by environment. }
 *       - { in: query, name: organization, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: environmentType, schema: { type: string, enum: [all, ephemeral, static], default: all } }
 *       - { in: query, name: environmentAuthor, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: type, schema: { type: string, enum: [docker, github, helm, aurora-restore] } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, maximum: 1000000, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }
 *     responses:
 *       '200':
 *         description: Current managed Service records.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GetManagedServiceRecordsSuccessResponse' }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
const getHandler = async (req: NextRequest) => {
  const query = parseManagedServiceRecordsQuery(req.nextUrl.searchParams);
  const result = await new EnvironmentAnalyticsService().getServices(query);
  return withNoStore(successResponse(result, { status: 200 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
