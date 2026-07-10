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

import 'module-alias/register';
import { join } from 'path';
import moduleAlias from 'module-alias';

// Register path aliases
moduleAlias.addAliases({
  shared: join(__dirname, 'src/shared'),
  server: join(__dirname, 'src/server'),
  root: join(__dirname, '.'),
  src: join(__dirname, 'src'),
  scripts: join(__dirname, 'scripts'),
});

import { createServer, IncomingMessage, ServerResponse, request as httpRequest, STATUS_CODES } from 'http';
import { request as httpsRequest } from 'https';
import type { Socket } from 'net';
import { parse, URL } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { rootLogger } from './src/server/lib/logger';
import { LIFECYCLE_MODE } from './src/shared/config';
import { isMcpServerEnabled, isAuthEnabled } from './src/server/mcp/config';
import { streamK8sLogs, AbortHandle } from './src/server/lib/k8sStreamer';
import SitesService from './src/server/services/sites';
import {
  serializeSocketHttpResponse,
  EDITOR_PROXY_TIMEOUT_MS,
  EDITOR_PROXY_PING_INTERVAL_MS,
  EDITOR_PROXY_PONG_DEADLINE_MS,
  editorProxyConnections,
  classifyEditorProxyFailure,
  resolveEditorProxyFailureMapping,
  buildWorkspaceEditorErrorPage,
  isEditorNavigationRequest,
  type EditorProxyFailureContext,
} from './src/server/lib/agentSession/workspaceEditorProxy';
import {
  buildChatPreviewAuthRedirectUrl,
  buildChatPreviewCookie,
  buildProxyHeaders,
  buildRemoteTargetUrl,
  appendForwardQuery,
  CHAT_PREVIEW_COOKIE_NAME,
  EDITOR_PROXY_BLOCKED_QUERY_PARAMS,
  HOP_BY_HOP_HEADERS,
  parseCookieHeader,
  PREVIEW_PROXY_BLOCKED_QUERY_PARAMS,
  rewritePreviewResponseHeader,
  stripPreviewBootstrapParams,
  stripQueryParamsFromRequestUrl,
  type ChatPreviewPathMatch,
} from './src/server/lib/agentSession/chatPreviewProxy';
import { verifyChatPreviewGrant } from './src/server/lib/agentSession/chatPreviewGrant';
import { parseChatPreviewHost } from './src/server/lib/agentSession/chatPreviewFactory';
import { resolveChatPreviewSessionForHost } from './src/server/lib/agentSession/chatPreviewHostResolver';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

// --- Initialize Next.js App ---
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const LOG_STREAM_PATH = '/api/logs/stream'; // Path for WebSocket connections
const SESSION_WORKSPACE_EDITOR_PATH_PREFIX = '/api/agent-session/workspace-editor/';
const SESSION_WORKSPACE_EDITOR_COOKIE_NAME = 'lfc_session_workspace_editor_auth';
const SESSION_WORKSPACE_EDITOR_PORT = parseInt(process.env.AGENT_SESSION_WORKSPACE_EDITOR_PORT || '13337', 10);
const logger = rootLogger.child({ filename: __filename });

// jose (an MCP auth dependency) is ESM-only and loads via require(esm), which needs
// Node >= 20.19. Loading the handler only when the feature is on keeps older Node 20
// minors booting with MCP disabled.
type McpHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string | null | undefined
) => Promise<boolean>;
let handleMcpHttpRequest: McpHttpHandler | null = null;
if (isMcpServerEnabled()) {
  if (isAuthEnabled() && !process.env.MCP_RESOURCE_URL) {
    logger.warn(
      'MCP: MCP_SERVER_ENABLED is true with auth on but MCP_RESOURCE_URL is unset; ' +
        'token audiences will be validated against a localhost default and all real tokens will be rejected'
    );
  }
  handleMcpHttpRequest = require('./src/server/mcp/handler').handleMcpHttpRequest as McpHttpHandler;
}
let sitesGatewayService: SitesService | null = null;

type SessionWorkspaceEditorPathMatch = { sessionId: string; forwardPath: string };

function getSitesGatewayService(): SitesService {
  if (!sitesGatewayService) {
    sitesGatewayService = new SitesService();
  }

  return sitesGatewayService;
}

// decodeURIComponent throws URIError on malformed escapes; a crash here would take down the server.
function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseSessionWorkspaceEditorPath(pathname: string | null | undefined): SessionWorkspaceEditorPathMatch | null {
  const safePathname = pathname || '';
  if (safePathname.startsWith(SESSION_WORKSPACE_EDITOR_PATH_PREFIX)) {
    const remainder = safePathname.slice(SESSION_WORKSPACE_EDITOR_PATH_PREFIX.length);
    const slashIndex = remainder.indexOf('/');
    const rawSessionId = slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder;
    const sessionId = rawSessionId ? safeDecodeURIComponent(rawSessionId) : null;
    if (!sessionId) {
      return null;
    }

    const forwardPath = slashIndex >= 0 ? remainder.slice(slashIndex) : '/';
    return {
      sessionId,
      forwardPath: forwardPath || '/',
    };
  }
  return null;
}

async function resolveChatPreviewHostPathMatch(
  request: IncomingMessage,
  pathname: string | null | undefined
): Promise<ChatPreviewPathMatch | null> {
  const hostMatch = parseChatPreviewHost(request.headers.host);
  if (!hostMatch) {
    return null;
  }

  const session = await resolveChatPreviewSessionForHost(hostMatch);
  if (!session) {
    return null;
  }

  return {
    sessionId: session.sessionId,
    port: hostMatch.port,
    forwardPath: pathname || '/',
    previewHost: hostMatch.host,
    previewSlug: hostMatch.previewSlug,
  };
}

// SECURITY: the preview proxies a workspace's own web app to the public ws-server origin;
// without this it would be reachable by anyone who learns the session uuid + port. Gated to
// the session owner with host-bound opaque preview grants.
async function resolveChatPreviewSessionUserId(sessionId: string): Promise<string | null> {
  const { default: AgentSession } = await import('./src/server/models/AgentSession');
  const session = await AgentSession.query().findOne({ uuid: sessionId });
  return session?.userId ?? null;
}

async function isAuthorizedChatPreviewRequest(
  request: IncomingMessage,
  sessionUserId: string,
  match: ChatPreviewPathMatch,
  queryGrant?: string | null
): Promise<boolean> {
  // Auth disabled (local dev) keeps the editor's behavior: open, same as that proxy.
  if (process.env.ENABLE_AUTH !== 'true') {
    return true;
  }

  const cookieGrant = parseCookieHeader(request.headers.cookie)[CHAT_PREVIEW_COOKIE_NAME];
  const expectedGrant = {
    sessionId: match.sessionId,
    port: match.port,
    userId: sessionUserId,
    previewHost: match.previewHost,
  };
  return verifyChatPreviewGrant(cookieGrant, expectedGrant) || verifyChatPreviewGrant(queryGrant, expectedGrant);
}

function setNoReferrerPolicy(res: ServerResponse): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function getSessionWorkspaceEditorCookiePath(sessionId: string): string {
  return `${SESSION_WORKSPACE_EDITOR_PATH_PREFIX}${encodeURIComponent(sessionId)}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) {
    return null;
  }

  try {
    const normalizedPayload = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      '='
    );
    return JSON.parse(Buffer.from(paddedPayload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getJwtCookieMaxAgeSeconds(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return null;
  }

  return Math.max(Math.floor(exp - Date.now() / 1000), 0);
}

function isSendableCloseCode(code?: number): code is number {
  if (typeof code !== 'number') {
    return false;
  }

  if (code < 1000 || code >= 5000) {
    return false;
  }

  return ![1004, 1005, 1006, 1015].includes(code);
}

function buildSessionWorkspaceEditorCookie(request: IncomingMessage, sessionId: string, token: string): string {
  const isSecure =
    request.headers['x-forwarded-proto'] === 'https' || (request.socket as { encrypted?: boolean }).encrypted === true;
  const maxAgeSeconds = getJwtCookieMaxAgeSeconds(token);
  const cookieParts = [
    `${SESSION_WORKSPACE_EDITOR_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${getSessionWorkspaceEditorCookiePath(sessionId)}`,
    ...(maxAgeSeconds === null ? [] : [`Max-Age=${maxAgeSeconds}`]),
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (isSecure) {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

function appendSetCookie(res: ServerResponse, value: string) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, value]);
    return;
  }

  res.setHeader('Set-Cookie', [existing.toString(), value]);
}

function buildSessionWorkspaceEditorServiceUrl(
  session: { id: string; podName: string; namespace: string },
  forwardPath: string,
  query: Record<string, string | string[] | undefined>,
  isWebSocket = false
) {
  const protocol = isWebSocket ? 'ws' : 'http';
  const target = new URL(
    `${protocol}://${session.podName}.${session.namespace}.svc.cluster.local:${SESSION_WORKSPACE_EDITOR_PORT}${forwardPath}`
  );

  appendForwardQuery(target, query, EDITOR_PROXY_BLOCKED_QUERY_PARAMS);
  return target;
}

type SessionWorkspaceEditorTarget = {
  url: URL;
  headers?: Record<string, string>;
  // SECURITY: remote (untrusted) editor backends must not receive Lifecycle credentials nor set cookies on our origin.
  isRemote: boolean;
};

// Endpoint lookups run on every proxied request (browser previews fan out to dozens); cache the
// DB-backed resolution briefly so the hot path stays off the database.
const ENDPOINT_CACHE_TTL_MS = 5000;
const ENDPOINT_CACHE_NEGATIVE_TTL_MS = 1500;
const ENDPOINT_CACHE_MAX_ENTRIES = 1000;
type RemoteEndpointRef = { url: string; headers?: Record<string, string> } | null;
const endpointCache = new Map<string, { value: RemoteEndpointRef; expiresAt: number }>();

async function resolveCachedEndpoint(key: string, lookup: () => Promise<RemoteEndpointRef>) {
  const cached = endpointCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await lookup();
  if (endpointCache.size >= ENDPOINT_CACHE_MAX_ENTRIES) {
    endpointCache.clear();
  }
  endpointCache.set(key, {
    value,
    expiresAt: Date.now() + (value ? ENDPOINT_CACHE_TTL_MS : ENDPOINT_CACHE_NEGATIVE_TTL_MS),
  });
  return value;
}

async function resolveSessionWorkspaceEditorTarget(
  session: { id: string; uuid?: string; podName: string; namespace: string },
  forwardPath: string,
  query: Record<string, string | string[] | undefined>,
  isWebSocket = false
): Promise<SessionWorkspaceEditorTarget> {
  const endpoint = await resolveCachedEndpoint(`editor:${session.uuid || session.id}`, async () => {
    const AgentSandboxService = (await import('./src/server/services/agent/SandboxService')).default;
    return AgentSandboxService.resolveWorkspaceEditorEndpoint(session.uuid || session.id).catch(() => null);
  });
  if (endpoint) {
    return {
      url: buildRemoteTargetUrl(endpoint.url, forwardPath, query, {
        isWebSocket,
        blockedQueryParams: EDITOR_PROXY_BLOCKED_QUERY_PARAMS,
      }),
      isRemote: true,
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
    };
  }

  return {
    url: buildSessionWorkspaceEditorServiceUrl(session, forwardPath, query, isWebSocket),
    isRemote: false,
  };
}

// The exposure row intentionally holds no bearer token at rest; gateway auth headers are re-resolved
// per lookup from the exposure's own sandbox so URL and token never span generations.
async function resolvePreviewEndpointWithAuth(
  providerState: unknown,
  sandbox: import('./src/server/models/AgentSandbox').default,
  session: import('./src/server/models/AgentSession').default
): Promise<RemoteEndpointRef> {
  const { resolvePersistedPreviewEndpointWithAuth } = await import(
    './src/server/services/workspaceRuntime/gatewayPreview'
  );
  const { default: AgentSandboxService } = await import('./src/server/services/agent/SandboxService');
  return resolvePersistedPreviewEndpointWithAuth(providerState || {}, () =>
    AgentSandboxService.resolveGatewayEndpointForSandbox(sandbox, session).catch((error) => {
      logger.warn({ error, sessionId: session.uuid }, 'ChatPreview: gateway auth resolution failed');
      return null;
    })
  );
}

async function lookupChatPreviewEndpoint(match: ChatPreviewPathMatch): Promise<RemoteEndpointRef> {
  const [{ default: AgentSession }, { default: AgentSandbox }, { default: AgentSandboxExposure }] = await Promise.all([
    import('./src/server/models/AgentSession'),
    import('./src/server/models/AgentSandbox'),
    import('./src/server/models/AgentSandboxExposure'),
  ]);
  if (match.previewSlug) {
    let exposure = await AgentSandboxExposure.query()
      .where({ kind: 'preview', targetPort: match.port })
      .whereRaw('"metadata"->>? = ?', ['previewSlug', match.previewSlug])
      .orderBy('id', 'desc')
      .first();
    if (!exposure) {
      return null;
    }

    const exposureSandbox = await AgentSandbox.query().findById(exposure.sandboxId);
    if (!exposureSandbox || exposureSandbox.status !== 'ready') {
      return null;
    }

    const session = await AgentSession.query().findById(exposureSandbox.sessionId);
    if (
      !session ||
      session.uuid !== match.sessionId ||
      session.status !== 'active' ||
      session.workspaceStatus !== 'ready'
    ) {
      return null;
    }

    if (exposure.status !== 'ready' || exposure.endedAt) {
      const AgentSandboxService = (await import('./src/server/services/agent/SandboxService')).default;
      await AgentSandboxService.restorePreviewExposures(session);
      exposure = await AgentSandboxExposure.query()
        .where({ sandboxId: exposureSandbox.id, kind: 'preview', targetPort: match.port, status: 'ready' })
        .whereRaw('"metadata"->>? = ?', ['previewSlug', match.previewSlug])
        .whereNull('endedAt')
        .first();
      if (!exposure) {
        return null;
      }
    }

    return resolvePreviewEndpointWithAuth(exposure.providerState, exposureSandbox, session);
  }

  const session = await AgentSession.query().findOne({ uuid: match.sessionId });
  if (!session || session.status !== 'active' || session.workspaceStatus !== 'ready') {
    return null;
  }

  const sandbox = await AgentSandbox.query().where({ sessionId: session.id }).orderBy('generation', 'desc').first();
  if (!sandbox || sandbox.status !== 'ready') {
    return null;
  }

  let exposure = await AgentSandboxExposure.query()
    .where({ sandboxId: sandbox.id, kind: 'preview', targetPort: match.port, status: 'ready' })
    .whereNull('endedAt')
    .first();
  if (!exposure) {
    const AgentSandboxService = (await import('./src/server/services/agent/SandboxService')).default;
    await AgentSandboxService.restorePreviewExposures(session);
    exposure = await AgentSandboxExposure.query()
      .where({ sandboxId: sandbox.id, kind: 'preview', targetPort: match.port, status: 'ready' })
      .whereNull('endedAt')
      .first();
    if (!exposure) {
      return null;
    }
  }

  return resolvePreviewEndpointWithAuth(exposure.providerState, sandbox, session);
}

async function resolveChatPreviewTarget(
  match: ChatPreviewPathMatch,
  query: Record<string, string | string[] | undefined>,
  isWebSocket = false
): Promise<SessionWorkspaceEditorTarget | null> {
  const cacheKey = match.previewSlug
    ? `preview:${match.sessionId}:${match.port}:${match.previewSlug}`
    : `preview:${match.sessionId}:${match.port}`;
  const endpoint = await resolveCachedEndpoint(cacheKey, () => lookupChatPreviewEndpoint(match));
  if (!endpoint) {
    return null;
  }

  return {
    url: buildRemoteTargetUrl(endpoint.url, match.forwardPath, query, {
      isWebSocket,
      blockedQueryParams: PREVIEW_PROXY_BLOCKED_QUERY_PARAMS,
    }),
    isRemote: true,
    ...(endpoint.headers ? { headers: endpoint.headers } : {}),
  };
}

function requestForTarget(target: URL): typeof httpRequest {
  return target.protocol === 'https:' || target.protocol === 'wss:' ? httpsRequest : httpRequest;
}

// node's http/https.request reject ws:/wss: URLs. A proxied WebSocket is issued as a normal
// http/https request carrying Upgrade headers — the scheme, not the URL, makes it a WebSocket —
// so the upstream URL must be normalized back to http/https before the request is built.
function toUpgradeRequestUrl(target: URL): URL {
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
    return target;
  }
  const normalized = new URL(target.toString());
  normalized.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  return normalized;
}

// SECURITY: untrusted preview responses must not set cookies on the Lifecycle origin.
function stripSetCookieHeaders(headers: IncomingMessage['headers']): IncomingMessage['headers'] {
  const { 'set-cookie': _setCookie, ...rest } = headers;
  return rest;
}

async function handleSessionWorkspaceEditorUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
  const parsedUrl = parse(request.url || '', true);
  const match = parseSessionWorkspaceEditorPath(parsedUrl.pathname);
  const editorLogCtx: Record<string, unknown> = {
    remoteAddress: request.socket.remoteAddress,
    path: parsedUrl.pathname,
  };

  if (!match) {
    socket.end(
      serializeSocketHttpResponse({ statusCode: 400, statusMessage: 'Bad Request', body: 'Invalid editor path' })
    );
    return;
  }

  let upstreamSocket: Socket | null = null;
  let proxyReq: ReturnType<typeof httpRequest> | null = null;
  // rh-2: track this socket pair as a live connection.
  const registryToken = {};
  let registered = false;
  // Once the pipe is live, release-on-close owns the registry slot; finally must not release it.
  let pipeEstablished = false;
  let clientClosedEarly = false;

  // rh-2: bind client close/error before the connect await so a disconnect aborts the pending proxyReq.
  const onEarlyClientClose = () => {
    clientClosedEarly = true;
    if (proxyReq) {
      proxyReq.destroy();
    }
    if (upstreamSocket && !upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
  };
  socket.on('close', onEarlyClientClose);
  socket.on('error', onEarlyClientClose);

  try {
    const queryToken = typeof parsedUrl.query.token === 'string' ? parsedUrl.query.token : null;
    const session = await resolveOwnedAgentSession(request, match.sessionId, queryToken);

    if (clientClosedEarly) {
      return;
    }
    if (!editorProxyConnections.tryRegister(match.sessionId, registryToken)) {
      throw new EditorProxyError('editor-proxy-capacity');
    }
    registered = true;

    const forwardedPrefix = getSessionWorkspaceEditorCookiePath(match.sessionId);
    const target = await resolveSessionWorkspaceEditorTarget(
      session,
      match.forwardPath,
      parsedUrl.query as Record<string, string | string[] | undefined>,
      true
    );
    const targetUrl = target.url;
    const proxyHeaders = buildProxyHeaders(request, targetUrl, forwardedPrefix, target.headers, true, target.isRemote);

    const upstreamUrl = toUpgradeRequestUrl(targetUrl);
    await new Promise<void>((resolve, reject) => {
      proxyReq = requestForTarget(upstreamUrl)(upstreamUrl, {
        method: request.method || 'GET',
        headers: proxyHeaders,
      });

      // rh-2: bound the connect/upgrade phase so a half-open upstream can't hold it open indefinitely.
      proxyReq.setTimeout(EDITOR_PROXY_TIMEOUT_MS, () => {
        proxyReq?.destroy(new EditorProxyError('editor-proxy-timeout'));
      });

      proxyReq.on('upgrade', (upstreamRes, proxiedSocket, upstreamHead) => {
        upstreamSocket = proxiedSocket as Socket;

        // Hand off from the early connect-phase guards to steady-state pipe teardown.
        socket.removeListener('close', onEarlyClientClose);
        socket.removeListener('error', onEarlyClientClose);

        if (clientClosedEarly || socket.destroyed) {
          upstreamSocket.destroy();
          resolve();
          return;
        }

        socket.write(
          serializeSocketHttpResponse({
            statusCode: upstreamRes.statusCode || 101,
            statusMessage: upstreamRes.statusMessage,
            headers: target.isRemote ? stripSetCookieHeaders(upstreamRes.headers) : upstreamRes.headers,
          })
        );

        if (upstreamHead.length > 0) {
          socket.write(upstreamHead);
        }

        if (head.length > 0) {
          upstreamSocket.write(head);
        }

        // rh-2: a byte-pipe can't parse WS frames, so enforce liveness via a bidirectional idle timeout (any traffic resets it).
        const idleMs = EDITOR_PROXY_PING_INTERVAL_MS + EDITOR_PROXY_PONG_DEADLINE_MS;
        const reapIdle = (source: 'client' | 'upstream') => {
          logger.warn(
            { ...editorLogCtx, sessionId: match.sessionId, source, idleMs },
            `SessionEditor: idle timeout source=${source} sessionId=${match.sessionId}`
          );
          if (!socket.destroyed) {
            socket.destroy();
          }
          if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy();
          }
        };
        socket.setTimeout(idleMs, () => reapIdle('client'));
        upstreamSocket.setTimeout(idleMs, () => reapIdle('upstream'));

        socket.on('error', (error) => {
          logger.warn(
            { ...editorLogCtx, error },
            `SessionEditor: socket error source=client sessionId=${match.sessionId}`
          );
          if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy(error as Error);
          }
        });

        upstreamSocket.on('error', (error) => {
          logger.warn(
            { ...editorLogCtx, error },
            `SessionEditor: socket error source=upstream sessionId=${match.sessionId}`
          );
          if (!socket.destroyed) {
            socket.destroy(error as Error);
          }
        });

        socket.on('close', () => {
          if (registered) {
            registered = false;
            editorProxyConnections.release(match.sessionId, registryToken);
          }
          if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.end();
          }
        });

        upstreamSocket.on('close', () => {
          if (!socket.destroyed) {
            socket.end();
          }
        });

        pipeEstablished = true;
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
        socket.resume();
        upstreamSocket.resume();
        resolve();
      });

      proxyReq.on('response', (upstreamRes) => {
        const chunks: Buffer[] = [];

        upstreamRes.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        upstreamRes.on('end', () => {
          if (!socket.destroyed) {
            socket.end(
              serializeSocketHttpResponse({
                statusCode: upstreamRes.statusCode || 502,
                statusMessage: upstreamRes.statusMessage,
                headers: upstreamRes.headers,
                body: Buffer.concat(chunks),
              })
            );
          }

          reject(new Error(`Editor upgrade rejected with status ${upstreamRes.statusCode || 502}`));
        });
      });

      proxyReq.on('error', reject);
      proxyReq.end();
    });
  } catch (error: any) {
    const ctx = extractEditorFailureContext(error);
    const reason = classifyEditorProxyFailure(error, ctx);
    const mapping = resolveEditorProxyFailureMapping(reason);
    logger.error(
      { ...editorLogCtx, error, sessionId: match.sessionId, reason, status: mapping.status },
      `SessionEditor: websocket setup failed sessionId=${match.sessionId} reason=${reason}`
    );

    if (proxyReq) {
      proxyReq.destroy();
    }

    if (upstreamSocket && !upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }

    // WS handshakes aren't browser navigations; reply with a coded status line on the raw socket, not HTML.
    if (!socket.destroyed) {
      socket.end(
        serializeSocketHttpResponse({
          statusCode: mapping.status,
          statusMessage: STATUS_CODES[mapping.status] || 'Bad Gateway',
          headers: { 'X-Editor-Proxy-Reason': reason },
          body: mapping.message,
        })
      );
    }
  } finally {
    socket.removeListener('close', onEarlyClientClose);
    socket.removeListener('error', onEarlyClientClose);
    // Release only when the pipe never went live; a live pipe's slot is released by its socket 'close' handler.
    if (registered && !pipeEstablished) {
      registered = false;
      editorProxyConnections.release(match.sessionId, registryToken);
    }
  }
}

async function handleChatPreviewUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
  const parsedUrl = parse(request.url || '', true);
  let match: ChatPreviewPathMatch | null = null;
  try {
    match = await resolveChatPreviewHostPathMatch(request, parsedUrl.pathname || '/');
    if (!match) {
      socket.end(
        serializeSocketHttpResponse({ statusCode: 400, statusMessage: 'Bad Request', body: 'Invalid preview path' })
      );
      return;
    }

    const previewSessionUserId = await resolveChatPreviewSessionUserId(match.sessionId);
    if (!previewSessionUserId || !(await isAuthorizedChatPreviewRequest(request, previewSessionUserId, match))) {
      socket.end(serializeSocketHttpResponse({ statusCode: 401, statusMessage: 'Unauthorized', body: 'Unauthorized' }));
      return;
    }
  } catch (error) {
    logger.warn({ error, path: parsedUrl.pathname }, 'ChatPreview: websocket authorization failed');
    socket.end(
      serializeSocketHttpResponse({
        statusCode: 502,
        statusMessage: 'Bad Gateway',
        headers: { 'X-Preview-Proxy-Reason': 'preview-unavailable' },
        body: 'Preview is unavailable',
      })
    );
    return;
  }

  if (!match) {
    return;
  }

  let upstreamSocket: Socket | null = null;
  let proxyReq: ReturnType<typeof httpRequest> | null = null;
  let clientClosedEarly = false;
  // Preview pipes share the editor's live-connection registry so they count toward caps/metrics.
  const registryKey = `preview:${match.sessionId}`;
  const registryToken = {};
  let registered = false;
  let pipeEstablished = false;
  const onEarlyClientClose = () => {
    clientClosedEarly = true;
    proxyReq?.destroy();
    if (upstreamSocket && !upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
  };
  socket.on('close', onEarlyClientClose);
  socket.on('error', onEarlyClientClose);

  try {
    const target = await resolveChatPreviewTarget(
      match,
      parsedUrl.query as Record<string, string | string[] | undefined>,
      true
    );
    if (!target) {
      throw new Error('Preview target not found');
    }

    if (clientClosedEarly) {
      return;
    }

    if (!editorProxyConnections.tryRegister(registryKey, registryToken)) {
      throw new Error('preview-proxy-capacity');
    }
    registered = true;

    const targetUrl = target.url;
    const proxyHeaders = buildProxyHeaders(request, targetUrl, '', target.headers, true, true);

    const upstreamUrl = toUpgradeRequestUrl(targetUrl);
    await new Promise<void>((resolve, reject) => {
      proxyReq = requestForTarget(upstreamUrl)(upstreamUrl, {
        method: request.method || 'GET',
        headers: proxyHeaders,
      });
      proxyReq.setTimeout(EDITOR_PROXY_TIMEOUT_MS, () => {
        proxyReq?.destroy(new Error('preview-proxy-timeout'));
      });

      proxyReq.on('upgrade', (upstreamRes, proxiedSocket, upstreamHead) => {
        upstreamSocket = proxiedSocket as Socket;
        socket.removeListener('close', onEarlyClientClose);
        socket.removeListener('error', onEarlyClientClose);

        if (clientClosedEarly || socket.destroyed) {
          upstreamSocket.destroy();
          resolve();
          return;
        }

        socket.write(
          serializeSocketHttpResponse({
            statusCode: upstreamRes.statusCode || 101,
            statusMessage: upstreamRes.statusMessage,
            headers: stripSetCookieHeaders(upstreamRes.headers),
          })
        );

        if (upstreamHead.length > 0) {
          socket.write(upstreamHead);
        }
        if (head.length > 0) {
          upstreamSocket.write(head);
        }

        // A byte-pipe can't parse WS frames, so enforce liveness via a bidirectional idle timeout.
        const idleMs = EDITOR_PROXY_PING_INTERVAL_MS + EDITOR_PROXY_PONG_DEADLINE_MS;
        const reapIdle = (source: 'client' | 'upstream') => {
          logger.warn(
            { sessionId: match.sessionId, port: match.port, source, idleMs },
            `ChatPreview: idle timeout source=${source} sessionId=${match.sessionId}`
          );
          if (!socket.destroyed) {
            socket.destroy();
          }
          if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy();
          }
        };
        socket.setTimeout(idleMs, () => reapIdle('client'));
        upstreamSocket.setTimeout(idleMs, () => reapIdle('upstream'));

        socket.on('error', (error) => {
          if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy(error as Error);
          }
        });
        upstreamSocket.on('error', (error) => {
          if (!socket.destroyed) {
            socket.destroy(error as Error);
          }
        });
        socket.on('close', () => {
          if (registered) {
            registered = false;
            editorProxyConnections.release(registryKey, registryToken);
          }
          if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.end();
          }
        });
        upstreamSocket.on('close', () => {
          if (!socket.destroyed) {
            socket.end();
          }
        });

        pipeEstablished = true;
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
        socket.resume();
        upstreamSocket.resume();
        resolve();
      });

      proxyReq.on('response', (upstreamRes) => {
        const chunks: Buffer[] = [];
        upstreamRes.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamRes.on('end', () => {
          if (!socket.destroyed) {
            socket.end(
              serializeSocketHttpResponse({
                statusCode: upstreamRes.statusCode || 502,
                statusMessage: upstreamRes.statusMessage,
                headers: stripSetCookieHeaders(upstreamRes.headers),
                body: Buffer.concat(chunks),
              })
            );
          }
          reject(new Error(`Preview upgrade rejected with status ${upstreamRes.statusCode || 502}`));
        });
      });

      proxyReq.on('error', reject);
      proxyReq.end();
    });
  } catch (error) {
    logger.warn(
      { error, path: parsedUrl.pathname, sessionId: match.sessionId, port: match.port },
      'ChatPreview: websocket proxy failed'
    );
    proxyReq?.destroy();
    if (upstreamSocket && !upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
    if (!socket.destroyed) {
      socket.end(
        serializeSocketHttpResponse({
          statusCode: 502,
          statusMessage: 'Bad Gateway',
          headers: { 'X-Preview-Proxy-Reason': 'preview-unavailable' },
          body: 'Preview is unavailable',
        })
      );
    }
  } finally {
    socket.removeListener('close', onEarlyClientClose);
    socket.removeListener('error', onEarlyClientClose);
    // Release only when the pipe never went live; a live pipe's slot is released on socket close.
    if (registered && !pipeEstablished) {
      registered = false;
      editorProxyConnections.release(registryKey, registryToken);
    }
  }
}

// err-4: coded error carrying failure context so callers can map suspended vs pod-gone vs auth.
class EditorProxyError extends Error {
  failureContext: EditorProxyFailureContext;
  constructor(message: string, failureContext: EditorProxyFailureContext = {}) {
    super(message);
    this.name = 'EditorProxyError';
    this.failureContext = failureContext;
  }
}

async function resolveOwnedAgentSession(
  request: IncomingMessage,
  sessionId: string,
  queryToken?: string | null
): Promise<any> {
  const AgentSessionService = (await import('./src/server/services/agentSession')).default;
  const session = await AgentSessionService.getSession(sessionId);
  if (!session || session.status !== 'active') {
    throw new EditorProxyError('Session not found or not active', { podMissing: true });
  }

  // sr-3 guard: a crashed suspend can leave status=active over a dead pod; treat not-ready as unavailable to emit a coded page, not a 502.
  if (session.workspaceStatus !== 'ready') {
    throw new EditorProxyError('Workspace is not ready', { workspaceUnavailable: true });
  }
  if (!session.podName || !session.namespace) {
    throw new EditorProxyError('Workspace runtime is gone', { podMissing: true });
  }

  if (process.env.ENABLE_AUTH === 'true') {
    const headerToken = request.headers.authorization?.split(' ')[1];
    const cookieToken = parseCookieHeader(request.headers.cookie)[SESSION_WORKSPACE_EDITOR_COOKIE_NAME];
    const rawToken = headerToken || queryToken || cookieToken;

    if (!rawToken) {
      throw new Error('Authentication token is required');
    }

    const { verifyBearerToken } = await import('./src/server/lib/auth');
    const authResult = await verifyBearerToken(rawToken);
    if (!authResult.success || authResult.payload?.sub !== session.userId) {
      throw new Error('Forbidden: you do not own this session');
    }
  }

  return session;
}

function closeSocket(ws: WebSocket, code: number, reason: string) {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
    return;
  }

  const safeReason = Buffer.byteLength(reason, 'utf8') > 123 ? 'Connection error' : reason;
  if (isSendableCloseCode(code)) {
    ws.close(code, safeReason);
    return;
  }

  ws.close(1000, safeReason);
}

// Same-origin deep-link back to the Lifecycle session for the branded error page CTA.
function buildEditorSessionDeepLink(request: IncomingMessage, sessionId: string): string {
  const proto =
    (typeof request.headers['x-forwarded-proto'] === 'string' && request.headers['x-forwarded-proto']) ||
    ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host =
    (typeof request.headers['x-forwarded-host'] === 'string' && request.headers['x-forwarded-host']) ||
    request.headers.host;
  const path = `/new/${encodeURIComponent(sessionId)}`;
  return host ? `${proto}://${host}${path}` : path;
}

function extractEditorFailureContext(error: unknown): EditorProxyFailureContext {
  return error instanceof EditorProxyError ? error.failureContext : {};
}

async function handleSessionWorkspaceEditorHttp(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: Record<string, string | string[] | undefined>
) {
  const match = parseSessionWorkspaceEditorPath(pathname);
  if (!match) {
    return false;
  }

  // rh-2: track this in-flight HTTP proxy as a live connection and cap it.
  const registryToken = {};
  let registered = false;

  try {
    const queryToken = typeof query.token === 'string' ? query.token : null;
    const session = await resolveOwnedAgentSession(req, match.sessionId, queryToken);

    // The token only bootstraps the cookie; redirect to the clean URL so the credential never
    // lingers in the address bar or history and code-server's own requests stay cookie-only.
    if (process.env.ENABLE_AUTH === 'true' && queryToken) {
      res.statusCode = 302;
      appendSetCookie(res, buildSessionWorkspaceEditorCookie(req, match.sessionId, queryToken));
      res.setHeader('Location', stripQueryParamsFromRequestUrl(req.url, EDITOR_PROXY_BLOCKED_QUERY_PARAMS));
      res.end();
      return true;
    }

    if (!editorProxyConnections.tryRegister(match.sessionId, registryToken)) {
      throw new EditorProxyError('editor-proxy-capacity');
    }
    registered = true;

    const forwardedPrefix = getSessionWorkspaceEditorCookiePath(match.sessionId);
    const target = await resolveSessionWorkspaceEditorTarget(session, match.forwardPath, query);
    const targetUrl = target.url;
    const proxyHeaders = buildProxyHeaders(req, targetUrl, forwardedPrefix, target.headers, false, target.isRemote);
    await new Promise<void>((resolve, reject) => {
      const proxyReq = requestForTarget(targetUrl)(
        targetUrl,
        {
          method: req.method,
          headers: proxyHeaders,
        },
        (proxyRes) => {
          res.statusCode = proxyRes.statusCode || 502;

          Object.entries(proxyRes.headers).forEach(([key, value]) => {
            const normalizedKey = key.toLowerCase();
            if (HOP_BY_HOP_HEADERS.has(normalizedKey) || value == null || normalizedKey === 'set-cookie') {
              return;
            }

            res.setHeader(key, Array.isArray(value) ? value : value.toString());
          });

          // SECURITY: untrusted remote editor responses must not set cookies on the Lifecycle origin.
          if (!target.isRemote) {
            const upstreamSetCookies = proxyRes.headers['set-cookie'] || [];
            (Array.isArray(upstreamSetCookies) ? upstreamSetCookies : [upstreamSetCookies]).forEach((cookie) => {
              if (cookie) {
                appendSetCookie(res, cookie);
              }
            });
          }

          proxyRes.on('error', reject);
          proxyRes.on('end', () => resolve());
          proxyRes.pipe(res);
        }
      );

      // rh-2: bound the upstream so a half-open code-server can't hang the request; surface as a coded timeout.
      proxyReq.setTimeout(EDITOR_PROXY_TIMEOUT_MS, () => {
        proxyReq.destroy(new EditorProxyError('editor-proxy-timeout'));
      });
      // rh-2: an early client disconnect must abort the upstream request.
      req.on('close', () => proxyReq.destroy());
      proxyReq.on('error', reject);

      if (req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });

    return true;
  } catch (error: any) {
    const ctx = extractEditorFailureContext(error);
    const reason = classifyEditorProxyFailure(error, ctx);
    const mapping = resolveEditorProxyFailureMapping(reason);
    logger.error(
      { error, path: pathname, sessionId: match.sessionId, reason, status: mapping.status },
      `SessionEditor: proxy failed sessionId=${match.sessionId} path=${pathname} reason=${reason}`
    );

    if (!res.headersSent) {
      res.statusCode = mapping.status;
      // err-4: navigation failures get a branded HTML page with a deep-link; assets keep a coded status + plain body.
      if (isEditorNavigationRequest(req.headers)) {
        const sessionUrl = buildEditorSessionDeepLink(req, match.sessionId);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(buildWorkspaceEditorErrorPage({ reason, sessionUrl }));
      } else {
        res.setHeader('X-Editor-Proxy-Reason', reason);
        res.end(mapping.message);
      }
    } else if (!(res as ServerResponse & { writableEnded?: boolean }).writableEnded) {
      res.end();
    }
    return true;
  } finally {
    if (registered) {
      editorProxyConnections.release(match.sessionId, registryToken);
    }
  }
}

async function handleChatPreviewHttp(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: Record<string, string | string[] | undefined>,
  resolvedMatch: ChatPreviewPathMatch | null
) {
  const match = resolvedMatch;
  if (!match) {
    return false;
  }

  const sessionUserId = await resolveChatPreviewSessionUserId(match.sessionId);
  if (!sessionUserId) {
    return false;
  }

  const queryGrant = typeof query.grant === 'string' ? query.grant : null;
  if (!(await isAuthorizedChatPreviewRequest(req, sessionUserId, match, queryGrant))) {
    res.statusCode = 302;
    setNoReferrerPolicy(res);
    res.setHeader('Location', buildChatPreviewAuthRedirectUrl(match, query));
    res.end();
    return true;
  }

  // The grant only bootstraps the cookie. Persist it as a path-scoped or host-scoped cookie, then redirect to the
  // clean URL so the user never sees the credential and all later requests are cookie-only.
  if (process.env.ENABLE_AUTH === 'true' && queryGrant) {
    res.statusCode = 302;
    setNoReferrerPolicy(res);
    appendSetCookie(res, buildChatPreviewCookie(req, queryGrant));
    res.setHeader('Location', stripPreviewBootstrapParams(req.url));
    res.end();
    return true;
  }

  const target = await resolveChatPreviewTarget(match, query);
  if (!target) {
    res.statusCode = 503;
    res.setHeader('X-Preview-Proxy-Reason', 'preview-unavailable');
    res.end('Preview is unavailable');
    return true;
  }

  try {
    const targetUrl = target.url;
    const proxyHeaders = buildProxyHeaders(req, targetUrl, '', target.headers, false, true);
    await new Promise<void>((resolve, reject) => {
      const proxyReq = requestForTarget(targetUrl)(
        targetUrl,
        {
          method: req.method,
          headers: proxyHeaders,
        },
        (proxyRes) => {
          res.statusCode = proxyRes.statusCode || 502;

          Object.entries(proxyRes.headers).forEach(([key, value]) => {
            const normalizedKey = key.toLowerCase();
            if (HOP_BY_HOP_HEADERS.has(normalizedKey) || normalizedKey === 'set-cookie' || value == null) {
              return;
            }

            if (Array.isArray(value)) {
              res.setHeader(
                key,
                value.map((entry) => rewritePreviewResponseHeader(key, entry, targetUrl, req, ''))
              );
            } else {
              res.setHeader(key, rewritePreviewResponseHeader(key, value.toString(), targetUrl, req, ''));
            }
          });

          proxyRes.on('error', reject);
          proxyRes.on('end', () => resolve());
          proxyRes.pipe(res);
        }
      );

      proxyReq.setTimeout(EDITOR_PROXY_TIMEOUT_MS, () => {
        proxyReq.destroy(new Error('preview-proxy-timeout'));
      });
      req.on('close', () => proxyReq.destroy());
      proxyReq.on('error', reject);

      if (req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });

    return true;
  } catch (error) {
    logger.warn({ error, path: pathname, sessionId: match.sessionId, port: match.port }, 'ChatPreview: proxy failed');
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('X-Preview-Proxy-Reason', 'preview-unavailable');
      res.end('Preview is unavailable');
    } else if (!(res as ServerResponse & { writableEnded?: boolean }).writableEnded) {
      res.end();
    }
    return true;
  }
}

async function handleSitesGatewayHttp(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (LIFECYCLE_MODE !== 'gateway' && LIFECYCLE_MODE !== 'all') {
    return false;
  }

  const service = getSitesGatewayService();
  if (!(await service.matchesGatewayHost(req.headers.host))) {
    return false;
  }

  if (!req.method || !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    res.statusCode = 404;
    res.end('not found');
    return true;
  }

  try {
    const object = await service.getGatewayObject(req.headers.host, pathname);

    res.statusCode = object.statusCode;
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength.toString());
    }

    if (req.method.toUpperCase() === 'HEAD') {
      (object.body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      res.end();
      return true;
    }

    object.body.on('error', (error) => {
      logger.error({ error, path: pathname }, 'SitesGateway: stream failed');
      if (!res.headersSent) {
        res.statusCode = 502;
      }
      res.end();
    });
    object.body.pipe(res);
    return true;
  } catch (error: any) {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    logger.warn({ error, path: pathname, statusCode }, 'SitesGateway: request failed');
    res.statusCode = statusCode === 404 ? 404 : 500;
    res.end(statusCode === 404 ? 'not found' : 'internal server error');
    return true;
  }
}

app.prepare().then(() => {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const parsedUrl = parse(req.url!, true);
      const chatPreviewHost = parseChatPreviewHost(req.headers.host);
      if (chatPreviewHost) {
        const chatPreviewHostMatch = await resolveChatPreviewHostPathMatch(req, parsedUrl.pathname || '/');
        if (
          chatPreviewHostMatch &&
          (await handleChatPreviewHttp(
            req,
            res,
            parsedUrl.pathname || '/',
            parsedUrl.query as Record<string, string | string[] | undefined>,
            chatPreviewHostMatch
          ))
        ) {
          return;
        }

        res.statusCode = 404;
        res.setHeader('X-Preview-Proxy-Reason', 'preview-not-found');
        res.end('Preview is unavailable');
        return;
      }
      if (parsedUrl.pathname && (await handleSitesGatewayHttp(req, res, parsedUrl.pathname))) {
        return;
      }
      if (handleMcpHttpRequest && (await handleMcpHttpRequest(req, res, parsedUrl.pathname))) {
        return;
      }
      if (
        parsedUrl.pathname &&
        (await handleSessionWorkspaceEditorHttp(
          req,
          res,
          parsedUrl.pathname,
          parsedUrl.query as Record<string, string | string[] | undefined>
        ))
      ) {
        return;
      }
      await handle(req, res, parsedUrl);
    } catch (err) {
      logger.error({ err }, 'Error handling HTTP request');
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    // A throw here would be an uncaughtException that kills the whole server; drop the socket instead.
    try {
      const { pathname } = parse(request.url!, true);
      const connectionLogCtx = { path: pathname, remoteAddress: request.socket.remoteAddress };

      if (pathname === LOG_STREAM_PATH) {
        logger.debug(connectionLogCtx, 'Handling upgrade request for log stream');
        wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          wss.emit('connection', ws, request);
        });
      } else if (parseSessionWorkspaceEditorPath(pathname)) {
        logger.debug(connectionLogCtx, 'WebSocket: upgrade path=session_workspace_editor');
        void handleSessionWorkspaceEditorUpgrade(request, socket as Socket, head);
      } else if (parseChatPreviewHost(request.headers.host)) {
        logger.debug(connectionLogCtx, 'WebSocket: upgrade path=chat_preview');
        void handleChatPreviewUpgrade(request, socket as Socket, head);
      } else {
        socket.destroy();
      }
    } catch (error) {
      logger.warn({ error, url: request.url }, 'WebSocket: upgrade dispatch failed');
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    let k8sStreamAbort: AbortHandle | null = null;
    let logCtx: Record<string, any> = {
      remoteAddress: request.socket.remoteAddress,
    };

    try {
      const { query } = parse(request.url || '', true);
      const {
        podName,
        namespace,
        containerName,
        follow: followStr,
        tailLines: tailLinesStr,
        timestamps: timestampsStr,
      } = query;

      logCtx = { ...logCtx, podName, namespace, containerName };
      logger.debug(logCtx, 'WebSocket connection established');

      if (
        !podName ||
        !namespace ||
        !containerName ||
        typeof podName !== 'string' ||
        typeof namespace !== 'string' ||
        typeof containerName !== 'string'
      ) {
        throw new Error('Missing or invalid required parameters: podName, namespace, containerName');
      }
      const follow = followStr === 'true';
      const tailLines = tailLinesStr ? parseInt(tailLinesStr as string, 10) : undefined;
      const timestamps = timestampsStr === 'true';
      if (tailLines !== undefined && isNaN(tailLines)) throw new Error('Invalid tailLines parameter.');

      logger.debug(logCtx, 'Initiating K8s log stream');
      k8sStreamAbort = streamK8sLogs(
        { podName, namespace, containerName, follow, tailLines, timestamps },
        {
          onData: (logLine: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'log', payload: logLine }));
            }
          },
          onError: (error: Error) => {
            logger.error({ ...logCtx, err: error }, 'K8s stream error');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: `Kubernetes stream error: ${error.message}` }));
            }
            ws.close(1011, 'Kubernetes stream error');
          },
          onEnd: () => {
            logger.debug(logCtx, 'K8s stream ended');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'end', reason: 'ContainerTerminated' }));
            }
            ws.close(1000, 'Stream ended');
          },
        }
      );
    } catch (error: any) {
      logger.error({ ...logCtx, err: error }, 'WebSocket connection setup error');
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.send(JSON.stringify({ type: 'error', message: `Connection error: ${error.message}` }));
        closeSocket(ws, 1008, `Connection error: ${error.message}`);
      }
      return;
    }

    ws.on('close', (code, reason) => {
      const reasonString = reason instanceof Buffer ? reason.toString() : String(reason);
      logger.debug({ ...logCtx, code, reason: reasonString }, 'WebSocket connection closed by client');
      if (k8sStreamAbort && typeof k8sStreamAbort.abort === 'function') {
        logger.debug(logCtx, 'Aborting log stream due to client close');
        k8sStreamAbort.abort();
        k8sStreamAbort = null;
      }
    });

    ws.on('error', (error) => {
      logger.warn({ ...logCtx, err: error }, 'WebSocket error');
      if (k8sStreamAbort && typeof k8sStreamAbort.abort === 'function') {
        logger.debug(logCtx, 'Aborting log stream due to WebSocket error');
        k8sStreamAbort.abort();
        k8sStreamAbort = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1011, 'WebSocket error');
      }
    });
  });

  httpServer.listen(port);

  // rh-2: log the live editor-proxy connection gauge so leaked sockets surface; unref so it never holds the process.
  const editorProxyGauge = setInterval(() => {
    const live = editorProxyConnections.size();
    if (live > 0) {
      logger.info({ liveEditorProxyConnections: live }, 'SessionEditor: live connection gauge');
    }
  }, 60_000);
  editorProxyGauge.unref();

  httpServer.on('error', (error) => {
    logger.error({ err: error }, 'HTTP Server Error');
    process.exit(1);
  });
});

/**
 * @openapi
 * /api/logs/stream:
 *   get:
 *     summary: Stream Kubernetes pod logs via WebSocket
 *     description: |
 *       Establishes a WebSocket connection to stream real-time logs from a
 *       specified Kubernetes pod container. The client must provide query
 *       parameters identifying the pod, namespace, and container.
 *
 *       The endpoint returns log messages as JSON objects with a type field
 *       indicating the message type (log, error, or end), and additional
 *       fields depending on the message type.
 *
 *       Note: This endpoint requires WebSocket protocol support.
 *     tags:
 *       - Logs
 *     parameters:
 *       - in: query
 *         name: podName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the Kubernetes pod
 *       - in: query
 *         name: namespace
 *         required: true
 *         schema:
 *           type: string
 *         description: The Kubernetes namespace where the pod is located
 *       - in: query
 *         name: containerName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the container within the pod
 *       - in: query
 *         name: follow
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Whether to follow the log stream as new logs are generated
 *       - in: query
 *         name: tailLines
 *         required: false
 *         schema:
 *           type: integer
 *           default: 200
 *         description: Number of lines to retrieve from the end of the logs
 *       - in: query
 *         name: timestamps
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Whether to include timestamps with each log line
 *     responses:
 *       101:
 *         description: WebSocket connection established
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   required:
 *                     - type
 *                     - payload
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [log]
 *                       description: Indicates this is a log message
 *                     payload:
 *                       type: string
 *                       description: The content of the log line
 *                 - type: object
 *                   required:
 *                     - type
 *                     - message
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [error]
 *                       description: Indicates this is an error message
 *                     message:
 *                       type: string
 *                       description: Error message describing what went wrong
 *                 - type: object
 *                   required:
 *                     - type
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [end]
 *                       description: Indicates the log stream has ended
 *                     reason:
 *                       type: string
 *                       description: Reason why the stream ended (e.g., 'ContainerTerminated')
 *             examples:
 *               logMessage:
 *                 value:
 *                   type: "log"
 *                   payload: "2024-04-14T12:34:56.789Z INFO Starting application..."
 *               errorMessage:
 *                 value:
 *                   type: "error"
 *                   message: "Kubernetes stream error: Connection refused"
 *               endMessage:
 *                 value:
 *                   type: "end"
 *                   reason: "ContainerTerminated"
 *       400:
 *         description: Bad request - missing or invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Missing or invalid required parameters: podName, namespace, containerName"
 */

// Usage example:
// Connect to WebSocket using wscat (substitute your host with the appropriate environment):
// wscat -c "wss://<your-host>/api/logs/stream?podName=<pod-name>&namespace=<namespace>&follow=true&tailLines=200&timestamps=true&containerName=<container-name>"
//
// Example messages received from the WebSocket:
// {"type":"log","payload":"2024-04-14T12:34:56.789Z INFO Starting application..."}
// {"type":"error","message":"Kubernetes stream error: Connection refused"}
// {"type":"end","reason":"ContainerTerminated"}

/**
 * @openapi
 * /api/agent-session/workspace-editor/{sessionId}:
 *   get:
 *     summary: Open the workspace editor attached to an active agent session
 *     description: |
 *       Proxies a browser-based VS Code session (code-server) running inside the
 *       session workspace pod. The editor uses the same workspace PVC as the
 *       session workspace.
 *
 *       Authentication follows the agent session ownership rules. The first
 *       request may include a bearer token via the
 *       `Authorization` header or `token` query parameter; the proxy then sets a
 *       session-scoped HTTP-only cookie for follow-up asset and WebSocket
 *       requests under the same path prefix.
 *
 *       All nested paths under this prefix are also proxied to the editor
 *       runtime, including asset requests and WebSocket upgrades required by the
 *       web IDE.
 *     tags:
 *       - Agent Sessions
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: token
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional bearer token used to seed the editor auth cookie.
 *     responses:
 *       '200':
 *         description: Browser editor HTML or proxied editor assets.
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Session not found
 *       '502':
 *         description: Editor runtime unavailable
 */
