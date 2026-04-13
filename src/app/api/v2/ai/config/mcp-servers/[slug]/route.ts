/**
 * Copyright 2025 GoodRx, Inc.
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
import { successResponse } from 'server/lib/response';
import { McpConfigService, redactSharedConfigSecrets } from 'server/services/ai/mcp/config';
import 'server/lib/dependencies';

/**
 * @openapi
 * /api/v2/ai/config/mcp-servers/{slug}:
 *   get:
 *     summary: Get an MCP server config by slug
 *     description: >
 *       Returns a single shared MCP definition for the requested
 *       scope. Shared secrets are redacted in the response.
 *     tags:
 *       - MCP Server Config
 *     operationId: getMcpServerConfig
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: The MCP server config slug
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: Scope to look up the config in (e.g. "global" or a repository full name).
 *     responses:
 *       '200':
 *         description: MCP server configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetMcpServerConfigSuccessResponse'
 *       '404':
 *         description: MCP server config not found for the given slug and scope
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const service = new McpConfigService();
  const config = await service.getBySlugAndScope(slug, scope);

  if (!config) {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: `MCP server config '${slug}' not found` },
      },
      { status: 404 }
    );
  }

  const result = redactSharedConfigSecrets(config.toJSON ? config.toJSON() : config);
  return successResponse(result, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/config/mcp-servers/{slug}:
 *   put:
 *     summary: Update an MCP server config
 *     description: >
 *       Updates an existing shared MCP definition. If the transport,
 *       shared runtime config, auth mode, or preset changes, shared discovery
 *       is revalidated when possible. MCPs that depend on per-user auth
 *       can still be updated without shared credentials.
 *     tags:
 *       - MCP Server Config
 *     operationId: updateMcpServerConfig
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: The MCP server config slug
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: Scope to look up the config in (e.g. "global" or a repository full name).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateMcpServerConfigRequest'
 *     responses:
 *       '200':
 *         description: Updated MCP server configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetMcpServerConfigSuccessResponse'
 *       '404':
 *         description: MCP server config not found for the given slug and scope
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '422':
 *         description: Shared MCP discovery validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const putHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const body = await req.json();
  const service = new McpConfigService();

  try {
    const config = await service.update(slug, scope, body);
    const result = redactSharedConfigSecrets(config.toJSON ? config.toJSON() : config);
    return successResponse(result, { status: 200 }, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 404 }
      );
    }
    if (message.includes('connectivity validation failed')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 422 }
      );
    }
    throw error;
  }
};

/**
 * @openapi
 * /api/v2/ai/config/mcp-servers/{slug}:
 *   delete:
 *     summary: Delete an MCP server config
 *     description: Soft-deletes an MCP server configuration by slug and scope.
 *     tags:
 *       - MCP Server Config
 *     operationId: deleteMcpServerConfig
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: The MCP server config slug
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: Scope to look up the config in (e.g. "global" or a repository full name).
 *     responses:
 *       '204':
 *         description: MCP server config deleted (no response body)
 *       '404':
 *         description: MCP server config not found for the given slug and scope
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const deleteHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const service = new McpConfigService();

  try {
    await service.delete(slug, scope);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 404 }
      );
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
export const DELETE = createApiHandler(deleteHandler);
