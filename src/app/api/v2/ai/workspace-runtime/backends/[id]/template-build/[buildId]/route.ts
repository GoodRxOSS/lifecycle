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
import { getWorkspaceTemplateBuild } from 'server/services/workspaceRuntime/templateBuild';

type RouteContext = {
  params: Promise<{
    id?: string;
    buildId?: string;
  }>;
};

/**
 * @openapi
 * /api/v2/ai/workspace-runtime/backends/{id}/template-build/{buildId}:
 *   get:
 *     summary: Get workspace template build progress
 *     description: Returns the state of a managed template build, including stage and streamed build logs. State expires one hour after the last update.
 *     tags:
 *       - Agent Admin
 *     operationId: getWorkspaceRuntimeTemplateBuild
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: buildId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Current build state.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WorkspaceTemplateBuildStateResponse'
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
 *         description: Unknown backend or build not found/expired
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, context: RouteContext) => {
  const { id, buildId } = await context.params;
  const state = await getWorkspaceTemplateBuild((id || '').trim(), (buildId || '').trim());
  return successResponse(state, { status: 200 }, req);
};

// Admin only: mirrors the template-build trigger's access.
export const GET = createApiHandler(getHandler, { roles: ['admin'] });
