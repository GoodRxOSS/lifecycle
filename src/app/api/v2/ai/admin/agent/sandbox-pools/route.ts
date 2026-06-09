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
import OpenSandboxPoolAdminService from 'server/services/agent/OpenSandboxPoolAdminService';

/**
 * @openapi
 * /api/v2/ai/admin/agent/sandbox-pools:
 *   get:
 *     summary: List OpenSandbox warm pools
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentSandboxPools
 *     parameters:
 *       - in: query
 *         name: namespace
 *         schema:
 *           type: string
 *           default: opensandbox
 *         description: Kubernetes namespace containing OpenSandbox Pool resources.
 *     responses:
 *       '200':
 *         description: OpenSandbox warm pools.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentSandboxPoolsSuccessResponse'
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
  const namespace = req.nextUrl.searchParams.get('namespace');
  const pools = await new OpenSandboxPoolAdminService().listPools(namespace);
  return successResponse({ pools }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
