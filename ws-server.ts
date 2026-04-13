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

import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from 'http';
import { parse, URL } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { rootLogger } from './src/server/lib/logger';
import { streamK8sLogs, AbortHandle } from './src/server/lib/k8sStreamer';

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
const SESSION_WORKSPACE_EDITOR_HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.AGENT_SESSION_WORKSPACE_EDITOR_HEARTBEAT_INTERVAL_MS || '15000',
  10
);
const logger = rootLogger.child({ filename: __filename });
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
  const cookieParts = [
    `${SESSION_WORKSPACE_EDITOR_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${getSessionWorkspaceEditorCookiePath(sessionId)}`,
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
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (value == null) {
      continue;
    }

    const normalizedKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedKey) || normalizedKey === 'host' || normalizedKey === 'content-length') {
      continue;
    }

    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers.host = target.host;
  headers['x-forwarded-host'] = request.headers.host || target.host;
  headers['x-forwarded-proto'] =
    (typeof request.headers['x-forwarded-proto'] === 'string' && request.headers['x-forwarded-proto']) ||
    ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  headers['x-forwarded-prefix'] = forwardedPrefix;

  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress) {
    headers['x-forwarded-for'] = request.headers['x-forwarded-for']
      ? `${request.headers['x-forwarded-for']}, ${remoteAddress}`
      : remoteAddress;
  }

  return headers;
}

async function resolveOwnedAgentSession(
  request: IncomingMessage,
  sessionId: string,
  queryToken?: string | null
): Promise<any> {
  const AgentSessionService = (await import('./src/server/services/agentSession')).default;
  const session = await AgentSessionService.getSession(sessionId);
  if (!session || session.status !== 'active') {
    throw new Error('Session not found or not active');
  }

  if (process.env.ENABLE_AUTH === 'true') {
    const headerToken = request.headers.authorization?.split(' ')[1];
    const cookieToken = parseCookieHeader(request.headers.cookie)[SESSION_WORKSPACE_EDITOR_COOKIE_NAME];
    const rawToken = headerToken || cookieToken || queryToken;

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

function normalizeWebSocketCloseReason(reason?: Buffer | string): string | undefined {
  if (!reason) {
    return undefined;
  }

  const value = typeof reason === 'string' ? reason : reason.toString();
  const trimmed = value.trim();
  return trimmed || undefined;
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

  try {
    const queryToken = typeof query.token === 'string' ? query.token : null;
    const session = await resolveOwnedAgentSession(req, match.sessionId, queryToken);
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

      proxyReq.on('error', reject);

      if (req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });

    return true;
  } catch (error: any) {
    logger.error(
      { error, path: pathname, sessionId: match.sessionId },
      `SessionEditor: proxy failed sessionId=${match.sessionId} path=${pathname}`
    );
    res.statusCode =
      error?.message?.includes('Forbidden') || error?.message?.includes('Authentication')
        ? 401
        : error?.message?.includes('Session not found')
        ? 404
        : 502;
    res.end(error?.message || 'Editor proxy failed');
    return true;
  }
}

app.prepare().then(() => {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const parsedUrl = parse(req.url!, true);
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
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('agent-editor', ws, request);
      });
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

  wss.on('agent-editor', async (ws: WebSocket, request: IncomingMessage) => {
    const parsedUrl = parse(request.url || '', true);
    const match = parseSessionWorkspaceEditorPath(parsedUrl.pathname);
    const editorLogCtx: Record<string, unknown> = {
      remoteAddress: request.socket.remoteAddress,
      path: parsedUrl.pathname,
    };

    if (!match) {
      closeSocket(ws, 1008, 'Invalid editor path');
      return;
    }

    let upstream: WebSocket | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    try {
      const queryToken = typeof parsedUrl.query.token === 'string' ? parsedUrl.query.token : null;
      const session = await resolveOwnedAgentSession(request, match.sessionId, queryToken);
      const forwardedPrefix = getSessionWorkspaceEditorCookiePath(match.sessionId);
      const targetUrl = buildSessionWorkspaceEditorServiceUrl(
        session,
        match.forwardPath,
        parsedUrl.query as Record<string, string | string[] | undefined>,
        true
      );
      const protocols =
        typeof request.headers['sec-websocket-protocol'] === 'string'
          ? request.headers['sec-websocket-protocol']
              .split(',')
              .map((protocol) => protocol.trim())
              .filter(Boolean)
          : undefined;

      upstream = new WebSocket(targetUrl, protocols, {
        headers: buildProxyHeaders(request, targetUrl, forwardedPrefix),
      });

      const closeUpstream = (code?: number, reason?: Buffer) => {
        if (!upstream || upstream.readyState === WebSocket.CLOSING || upstream.readyState === WebSocket.CLOSED) {
          return;
        }

        const closeReason = normalizeWebSocketCloseReason(reason);
        if (isSendableCloseCode(code)) {
          upstream.close(code, closeReason);
        } else {
          upstream.close();
        }
      };

      const clearHeartbeat = () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
      };

      const logEditorClose = (source: 'client' | 'upstream', code: number, reason?: Buffer | string) => {
        logger.info(
          {
            ...editorLogCtx,
            source,
            sessionId: match.sessionId,
            code,
            reason: normalizeWebSocketCloseReason(reason),
          },
          `SessionEditor: websocket closed source=${source} sessionId=${match.sessionId} code=${code}`
        );
      };

      if (SESSION_WORKSPACE_EDITOR_HEARTBEAT_INTERVAL_MS > 0) {
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
          if (upstream?.readyState === WebSocket.OPEN) {
            upstream.ping();
          }
        }, SESSION_WORKSPACE_EDITOR_HEARTBEAT_INTERVAL_MS);
      }

      ws.on('message', (data, isBinary) => {
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        }
      });

      ws.on('close', (code, reason) => {
        clearHeartbeat();
        logEditorClose('client', code, reason);
        closeUpstream(code, reason);
      });

      ws.on('error', (error) => {
        clearHeartbeat();
        logger.warn(
          { ...editorLogCtx, error },
          `SessionEditor: websocket error source=client sessionId=${match.sessionId}`
        );
        closeUpstream(1011, Buffer.from('Client WebSocket error'));
      });

      upstream.on('message', (data, isBinary) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data, { binary: isBinary });
        }
      });

      upstream.on('close', (code, reason) => {
        clearHeartbeat();
        logEditorClose('upstream', code, reason);
        closeSocket(
          ws,
          code === 1005 ? 1000 : code,
          normalizeWebSocketCloseReason(reason) || 'Editor connection closed'
        );
      });

      upstream.on('error', (error) => {
        clearHeartbeat();
        logger.warn(
          { ...editorLogCtx, error },
          `SessionEditor: websocket error source=upstream sessionId=${match.sessionId}`
        );
        closeSocket(ws, 1011, 'Editor upstream error');
      });

      upstream.on('unexpected-response', (_req, response) => {
        clearHeartbeat();
        logger.warn(
          { ...editorLogCtx, statusCode: response.statusCode },
          `SessionEditor: upgrade rejected sessionId=${match.sessionId} statusCode=${response.statusCode}`
        );
        closeSocket(ws, 1011, 'Editor upgrade rejected');
      });
    } catch (error: any) {
      logger.error(
        { ...editorLogCtx, error, sessionId: match.sessionId },
        `SessionEditor: websocket setup failed sessionId=${match.sessionId}`
      );
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      closeSocket(ws, 1008, `Connection error: ${error.message}`);
      if (upstream && upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    }
  });

  httpServer.listen(port);

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
