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
 * /api/v2/ai/config/mcp-servers:
 *   get:
 *     summary: List MCP server configs
 *     description: >
 *       Returns all shared MCP definitions for the given scope. Shared
 *       secrets are redacted in responses. Each MCP includes its transport,
 *       shared runtime config, auth mode, optional preset key, and shared
 *       discovery results for MCPs that do not depend on per-user auth.
 *       Use scope "global" (default) for org-wide MCPs or pass a
 *       repository full name (e.g. "example-org/example-repo") for repo-scoped
 *       MCPs.
 *     tags:
 *       - MCP Server Config
 *     operationId: listMcpServerConfigs
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: >
 *           Scope to filter by. Use "global" for org-wide configs or a repository
 *           full name (e.g. "example-org/example-repo") for repo-scoped configs.
 *         example: global
 *     responses:
 *       '200':
 *         description: List of shared MCP definitions
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListMcpServerConfigsSuccessResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const service = new McpConfigService();
  const configs = await service.listByScope(scope);
  const redacted = configs.map((config) => redactSharedConfigSecrets(config.toJSON ? config.toJSON() : config));
  return successResponse(redacted, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/config/mcp-servers:
 *   post:
 *     summary: Create an MCP server config
 *     description: >
 *       Creates a new shared MCP definition. Validates the slug format
 *       and uniqueness within the selected scope. Shared discovery runs during
 *       creation only for MCPs that do not depend on per-user auth.
 *     tags:
 *       - MCP Server Config
 *     operationId: createMcpServerConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMcpServerConfigRequest'
 *     responses:
 *       '201':
 *         description: MCP server config created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetMcpServerConfigSuccessResponse'
 *       '400':
 *         description: Missing required fields (slug, name, transport)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: A config with this slug already exists in the given scope
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '422':
 *         description: Invalid slug format or non-auth MCP server connectivity validation failed
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
const postHandler = async (req: NextRequest) => {
  const body = await req.json();
  const { slug, name, transport } = body;

  if (!slug || !name || !transport) {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: 'Missing required fields: slug, name, transport' },
      },
      { status: 400 }
    );
  }

  const service = new McpConfigService();
  const input = {
    slug,
    name,
    scope: body.scope || 'global',
    description: body.description,
    transport: body.transport,
    preset: body.preset,
    sharedConfig: body.sharedConfig,
    authConfig: body.authConfig,
    enabled: body.enabled,
    timeout: body.timeout,
  };

  try {
    const config = await service.create(input);
    const result = redactSharedConfigSecrets(config.toJSON ? config.toJSON() : config);
    return successResponse(result, { status: 201 }, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 409 }
      );
    }
    if (message.includes('connectivity validation failed') || message.includes('Invalid slug')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 422 }
      );
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
