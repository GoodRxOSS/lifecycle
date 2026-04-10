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
import { errorResponse, successResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentAdminService from 'server/services/agent/AdminService';

/**
 * @openapi
 * /api/v2/ai/admin/agent/mcp-servers/{slug}/users:
 *   get:
 *     summary: List per-user MCP connection coverage for a shared MCP
 *     description: >
 *       Returns masked per-user connection coverage for the selected shared MCP
 *       definition and scope. This is intended for admin visibility
 *       only; it never returns secret values.
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentMcpServerUsers
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared MCP slug.
 *       - in: query
 *         name: scope
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared MCP scope (`global` or `owner/repo`).
 *     responses:
 *       '200':
 *         description: Masked per-user connection coverage rows
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentMcpServerUsersSuccessResponse'
 *       '400':
 *         description: Missing required query parameter
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
 *       '404':
 *         description: Shared MCP definition not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { slug: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const scope = req.nextUrl.searchParams.get('scope');
  if (!scope) {
    return errorResponse(new Error('Missing required query parameter: scope'), { status: 400 }, req);
  }

  try {
    const result = await AgentAdminService.listMcpServerUsers(params.slug, scope);
    return successResponse(result, { status: 200 }, req);
  } catch (error) {
    if (error instanceof Error && error.message === 'MCP server config not found') {
      return errorResponse(error, { status: 404 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
