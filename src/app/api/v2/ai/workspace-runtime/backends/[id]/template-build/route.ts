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
import { startWorkspaceTemplateBuild } from 'server/services/workspaceRuntime/templateBuild';

type RouteContext = {
  params: Promise<{
    id?: string;
  }>;
};

/**
 * @openapi
 * /api/v2/ai/workspace-runtime/backends/{id}/template-build:
 *   post:
 *     summary: Build the workspace template for a backend
 *     description: Enqueues a managed template build on the provider's builder (E2B only). Returns the queued build state; poll the build by id. If a build is already running, its state is returned instead of starting another.
 *     tags:
 *       - Agent Admin
 *     operationId: buildWorkspaceRuntimeTemplate
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               templateName:
 *                 type: string
 *                 description: Template name/alias to build. Defaults to lifecycle-workspace.
 *               cpuCount:
 *                 type: integer
 *                 description: vCPUs baked into the template (1-8). Defaults to 2.
 *               memoryMB:
 *                 type: integer
 *                 description: Memory in MB baked into the template (512-8192). Defaults to 4096.
 *     responses:
 *       '202':
 *         description: Build queued (or already running); poll the returned buildId.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WorkspaceTemplateBuildStateResponse'
 *       '400':
 *         description: Backend does not support managed template builds, missing API key, or invalid inputs
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
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const state = await startWorkspaceTemplateBuild((id || '').trim(), {
    templateName: body.templateName,
    cpuCount: body.cpuCount,
    memoryMB: body.memoryMB,
  });
  return successResponse(state, { status: 202 }, req);
};

// Admin only: spends provider build minutes with stored credentials.
export const POST = createApiHandler(postHandler, { roles: ['admin'] });
