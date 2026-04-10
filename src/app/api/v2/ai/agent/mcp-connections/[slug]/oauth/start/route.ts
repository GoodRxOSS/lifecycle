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

import { auth } from '@ai-sdk/mcp';
import { NextRequest, NextResponse } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import { APP_HOST } from 'shared/config';
import {
  applyCompiledConnectionConfigToTransport,
  buildMcpDefinitionFingerprint,
  mergeCompiledConnectionConfig,
  normalizeAuthConfig,
} from 'server/services/ai/mcp/connectionConfig';
import { McpConfigService } from 'server/services/ai/mcp/config';
import McpOAuthFlowService from 'server/services/ai/mcp/oauthFlow';
import { PersistentOAuthClientProvider } from 'server/services/ai/mcp/oauthProvider';
import type { McpStoredUserConnectionState } from 'server/services/ai/mcp/types';
import UserMcpConnectionService from 'server/services/userMcpConnection';

type OAuthConnectionState = Extract<McpStoredUserConnectionState, { type: 'oauth' }>;

function buildCallbackUrl(slug: string): string {
  const api = new URL(APP_HOST);
  api.pathname = `/api/v2/ai/agent/mcp-connections/${encodeURIComponent(slug)}/oauth/callback`;
  return api.toString();
}

function hasCompatibleRedirectUri(state: OAuthConnectionState, redirectUrl: string): boolean {
  const redirectUris = state.clientInformation?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return true;
  }

  return redirectUris.includes(redirectUrl);
}

function sanitizeInitialOAuthState(
  state: OAuthConnectionState | null | undefined,
  redirectUrl: string
): OAuthConnectionState | null {
  if (!state) {
    return null;
  }

  if (hasCompatibleRedirectUri(state, redirectUrl)) {
    return state;
  }

  if (state.tokens) {
    return {
      type: 'oauth',
      tokens: state.tokens,
    };
  }

  return { type: 'oauth' };
}

function resolveAppOrigin(req: NextRequest): string | null {
  const originHeader = req.headers.get('origin');
  if (originHeader) {
    try {
      return new URL(originHeader).origin;
    } catch {
      return null;
    }
  }

  const refererHeader = req.headers.get('referer');
  if (!refererHeader) {
    return null;
  }

  try {
    return new URL(refererHeader).origin;
  } catch {
    return null;
  }
}

/**
 * @openapi
 * /api/v2/ai/agent/mcp-connections/{slug}/oauth/start:
 *   post:
 *     summary: Start an OAuth flow for a per-user MCP connection
 *     tags:
 *       - Agent Sessions
 *     operationId: startAgentMcpConnectionOAuth
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *     responses:
 *       '200':
 *         description: OAuth start result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StartAgentMcpConnectionOAuthSuccessResponse'
 */
const postHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
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
  if (authConfig.mode !== 'oauth') {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: `MCP connection '${slug}' does not use OAuth` },
      },
      { status: 400 }
    );
  }

  if (config.transport.type !== 'http' && config.transport.type !== 'sse') {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: `OAuth MCP connection '${slug}' must use an HTTP or SSE transport` },
      },
      { status: 400 }
    );
  }

  const definitionFingerprint = buildMcpDefinitionFingerprint({
    preset: config.preset,
    transport: config.transport,
    sharedConfig: config.sharedConfig,
    authConfig,
  });
  const callbackUrl = buildCallbackUrl(slug);
  const existing = await UserMcpConnectionService.getDecryptedConnection(
    userIdentity.userId,
    scope,
    slug,
    userIdentity.githubUsername,
    definitionFingerprint
  );
  const initialState =
    existing?.state?.type === 'oauth' ? sanitizeInitialOAuthState(existing.state, callbackUrl) : null;
  const flow = await McpOAuthFlowService.create({
    userId: userIdentity.userId,
    ownerGithubUsername: userIdentity.githubUsername,
    slug,
    scope,
    definitionFingerprint,
    appOrigin: resolveAppOrigin(req),
  });

  const provider = new PersistentOAuthClientProvider({
    userId: userIdentity.userId,
    ownerGithubUsername: userIdentity.githubUsername,
    scope,
    slug,
    definitionFingerprint,
    authConfig,
    redirectUrl: callbackUrl,
    statePrefix: flow.flowId,
    initialState,
    discoveredTools: existing?.discoveredTools,
    validatedAt: existing?.validatedAt,
    interactive: true,
  });
  const transport = applyCompiledConnectionConfigToTransport(
    config.transport,
    mergeCompiledConnectionConfig(config.sharedConfig || {}, undefined),
    { authProvider: provider }
  );
  if (transport.type === 'stdio') {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: `OAuth MCP connection '${slug}' must use an HTTP or SSE transport` },
      },
      { status: 400 }
    );
  }

  try {
    const result = await auth(provider, {
      serverUrl: transport.url,
      scope: authConfig.scope,
    });

    if (result !== 'REDIRECT') {
      await McpOAuthFlowService.invalidate(flow.flowId);
    }

    return successResponse(
      {
        status: result,
        authorizationUrl: provider.authorizationUrl?.toString() || null,
      },
      { status: 200 },
      req
    );
  } catch (error) {
    await McpOAuthFlowService.invalidate(flow.flowId);
    throw error;
  }
};

export const POST = createApiHandler(postHandler);
