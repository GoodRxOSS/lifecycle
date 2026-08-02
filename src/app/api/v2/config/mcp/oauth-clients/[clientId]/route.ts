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

import { NextRequest, NextResponse } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { requireRequestUserIdentity } from 'server/lib/get-user';
import McpOauthClientService from 'server/services/keycloak/mcpOauthClients';

/**
 * @openapi
 * /api/v2/config/mcp/oauth-clients/{clientId}:
 *   delete:
 *     summary: Delete a pre-registered Lifecycle MCP OAuth client
 *     description: Deletes only a public OAuth client that is marked as managed by Lifecycle MCP.
 *     tags:
 *       - Config
 *     operationId: deleteLifecycleMcpOauthClient
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *         description: Lifecycle-generated OAuth client ID.
 *     responses:
 *       '204':
 *         description: MCP OAuth client deleted.
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
 *       '404':
 *         description: Lifecycle-managed MCP OAuth client not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '503':
 *         description: Keycloak client management is unavailable.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const deleteHandler = async (req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) => {
  const { clientId } = await params;
  const identity = requireRequestUserIdentity(req);
  await McpOauthClientService.getInstance().delete(clientId, identity.userId, req.headers.get('x-request-id'));
  return new NextResponse(null, { status: 204 });
};

export const DELETE = createApiHandler(deleteHandler, { auth: 'session', roles: ['admin'] });
