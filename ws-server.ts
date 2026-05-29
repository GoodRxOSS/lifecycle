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
import type { Socket } from 'net';
import { parse, URL } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { rootLogger } from './src/server/lib/logger';
import { LIFECYCLE_MODE } from './src/shared/config';
import { streamK8sLogs, AbortHandle } from './src/server/lib/k8sStreamer';
import SitesService from './src/server/services/sites';
import {
  buildWorkspaceEditorProxyHeaders,
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
let sitesGatewayService: SitesService | null = null;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
function parseCookieHeader(cookieHeader: string | string[] | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  return raw.split(';').reduce<Record<string, string>>((cookies, entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 0) {
      return cookies;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!key) {
      return cookies;
    }

    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

type SessionWorkspaceEditorPathMatch = { sessionId: string; forwardPath: string };

function getSitesGatewayService(): SitesService {
  if (!sitesGatewayService) {
    sitesGatewayService = new SitesService();
  }

  return sitesGatewayService;
}

function parseSessionWorkspaceEditorPath(pathname: string | null | undefined): SessionWorkspaceEditorPathMatch | null {
  const safePathname = pathname || '';
  if (safePathname.startsWith(SESSION_WORKSPACE_EDITOR_PATH_PREFIX)) {
    const remainder = safePathname.slice(SESSION_WORKSPACE_EDITOR_PATH_PREFIX.length);
    const slashIndex = remainder.indexOf('/');
    const sessionId = slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder;
    if (!sessionId) {
      return null;
    }

    const forwardPath = slashIndex >= 0 ? remainder.slice(slashIndex) : '/';
    return {
      sessionId: decodeURIComponent(sessionId),
      forwardPath: forwardPath || '/',
    };
  }
  return null;
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

  for (const [key, value] of Object.entries(query)) {
    if (key === 'token' || value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => target.searchParams.append(key, item));
      continue;
    }

    target.searchParams.set(key, value);
  }

  return target;
}

function buildProxyHeaders(request: IncomingMessage, target: URL, forwardedPrefix: string): Record<string, string> {
  return buildWorkspaceEditorProxyHeaders({
    requestHeaders: request.headers,
    targetHost: target.host,
    forwardedHost: request.headers.host || target.host,
    forwardedProto:
      (typeof request.headers['x-forwarded-proto'] === 'string' && request.headers['x-forwarded-proto']) ||
      ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'),
    forwardedPrefix,
    remoteAddress: request.socket.remoteAddress,
  });
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
    const targetUrl = buildSessionWorkspaceEditorServiceUrl(
      session,
      match.forwardPath,
      parsedUrl.query as Record<string, string | string[] | undefined>
    );
    const proxyHeaders = buildWorkspaceEditorProxyHeaders({
      requestHeaders: request.headers,
      targetHost: targetUrl.host,
      forwardedHost: request.headers.host || targetUrl.host,
      forwardedProto:
        (typeof request.headers['x-forwarded-proto'] === 'string' && request.headers['x-forwarded-proto']) ||
        ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'),
      forwardedPrefix,
      remoteAddress: request.socket.remoteAddress,
      includeUpgradeHeaders: true,
    });

    await new Promise<void>((resolve, reject) => {
      proxyReq = httpRequest(targetUrl, {
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
            headers: upstreamRes.headers,
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

    if (!editorProxyConnections.tryRegister(match.sessionId, registryToken)) {
      throw new EditorProxyError('editor-proxy-capacity');
    }
    registered = true;

    const forwardedPrefix = getSessionWorkspaceEditorCookiePath(match.sessionId);
    const targetUrl = buildSessionWorkspaceEditorServiceUrl(session, match.forwardPath, query);
    const proxyHeaders = buildProxyHeaders(req, targetUrl, forwardedPrefix);
    await new Promise<void>((resolve, reject) => {
      const proxyReq = httpRequest(
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

          const upstreamSetCookies = proxyRes.headers['set-cookie'] || [];
          (Array.isArray(upstreamSetCookies) ? upstreamSetCookies : [upstreamSetCookies]).forEach((cookie) => {
            if (cookie) {
              appendSetCookie(res, cookie);
            }
          });

          if (process.env.ENABLE_AUTH === 'true' && queryToken) {
            appendSetCookie(res, buildSessionWorkspaceEditorCookie(req, match.sessionId, queryToken));
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
      if (parsedUrl.pathname && (await handleSitesGatewayHttp(req, res, parsedUrl.pathname))) {
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
    } else {
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
