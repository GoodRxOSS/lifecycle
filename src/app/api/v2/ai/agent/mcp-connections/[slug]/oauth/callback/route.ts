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
import { APP_HOST } from 'shared/config';
import {
  applyCompiledConnectionConfigToTransport,
  buildMcpDefinitionFingerprint,
  mergeCompiledConnectionConfig,
  normalizeAuthConfig,
} from 'server/services/ai/mcp/connectionConfig';
import { McpConfigService } from 'server/services/ai/mcp/config';
import McpOAuthFlowService, { extractMcpOAuthFlowId, type McpOAuthFlowRecord } from 'server/services/ai/mcp/oauthFlow';
import { PersistentOAuthClientProvider } from 'server/services/ai/mcp/oauthProvider';
import type { McpDiscoveredTool, McpStoredUserConnectionState } from 'server/services/ai/mcp/types';
import UserMcpConnectionService from 'server/services/userMcpConnection';

type OAuthConnectionState = Extract<McpStoredUserConnectionState, { type: 'oauth' }>;

type OAuthCallbackMessage = {
  type: 'lfc-mcp-oauth-complete';
  slug: string;
  scope: string;
  success: boolean;
  error?: string;
};

function buildCallbackUrl(slug: string): string {
  const api = new URL(APP_HOST);
  api.pathname = `/api/v2/ai/agent/mcp-connections/${encodeURIComponent(slug)}/oauth/callback`;
  return api.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function clearPendingOAuthState(state: OAuthConnectionState): OAuthConnectionState {
  const { codeVerifier: _codeVerifier, oauthState: _oauthState, ...rest } = state;
  return rest;
}

async function persistOAuthConnectionState(params: {
  flow: Pick<McpOAuthFlowRecord, 'definitionFingerprint' | 'ownerGithubUsername' | 'scope' | 'slug' | 'userId'>;
  state: OAuthConnectionState;
  discoveredTools: McpDiscoveredTool[];
  validationError: string | null;
  validatedAt: string | null;
}): Promise<void> {
  await UserMcpConnectionService.upsertConnection({
    userId: params.flow.userId,
    ownerGithubUsername: params.flow.ownerGithubUsername,
    scope: params.flow.scope,
    slug: params.flow.slug,
    state: clearPendingOAuthState(params.state),
    definitionFingerprint: params.flow.definitionFingerprint,
    discoveredTools: params.discoveredTools,
    validationError: params.validationError,
    validatedAt: params.validatedAt,
  });
}

async function clearPendingFlowState(
  flow: Pick<McpOAuthFlowRecord, 'definitionFingerprint' | 'ownerGithubUsername' | 'scope' | 'slug' | 'userId'>,
  validationError: string
): Promise<void> {
  const existing = await UserMcpConnectionService.getDecryptedConnection(
    flow.userId,
    flow.scope,
    flow.slug,
    flow.ownerGithubUsername,
    flow.definitionFingerprint
  );

  if (existing?.state?.type !== 'oauth') {
    return;
  }

  await persistOAuthConnectionState({
    flow,
    state: existing.state,
    discoveredTools: existing.discoveredTools,
    validationError,
    validatedAt: existing.validatedAt ?? new Date().toISOString(),
  });
}

function renderCallbackPage(options: {
  title: string;
  message: string;
  targetOrigin?: string | null;
  postMessage?: OAuthCallbackMessage;
}): string {
  const title = escapeHtml(options.title);
  const message = escapeHtml(options.message);
  const postMessage = options.postMessage ? serializeScriptValue(options.postMessage) : 'null';
  const targetOrigin = options.targetOrigin ? serializeScriptValue(options.targetOrigin) : 'null';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; color: #111827; }
      .card { max-width: 560px; margin: 48px auto; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { margin: 0; line-height: 1.5; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
    <script>
      const payload = ${postMessage};
      const targetOrigin = ${targetOrigin};
      if (window.opener && payload && typeof targetOrigin === 'string' && targetOrigin.length > 0) {
        window.opener.postMessage(payload, targetOrigin);
      }
      window.close();
    </script>
  </body>
</html>`;
}

/**
 * @openapi
 * /api/v2/ai/agent/mcp-connections/{slug}/oauth/callback:
 *   get:
 *     summary: Complete an OAuth flow for a per-user MCP connection
 *     tags:
 *       - Agent Sessions
 *     operationId: completeAgentMcpConnectionOAuth
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
 *         description: Legacy scope parameter kept for compatibility with in-flight callbacks.
 *       - in: query
 *         name: flow
 *         schema:
 *           type: string
 *         description: Legacy flow identifier kept for compatibility with in-flight callbacks.
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const requestedScope = req.nextUrl.searchParams.get('scope');
  const code = req.nextUrl.searchParams.get('code') || undefined;
  const callbackState = req.nextUrl.searchParams.get('state') || undefined;
  const oauthError = req.nextUrl.searchParams.get('error');
  const queryFlowId = req.nextUrl.searchParams.get('flow') || '';
  const stateFlowId = extractMcpOAuthFlowId(callbackState);
  if (stateFlowId && queryFlowId && stateFlowId !== queryFlowId) {
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: 'Connection callback did not match the original authorization flow.',
      }),
      {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  const flowId = stateFlowId || queryFlowId;
  const flow = await McpOAuthFlowService.consume(flowId);

  if (!flow) {
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection expired',
        message: 'This connection attempt is no longer valid. Start the connection again from Lifecycle.',
      }),
      {
        status: 410,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  const messageBase = {
    slug: flow.slug,
    scope: flow.scope,
    targetOrigin: flow.appOrigin,
  } as const;

  if (slug !== flow.slug || (requestedScope && requestedScope !== flow.scope)) {
    const mismatchMessage = 'Connection callback did not match the original MCP request.';
    await clearPendingFlowState(flow, mismatchMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: mismatchMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: mismatchMessage,
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  const configService = new McpConfigService();
  const config = await configService.getBySlugAndScope(flow.slug, flow.scope);
  if (!config || !config.enabled) {
    const missingMessage = `Enabled MCP connection '${flow.slug}' was not found.`;
    await clearPendingFlowState(flow, missingMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: missingMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: missingMessage,
        },
      }),
      {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  const authConfig = normalizeAuthConfig(config.authConfig);
  if (authConfig.mode !== 'oauth') {
    const invalidModeMessage = `MCP connection '${flow.slug}' does not use OAuth.`;
    await clearPendingFlowState(flow, invalidModeMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: invalidModeMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: invalidModeMessage,
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  if (config.transport.type !== 'http' && config.transport.type !== 'sse') {
    const invalidTransportMessage = `OAuth MCP connection '${flow.slug}' must use HTTP or SSE transport.`;
    await clearPendingFlowState(flow, invalidTransportMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: invalidTransportMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: invalidTransportMessage,
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  const definitionFingerprint = buildMcpDefinitionFingerprint({
    preset: config.preset,
    transport: config.transport,
    sharedConfig: config.sharedConfig,
    authConfig,
  });

  if (definitionFingerprint !== flow.definitionFingerprint) {
    const driftMessage = 'This MCP changed while sign-in was in progress. Start the connection again.';
    await clearPendingFlowState(flow, driftMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection expired',
        message: driftMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: driftMessage,
        },
      }),
      {
        status: 409,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  const existing = await UserMcpConnectionService.getDecryptedConnection(
    flow.userId,
    flow.scope,
    flow.slug,
    flow.ownerGithubUsername,
    definitionFingerprint
  );

  if (oauthError) {
    const oauthErrorMessage = `OAuth provider returned: ${oauthError}`;
    await clearPendingFlowState(flow, oauthErrorMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: oauthErrorMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: oauthErrorMessage,
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  if (!code) {
    const missingCodeMessage = 'Missing OAuth authorization code.';
    await clearPendingFlowState(flow, missingCodeMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: missingCodeMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: missingCodeMessage,
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  const provider = new PersistentOAuthClientProvider({
    userId: flow.userId,
    ownerGithubUsername: flow.ownerGithubUsername,
    scope: flow.scope,
    slug: flow.slug,
    definitionFingerprint,
    authConfig,
    redirectUrl: buildCallbackUrl(flow.slug),
    initialState: existing?.state?.type === 'oauth' ? existing.state : null,
    discoveredTools: existing?.discoveredTools,
    validatedAt: existing?.validatedAt,
    interactive: false,
  });
  const transport = applyCompiledConnectionConfigToTransport(
    config.transport,
    mergeCompiledConnectionConfig(config.sharedConfig || {}, undefined),
    { authProvider: provider }
  );
  if (transport.type === 'stdio') {
    const invalidTransportMessage = `OAuth MCP connection '${flow.slug}' must use HTTP or SSE transport.`;
    await clearPendingFlowState(flow, invalidTransportMessage);
    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message: invalidTransportMessage,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: invalidTransportMessage,
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }

  try {
    await auth(provider, {
      serverUrl: transport.url,
      authorizationCode: code,
      callbackState,
      scope: authConfig.scope,
    });

    const validatedAt = new Date().toISOString();
    const discoveredTools = await configService.discoverTools(transport, config.timeout);
    await persistOAuthConnectionState({
      flow,
      state: provider.currentState,
      discoveredTools,
      validationError: null,
      validatedAt,
    });

    return new NextResponse(
      renderCallbackPage({
        title: 'Connection complete',
        message: 'You can return to Lifecycle now.',
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: true,
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistOAuthConnectionState({
      flow,
      state: provider.currentState,
      discoveredTools: [],
      validationError: message,
      validatedAt: new Date().toISOString(),
    });

    return new NextResponse(
      renderCallbackPage({
        title: 'Connection failed',
        message,
        targetOrigin: messageBase.targetOrigin,
        postMessage: {
          type: 'lfc-mcp-oauth-complete',
          slug: messageBase.slug,
          scope: messageBase.scope,
          success: false,
          error: message,
        },
      }),
      {
        status: 422,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );
  }
};

export const GET = createApiHandler(getHandler);
