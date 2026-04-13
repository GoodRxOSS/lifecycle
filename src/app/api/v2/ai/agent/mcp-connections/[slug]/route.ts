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
import { getRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import {
  applyCompiledConnectionConfigToTransport,
  buildMcpDefinitionFingerprint,
  compileFieldConnectionConfig,
  getAuthMode,
  mergeCompiledConnectionConfig,
  normalizeAuthConfig,
  normalizeUserConnectionValues,
} from 'server/services/ai/mcp/connectionConfig';
import { McpConfigService } from 'server/services/ai/mcp/config';
import UserMcpConnectionService from 'server/services/userMcpConnection';

/**
 * @openapi
 * /api/v2/ai/agent/mcp-connections/{slug}:
 *   put:
 *     summary: Save or update a field-based per-user MCP connection
 *     description: >
 *       Saves encrypted per-user connection values for a shared MCP
 *       that uses field-based user auth, validates them against the MCP
 *       schema, and discovers tools using the current user's effective runtime
 *       config.
 *     tags:
 *       - Agent Sessions
 *     operationId: upsertAgentMcpConnection
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared MCP slug.
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: Shared MCP scope (`global` or `owner/repo`).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpsertAgentMcpConnectionBody'
 *     responses:
 *       '200':
 *         description: Per-user MCP connection saved and validated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAgentMcpConnectionSuccessResponse'
 *       '400':
 *         description: Invalid scope, schema, or field values
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
 *       '422':
 *         description: Connection values were stored, but validation or discovery failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Delete a per-user MCP connection
 *     description: >
 *       Removes the current user's saved MCP connection state for the selected
 *       shared MCP and returns the resulting empty connection state.
 *     tags:
 *       - Agent Sessions
 *     operationId: deleteAgentMcpConnection
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared MCP slug.
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: Shared MCP scope (`global` or `owner/repo`).
 *     responses:
 *       '200':
 *         description: Per-user MCP connection deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAgentMcpConnectionSuccessResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const putHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const body = await req.json();
  const values = normalizeUserConnectionValues(body?.values);

  const configService = new McpConfigService();
  const config = await configService.getBySlugAndScope(slug, scope);
  if (!config || !config.enabled) {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: `Enabled MCP connection '${slug}' not found in scope '${scope}'` },
      },
      { status: 404 }
    );
  }

  const authConfig = normalizeAuthConfig(config.authConfig);
  if (authConfig.mode !== 'user-fields') {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: {
          message:
            authConfig.mode === 'oauth'
              ? `MCP connection '${slug}' uses OAuth. Start the OAuth flow instead of saving raw values.`
              : `MCP connection '${slug}' does not accept per-user field configuration`,
        },
      },
      { status: 400 }
    );
  }

  let compiledUserConfig;
  try {
    compiledUserConfig = compileFieldConnectionConfig(authConfig.schema, values);
  } catch (error) {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: error instanceof Error ? error.message : String(error) },
      },
      { status: 400 }
    );
  }

  const validatedAt = new Date().toISOString();
  const definitionFingerprint = buildMcpDefinitionFingerprint({
    preset: config.preset,
    transport: config.transport,
    sharedConfig: config.sharedConfig,
    authConfig,
  });
  const compiledConfig = mergeCompiledConnectionConfig(config.sharedConfig || {}, compiledUserConfig);
  const transport = applyCompiledConnectionConfigToTransport(config.transport, compiledConfig);

  try {
    const discoveredTools = await configService.discoverTools(transport, config.timeout);
    if (discoveredTools.length === 0) {
      throw new Error(`MCP validation failed for ${slug}: server returned 0 tools`);
    }

    await UserMcpConnectionService.upsertConnection({
      userId: userIdentity.userId,
      ownerGithubUsername: userIdentity.githubUsername,
      scope,
      slug,
      state: { type: 'fields', values },
      definitionFingerprint,
      discoveredTools,
      validationError: null,
      validatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await UserMcpConnectionService.upsertConnection({
      userId: userIdentity.userId,
      ownerGithubUsername: userIdentity.githubUsername,
      scope,
      slug,
      state: { type: 'fields', values },
      definitionFingerprint,
      discoveredTools: [],
      validationError: message,
      validatedAt,
    });

    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message },
      },
      { status: 422 }
    );
  }

  const state = await UserMcpConnectionService.getMaskedState(
    userIdentity.userId,
    scope,
    slug,
    userIdentity.githubUsername,
    definitionFingerprint,
    getAuthMode(authConfig)
  );

  return successResponse(state, { status: 200 }, req);
};

const deleteHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const configService = new McpConfigService();
  const config = await configService.getBySlugAndScope(slug, scope);
  const authConfig = normalizeAuthConfig(config?.authConfig);

  await UserMcpConnectionService.deleteConnection(userIdentity.userId, scope, slug, userIdentity.githubUsername);
  const state = await UserMcpConnectionService.getMaskedState(
    userIdentity.userId,
    scope,
    slug,
    userIdentity.githubUsername,
    undefined,
    getAuthMode(authConfig)
  );

  return successResponse(state, { status: 200 }, req);
};

export const PUT = createApiHandler(putHandler);
export const DELETE = createApiHandler(deleteHandler);
