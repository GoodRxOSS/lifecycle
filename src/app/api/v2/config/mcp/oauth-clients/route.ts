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
import McpOauthClientService from 'server/services/keycloak/mcpOauthClients';

/**
 * @openapi
 * /api/v2/config/mcp/oauth-clients:
 *   get:
 *     summary: List pre-registered Lifecycle MCP OAuth clients
 *     description: Returns public OAuth clients created and managed by Lifecycle for MCP sign-in.
 *     tags:
 *       - Config
 *     operationId: listLifecycleMcpOauthClients
 *     responses:
 *       '200':
 *         description: Lifecycle-managed MCP OAuth clients.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListLifecycleMcpOauthClientsSuccessResponse'
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
 *       '503':
 *         description: Keycloak client management is unavailable.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Pre-register a Lifecycle MCP OAuth client
 *     description: Creates a public Authorization Code client with PKCE, consent, and fixed Lifecycle MCP scopes.
 *     tags:
 *       - Config
 *     operationId: createLifecycleMcpOauthClient
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateLifecycleMcpOauthClient'
 *     responses:
 *       '201':
 *         description: MCP OAuth client created.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LifecycleMcpOauthClientSuccessResponse'
 *       '400':
 *         description: Invalid client name or redirect URI.
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
 *         description: The client conflicts with existing state or the client limit was reached.
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
const getHandler = async (req: NextRequest) => {
  const clients = await McpOauthClientService.getInstance().list();
  return successResponse(clients, { status: 200 }, req);
};

const postHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }
  const identity = requireRequestUserIdentity(req);
  const client = await McpOauthClientService.getInstance().create(
    body,
    identity.userId,
    req.headers.get('x-request-id')
  );
  return successResponse(client, { status: 201 }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
export const POST = createApiHandler(postHandler, { auth: 'session', roles: ['admin'] });
