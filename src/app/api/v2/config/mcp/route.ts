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
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import McpConfigService from 'server/services/mcpConfig';

/**
 * @openapi
 * /api/v2/config/mcp:
 *   get:
 *     summary: Get Lifecycle MCP settings
 *     description: >
 *       Returns the two administrator settings, public endpoint, one actionable
 *       local configuration issue when needed, and the registry-backed capability catalog.
 *     tags:
 *       - Config
 *     operationId: getLifecycleMcpConfig
 *     responses:
 *       '200':
 *         description: Lifecycle MCP settings and capability catalog.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LifecycleMcpSettingsSuccessResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Update Lifecycle MCP settings
 *     description: >
 *       Strictly replaces enabled and allowChanges. Turning MCP on configures and
 *       verifies Lifecycle's fixed OAuth contract before persistence. Other updates
 *       are local.
 *     tags:
 *       - Config
 *     operationId: updateLifecycleMcpConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateLifecycleMcpSettings'
 *     responses:
 *       '200':
 *         description: Stored Lifecycle MCP settings after the update.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LifecycleMcpSettingsSuccessResponse'
 *       '400':
 *         description: Invalid strict replacement body.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: A required Lifecycle MCP configuration conflicts with existing state.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '503':
 *         description: Lifecycle could not complete MCP configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const settings = await McpConfigService.getInstance().getSettings();
  return successResponse(settings, { status: 200 }, req);
};

const putHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const identity = requireRequestUserIdentity(req);
  const settings = await McpConfigService.getInstance().setConfig(
    body,
    identity.userId,
    req.headers.get('x-request-id')
  );
  return successResponse(settings, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
export const PUT = createApiHandler(putHandler, { auth: 'session', roles: ['admin'] });
