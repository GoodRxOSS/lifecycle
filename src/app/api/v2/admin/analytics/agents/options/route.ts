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
import AgentAnalyticsService from 'server/services/analytics/AgentAnalyticsService';

/**
 * @openapi
 * /api/v2/admin/analytics/agents/options:
 *   get:
 *     summary: List bounded recorded repository, session owner, and model filter options
 *     operationId: getAgentAnalyticsOptions
 *     tags: [Admin Analytics]
 *     responses:
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '200':
 *         description: Recorded-name options with independent truncation flags.
 *         content:
 *           application/json:
 *             schema: {$ref: '#/components/schemas/GetAgentAnalyticsOptionsSuccessResponse'}
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
    return withNoStore(successResponse(await new AgentAnalyticsService().getOptions(), { status: 200 }, req));
  },
  { auth: 'session', roles: ['admin'] }
);
