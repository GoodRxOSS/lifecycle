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
import { runWorkspaceBackendTestConnection } from 'server/services/workspaceRuntime/testConnection';

type RouteContext = {
  params: Promise<{
    id?: string;
  }>;
};

/**
 * @openapi
 * /api/v2/ai/workspace-runtime/backends/{id}/test-connection:
 *   post:
 *     summary: Test a workspace runtime backend connection
 *     description: Probes the backend with the merged stored and environment configuration. Never echoes credentials.
 *     tags:
 *       - Agent Admin
 *     operationId: testWorkspaceRuntimeBackend
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Connection test result.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TestWorkspaceRuntimeBackendSuccessResponse'
 *       '400':
 *         description: Backend is not testable (coming soon, unsupported, or unsafe configured endpoint)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
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
 *       '404':
 *         description: Unknown backend
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const postHandler = async (req: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const result = await runWorkspaceBackendTestConnection((id || '').trim());
  return successResponse(result, { status: 200 }, req);
};

// Admin only: probes outbound connectivity with stored credentials.
export const POST = createApiHandler(postHandler, { auth: 'session', roles: ['admin'] });
