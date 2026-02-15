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
import { McpConfigService } from 'server/services/ai/mcp/config';
import 'server/lib/dependencies';

function redactHeaders(config: any): any {
  if (!config.headers || typeof config.headers !== 'object') return config;
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(config.headers)) {
    redacted[key] = '******';
  }
  return { ...config, headers: redacted };
}

/**
 * @openapi
 * /api/v2/ai/config/mcp-servers:
 *   get:
 *     summary: List MCP server configs
 *     description: >
 *       Returns all MCP server configurations for the given scope. Header values are
 *       redacted to "******" in responses for security. Each config includes its
 *       cachedTools array, which is populated during creation and refreshed by the
 *       health endpoint. Use scope "global" (default) for org-wide servers or pass
 *       a repository full name (e.g. "goodrx/lifecycle") for repo-scoped servers.
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
 *           full name (e.g. "goodrx/lifecycle") for repo-scoped configs.
 *         example: global
 *     responses:
 *       '200':
 *         description: List of MCP server configurations (header values redacted)
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
  const redacted = configs.map((c) => redactHeaders(c.toJSON ? c.toJSON() : c));
  return successResponse(redacted, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/config/mcp-servers:
 *   post:
 *     summary: Create an MCP server config
 *     description: >
 *       Creates a new MCP server configuration. Validates the slug format
 *       (lowercase alphanumeric/hyphens, max 100 chars), checks slug uniqueness
 *       within the scope, and validates server connectivity before persisting.
 *       Cached tools are populated from the connectivity check.
 *       Header values are redacted in the response.
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
 *         description: Missing required fields (slug, name, url)
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
 *         description: Invalid slug format or MCP server connectivity validation failed
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
  const { slug, name, url } = body;

  if (!slug || !name || !url) {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: 'Missing required fields: slug, name, url' },
      },
      { status: 400 }
    );
  }

  const service = new McpConfigService();
  const input = {
    slug,
    name,
    url,
    scope: body.scope || 'global',
    description: body.description,
    headers: body.headers,
    envVars: body.envVars,
    enabled: body.enabled,
    timeout: body.timeout,
  };

  try {
    const config = await service.create(input);
    const result = redactHeaders(config.toJSON ? config.toJSON() : config);
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
