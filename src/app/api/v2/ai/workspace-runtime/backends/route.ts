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
import { successResponse } from 'server/lib/response';
import { listBackends } from 'server/services/workspaceRuntime/catalog';

/**
 * @openapi
 * /api/v2/ai/workspace-runtime/backends:
 *   get:
 *     summary: List workspace runtime backends
 *     description: Catalog of workspace runtime backends with capabilities, configuration, and selection state.
 *     tags:
 *       - Agent Admin
 *     operationId: getWorkspaceRuntimeBackends
 *     responses:
 *       '200':
 *         description: Workspace runtime backend catalog.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetWorkspaceRuntimeBackendsSuccessResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const backends = await listBackends();
  return successResponse({ backends }, { status: 200 }, req);
};

// Admin only: the catalog exposes backend configuration state.
export const GET = createApiHandler(getHandler, { roles: ['admin'] });
