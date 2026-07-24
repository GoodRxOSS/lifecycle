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
import { BadRequestError } from 'server/lib/appError';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse } from 'server/lib/response';
import OpenSandboxPoolAdminService, {
  parseOpenSandboxPoolCapacityPatch,
} from 'server/services/agent/OpenSandboxPoolAdminService';

type RouteContext = {
  params: Promise<{
    namespace?: string;
    name?: string;
  }>;
};

async function readParams(context: RouteContext): Promise<{ namespace: string; name: string }> {
  const params = await context.params;
  const namespace = params.namespace?.trim();
  const name = params.name?.trim();
  if (!namespace || !name) {
    throw new BadRequestError('OpenSandbox pool namespace and name are required.');
  }
  return { namespace, name };
}

/**
 * @openapi
 * /api/v2/ai/admin/agent/sandbox-pools/{namespace}/{name}:
 *   get:
 *     summary: Get an OpenSandbox warm pool
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentSandboxPool
 *     parameters:
 *       - in: path
 *         name: namespace
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: OpenSandbox warm pool.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentSandboxPoolSuccessResponse'
 *   patch:
 *     summary: Update OpenSandbox warm pool capacity
 *     tags:
 *       - Agent Admin
 *     operationId: updateAdminAgentSandboxPool
 *     parameters:
 *       - in: path
 *         name: namespace
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAdminAgentSandboxPoolRequest'
 *     responses:
 *       '200':
 *         description: Updated OpenSandbox warm pool.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentSandboxPoolSuccessResponse'
 *       '400':
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, context: RouteContext) => {
  const { namespace, name } = await readParams(context);
  const pool = await new OpenSandboxPoolAdminService().getPool(namespace, name);
  return successResponse({ pool }, { status: 200 }, req);
};

const patchHandler = async (req: NextRequest, context: RouteContext) => {
  const { namespace, name } = await readParams(context);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequestError('Invalid JSON in request body.');
  }

  const capacityPatch = parseOpenSandboxPoolCapacityPatch(body);
  const pool = await new OpenSandboxPoolAdminService().updateCapacity(namespace, name, capacityPatch);
  return successResponse({ pool }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
export const PATCH = createApiHandler(patchHandler, { auth: 'session', roles: ['admin'] });
