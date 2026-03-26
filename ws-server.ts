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
import {
  AgentSessionStartupFailureStage,
  PublicAgentSessionStartupFailure,
  buildAgentSessionStartupFailure,
  toPublicAgentSessionStartupFailure,
} from './src/server/lib/agentSession/startupFailureState';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

// --- Initialize Next.js App ---
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const LOG_STREAM_PATH = '/api/logs/stream'; // Path for WebSocket connections
const AGENT_SESSION_PATH = '/api/agent/session';
const AGENT_EDITOR_PATH_PREFIX = '/api/agent/editor/';
const LEGACY_AGENT_EDITOR_PATH_PREFIX = '/api/v2/ai/agent/sessions/';
const LEGACY_AGENT_EDITOR_PATH_SUFFIX = '/editor';
const AGENT_EDITOR_COOKIE_NAME = 'lfc_agent_editor_auth';
const AGENT_EDITOR_PORT = parseInt(process.env.AGENT_EDITOR_PORT || '13337', 10);
const AGENT_RUNTIME_IDLE_TIMEOUT_MS = parseInt(process.env.AGENT_RUNTIME_IDLE_TIMEOUT_MS || '60000', 10);
const AGENT_EXEC_ATTACH_RETRY_DELAY_MS = parseInt(process.env.AGENT_EXEC_ATTACH_RETRY_DELAY_MS || '500', 10);
const AGENT_EXEC_ATTACH_MAX_ATTEMPTS = parseInt(process.env.AGENT_EXEC_ATTACH_MAX_ATTEMPTS || '20', 10);
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

type AgentExecConnection = {
  write(data: string): void;
  cancel(): void;
  close(): void;
  onStdout(handler: (data: string) => void): void;
  onStderr(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
};

type AgentSessionRuntime = {
  sessionId: string;
  namespace: string;
  podName: string;
  model: string;
  clients: Set<WebSocket>;
  execConn: AgentExecConnection | null;
  parser: { feed(data: string): void } | null;
  startPromise: Promise<void> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  isReady: boolean;
};

const agentSessionRuntimes = new Map<string, AgentSessionRuntime>();

function buildLocalAgentSessionFailure(
  sessionId: string,
  error: unknown,
  stage: AgentSessionStartupFailureStage = 'connect_runtime'
): PublicAgentSessionStartupFailure {
  return toPublicAgentSessionStartupFailure(
    buildAgentSessionStartupFailure({
      sessionId,
      error,
      stage,
    })
  );
}

async function persistAgentRuntimeFailure(
  sessionId: string,
  error: unknown,
  stage: AgentSessionStartupFailureStage = 'connect_runtime'
): Promise<PublicAgentSessionStartupFailure> {
  const AgentSessionService = (await import('./src/server/services/agentSession')).default;
  return AgentSessionService.markSessionRuntimeFailure(sessionId, error, stage);
}

async function resolveAgentSessionFailureForClient(
  sessionId: string | null,
  error: unknown,
  stage: AgentSessionStartupFailureStage = 'connect_runtime'
): Promise<PublicAgentSessionStartupFailure> {
  if (!sessionId) {
    return buildLocalAgentSessionFailure('unknown-session', error, stage);
  }

  const AgentSessionService = (await import('./src/server/services/agentSession')).default;
  const persistedFailure = await AgentSessionService.getSessionStartupFailure(sessionId);

  return persistedFailure || buildLocalAgentSessionFailure(sessionId, error, stage);
}

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

type AgentEditorPathMatch = { sessionId: string; forwardPath: string; isLegacy: boolean };

function parseAgentEditorPath(pathname: string | null | undefined, includeLegacy = true): AgentEditorPathMatch | null {
  const safePathname = pathname || '';
  if (safePathname.startsWith(AGENT_EDITOR_PATH_PREFIX)) {
    const remainder = safePathname.slice(AGENT_EDITOR_PATH_PREFIX.length);
    const slashIndex = remainder.indexOf('/');
    const sessionId = slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder;
    if (!sessionId) {
      return null;
    }

    const forwardPath = slashIndex >= 0 ? remainder.slice(slashIndex) : '/';
    return {
      sessionId: decodeURIComponent(sessionId),
      forwardPath: forwardPath || '/',
      isLegacy: false,
    };
  }

  if (!includeLegacy || !safePathname.startsWith(LEGACY_AGENT_EDITOR_PATH_PREFIX)) {
    return null;
  }

  const editorIndex = safePathname.indexOf(LEGACY_AGENT_EDITOR_PATH_SUFFIX, LEGACY_AGENT_EDITOR_PATH_PREFIX.length);
  if (editorIndex < 0) {
    return null;
  }

  const sessionId = safePathname.slice(LEGACY_AGENT_EDITOR_PATH_PREFIX.length, editorIndex);
  if (!sessionId) {
    return null;
  }

  const remainder = safePathname.slice(editorIndex + LEGACY_AGENT_EDITOR_PATH_SUFFIX.length);
  return {
    sessionId: decodeURIComponent(sessionId),
    forwardPath: remainder ? (remainder.startsWith('/') ? remainder : `/${remainder}`) : '/',
    isLegacy: true,
  };
}

function getAgentEditorCookiePath(sessionId: string): string {
  return `${AGENT_EDITOR_PATH_PREFIX}${encodeURIComponent(sessionId)}`;
}

function getAgentEditorRequestPath(sessionId: string, forwardPath = '/'): string {
  const normalizedForwardPath =
    !forwardPath || forwardPath === '/' ? '/' : forwardPath.startsWith('/') ? forwardPath : `/${forwardPath}`;

  return `${getAgentEditorCookiePath(sessionId)}${normalizedForwardPath}`;
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

function buildAgentEditorCookie(request: IncomingMessage, sessionId: string, token: string): string {
  const isSecure =
    request.headers['x-forwarded-proto'] === 'https' || (request.socket as { encrypted?: boolean }).encrypted === true;
  const cookieParts = [
    `${AGENT_EDITOR_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${getAgentEditorCookiePath(sessionId)}`,
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

function buildAgentEditorServiceUrl(
  session: { id: string; podName: string; namespace: string },
  forwardPath: string,
  query: Record<string, string | string[] | undefined>,
  isWebSocket = false
) {
  const protocol = isWebSocket ? 'ws' : 'http';
  const target = new URL(
    `${protocol}://${session.podName}.${session.namespace}.svc.cluster.local:${AGENT_EDITOR_PORT}${forwardPath}`
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
    const cookieToken = parseCookieHeader(request.headers.cookie)[AGENT_EDITOR_COOKIE_NAME];
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
  ws.close(code, safeReason);
}

function buildClaudeUserMessage(content: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  })}\n`;
}

function broadcastAgentMessage(runtime: AgentSessionRuntime, payload: Record<string, unknown>) {
  const message = JSON.stringify(payload);
  for (const client of runtime.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function notifyAgentClientReady(runtime: AgentSessionRuntime, client: WebSocket, attempt = 0) {
  if (!runtime.clients.has(client)) {
    return;
  }

  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({ type: 'status', status: 'ready' }));
    return;
  }

  if (attempt >= 5) {
    return;
  }

  setTimeout(() => {
    notifyAgentClientReady(runtime, client, attempt + 1);
  }, 100);
}

function clearAgentRuntimeIdleTimer(runtime: AgentSessionRuntime) {
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }
}

function closeAgentClients(runtime: AgentSessionRuntime, code: number, reason: string) {
  for (const client of Array.from(runtime.clients)) {
    runtime.clients.delete(client);
    closeSocket(client, code, reason);
  }
}

function disposeAgentRuntime(sessionId: string, runtime: AgentSessionRuntime, closeExec: boolean) {
  clearAgentRuntimeIdleTimer(runtime);
  runtime.isReady = false;
  runtime.parser = null;
  runtime.startPromise = null;
  agentSessionRuntimes.delete(sessionId);

  if (closeExec && runtime.execConn) {
    const execConn = runtime.execConn;
    runtime.execConn = null;
    execConn.close();
    return;
  }

  runtime.execConn = null;
}

function scheduleAgentRuntimeCleanup(
  sessionId: string,
  runtime: AgentSessionRuntime,
  agentLogCtx: Record<string, unknown>
) {
  if (agentSessionRuntimes.get(sessionId) !== runtime || runtime.clients.size > 0) {
    return;
  }

  clearAgentRuntimeIdleTimer(runtime);
  runtime.idleTimer = setTimeout(() => {
    const currentRuntime = agentSessionRuntimes.get(sessionId);
    if (currentRuntime !== runtime || runtime.clients.size > 0) {
      return;
    }

    logger.debug(agentLogCtx, 'Closing idle agent runtime after client disconnect');
    disposeAgentRuntime(sessionId, runtime, true);
  }, AGENT_RUNTIME_IDLE_TIMEOUT_MS);
}

async function getOrCreateAgentRuntime(
  sessionId: string,
  namespace: string,
  podName: string,
  model: string,
  appendSystemPrompt: string | undefined,
  agentLogCtx: Record<string, unknown>
): Promise<AgentSessionRuntime> {
  let runtime = agentSessionRuntimes.get(sessionId);

  if (runtime && (runtime.namespace !== namespace || runtime.podName !== podName)) {
    disposeAgentRuntime(sessionId, runtime, true);
    runtime = undefined;
  }

  if (!runtime) {
    runtime = {
      sessionId,
      namespace,
      podName,
      model,
      clients: new Set<WebSocket>(),
      execConn: null,
      parser: null,
      startPromise: null,
      idleTimer: null,
      isReady: false,
    };
    agentSessionRuntimes.set(sessionId, runtime);
  }

  clearAgentRuntimeIdleTimer(runtime);

  if (runtime.execConn) {
    return runtime;
  }

  if (!runtime.startPromise) {
    runtime.startPromise = (async () => {
      const { attachToAgentPod } = await import('./src/server/lib/agentSession/execProxy');
      const { JsonlParser } = await import('./src/server/lib/agentSession/jsonlParser');

      const execConn = (await attachToAgentPodWithRetry(
        attachToAgentPod,
        namespace,
        podName,
        model,
        appendSystemPrompt,
        agentLogCtx
      )) as AgentExecConnection;
      runtime!.execConn = execConn;
      runtime!.parser = new JsonlParser((msg) => {
        broadcastAgentMessage(runtime!, msg as Record<string, unknown>);
      });
      runtime!.isReady = true;

      execConn.onStdout((data: string) => {
        runtime?.parser?.feed(data);
      });

      execConn.onStderr((data: string) => {
        broadcastAgentMessage(runtime!, { type: 'chunk', content: data });
      });

      execConn.onClose(() => {
        if (agentSessionRuntimes.get(sessionId) !== runtime) {
          return;
        }

        logger.debug(agentLogCtx, 'Agent exec connection closed');
        closeAgentClients(runtime!, 1012, 'Agent runtime restarted');
        disposeAgentRuntime(sessionId, runtime!, false);
      });

      execConn.onError((err: Error) => {
        if (agentSessionRuntimes.get(sessionId) !== runtime) {
          return;
        }

        logger.error({ ...agentLogCtx, err }, 'Agent exec error');
        const failure = buildLocalAgentSessionFailure(sessionId, err);
        void persistAgentRuntimeFailure(sessionId, err).catch((persistError) => {
          logger.warn({ ...agentLogCtx, err: persistError }, 'Failed to persist agent runtime failure');
        });
        broadcastAgentMessage(runtime!, {
          type: 'status',
          status: 'error',
          title: failure.title,
          message: failure.message,
        });
        closeAgentClients(runtime!, 1011, 'Agent exec error');
        disposeAgentRuntime(sessionId, runtime!, false);
      });

      broadcastAgentMessage(runtime!, { type: 'status', status: 'ready' });
    })()
      .catch(async (error) => {
        await persistAgentRuntimeFailure(sessionId, error).catch((persistError) => {
          logger.warn({ ...agentLogCtx, err: persistError }, 'Failed to persist agent runtime failure');
        });
        disposeAgentRuntime(sessionId, runtime!, true);
        throw error;
      })
      .finally(() => {
        if (runtime) {
          runtime.startPromise = null;
        }
      });
  }

  await runtime.startPromise;
  return runtime;
}

async function attachToAgentPodWithRetry(
  attachToAgentPod: (
    namespace: string,
    podName: string,
    model: string,
    container?: string,
    appendSystemPrompt?: string
  ) => Promise<AgentExecConnection>,
  namespace: string,
  podName: string,
  model: string,
  appendSystemPrompt: string | undefined,
  agentLogCtx: Record<string, unknown>
): Promise<AgentExecConnection> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= AGENT_EXEC_ATTACH_MAX_ATTEMPTS; attempt++) {
    try {
      return await attachToAgentPod(namespace, podName, model, undefined, appendSystemPrompt);
    } catch (error: any) {
      lastError = error;

      if (attempt === AGENT_EXEC_ATTACH_MAX_ATTEMPTS) {
        break;
      }

      logger.warn(
        {
          ...agentLogCtx,
          attempt,
          maxAttempts: AGENT_EXEC_ATTACH_MAX_ATTEMPTS,
          err: error,
        },
        'Agent exec attach failed; retrying while pod becomes ready'
      );

      await new Promise((resolve) => setTimeout(resolve, AGENT_EXEC_ATTACH_RETRY_DELAY_MS));
    }
  }

  throw lastError ?? new Error('Failed to attach to agent pod');
}

async function handleAgentEditorHttp(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: Record<string, string | string[] | undefined>
) {
  const match = parseAgentEditorPath(pathname);
  if (!match) {
    return false;
  }

  if (match.isLegacy) {
    const target = new URL(pathname, 'http://placeholder');
    target.pathname = getAgentEditorRequestPath(match.sessionId, match.forwardPath);
    for (const [key, value] of Object.entries(query)) {
      if (value == null) {
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => target.searchParams.append(key, item));
      } else {
        target.searchParams.set(key, value);
      }
    }

    res.statusCode = 307;
    res.setHeader('Location', `${target.pathname}${target.search}`);
    res.end();
    return true;
  }

  try {
    const queryToken = typeof query.token === 'string' ? query.token : null;
    const session = await resolveOwnedAgentSession(req, match.sessionId, queryToken);
    const forwardedPrefix = getAgentEditorCookiePath(match.sessionId);
    const targetUrl = buildAgentEditorServiceUrl(session, match.forwardPath, query);
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
            appendSetCookie(res, buildAgentEditorCookie(req, match.sessionId, queryToken));
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
    logger.error({ err: error, path: pathname, sessionId: match.sessionId }, 'Agent editor proxy request failed');
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
        (await handleAgentEditorHttp(
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
    } else if (parseAgentEditorPath(pathname, false)) {
      logger.debug(connectionLogCtx, 'Handling upgrade request for agent editor');
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('agent-editor', ws, request);
      });
    } else if (pathname?.startsWith(AGENT_SESSION_PATH)) {
      logger.debug(connectionLogCtx, 'Handling upgrade request for agent session');
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('agent-session', ws, request);
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
    const match = parseAgentEditorPath(parsedUrl.pathname, false);
    const editorLogCtx: Record<string, unknown> = {
      remoteAddress: request.socket.remoteAddress,
      path: parsedUrl.pathname,
    };

    if (!match) {
      closeSocket(ws, 1008, 'Invalid editor path');
      return;
    }

    let upstream: WebSocket | null = null;

    try {
      const queryToken = typeof parsedUrl.query.token === 'string' ? parsedUrl.query.token : null;
      const session = await resolveOwnedAgentSession(request, match.sessionId, queryToken);
      const forwardedPrefix = getAgentEditorCookiePath(match.sessionId);
      const targetUrl = buildAgentEditorServiceUrl(
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

        const closeReason = reason?.toString();
        if (isSendableCloseCode(code)) {
          upstream.close(code, closeReason);
        } else {
          upstream.close();
        }
      };

      ws.on('message', (data, isBinary) => {
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        }
      });

      ws.on('close', (code, reason) => {
        closeUpstream(code, reason);
      });

      ws.on('error', (error) => {
        logger.warn({ ...editorLogCtx, err: error }, 'Agent editor client WebSocket error');
        closeUpstream(1011, Buffer.from('Client WebSocket error'));
      });

      upstream.on('message', (data, isBinary) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data, { binary: isBinary });
        }
      });

      upstream.on('close', (code, reason) => {
        closeSocket(ws, code === 1005 ? 1000 : code, reason.toString() || 'Editor connection closed');
      });

      upstream.on('error', (error) => {
        logger.warn({ ...editorLogCtx, err: error }, 'Agent editor upstream WebSocket error');
        closeSocket(ws, 1011, 'Editor upstream error');
      });

      upstream.on('unexpected-response', (_req, response) => {
        logger.warn(
          { ...editorLogCtx, statusCode: response.statusCode },
          'Agent editor upstream WebSocket rejected the upgrade'
        );
        closeSocket(ws, 1011, 'Editor upgrade rejected');
      });
    } catch (error: any) {
      logger.error({ ...editorLogCtx, err: error, sessionId: match.sessionId }, 'Agent editor WebSocket setup error');
      closeSocket(ws, 1008, `Connection error: ${error.message}`);
      if (upstream && upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    }
  });

  wss.on('agent-session', async (ws: WebSocket, request: IncomingMessage) => {
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let runtime: AgentSessionRuntime | null = null;
    let sessionId: string | null = null;
    const agentLogCtx: Record<string, any> = { remoteAddress: request.socket.remoteAddress };

    const cleanupLocal = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };

    try {
      const { query } = parse(request.url || '', true);
      const { sessionId: sessionIdFromQuery, token: tokenFromQuery } = query;

      if (!sessionIdFromQuery || typeof sessionIdFromQuery !== 'string') {
        throw new Error('Missing required parameter: sessionId');
      }

      sessionId = sessionIdFromQuery;
      const activeSessionId = sessionIdFromQuery;
      agentLogCtx.sessionId = activeSessionId;
      const AgentSessionService = (await import('./src/server/services/agentSession')).default;

      const session = await resolveOwnedAgentSession(
        request,
        activeSessionId,
        typeof tokenFromQuery === 'string' ? tokenFromQuery : null
      );
      const appendSystemPrompt = await AgentSessionService.getSessionAppendSystemPrompt(activeSessionId);

      agentLogCtx.podName = session.podName;
      agentLogCtx.namespace = session.namespace;
      logger.debug(agentLogCtx, 'Agent session WebSocket connected');

      runtime = await getOrCreateAgentRuntime(
        activeSessionId,
        session.namespace,
        session.podName,
        session.model,
        appendSystemPrompt,
        agentLogCtx
      );

      if (runtime.clients.size > 0) {
        closeAgentClients(runtime, 1000, 'Superseded by a new connection');
      }

      runtime.clients.add(ws);

      if (runtime.isReady) {
        notifyAgentClientReady(runtime, ws);
      }

      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
        }
      }, 15_000);

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          await AgentSessionService.touchActivity(activeSessionId);

          switch (msg.type) {
            case 'message':
              if (runtime?.execConn && msg.content) {
                runtime.execConn.write(buildClaudeUserMessage(msg.content));
              }
              break;
            case 'cancel':
              if (runtime?.execConn) {
                runtime.execConn.cancel();
              }
              break;
            case 'set_model':
              if (runtime?.execConn && msg.model) {
                runtime.execConn.write(buildClaudeUserMessage(`/model ${msg.model}`));
              }
              break;
            default:
              logger.debug({ ...agentLogCtx, msgType: msg.type }, 'Unknown client message type');
          }
        } catch (err) {
          logger.warn({ ...agentLogCtx, err }, 'Failed to process client message');
        }
      });

      ws.on('close', (code, reason) => {
        const reasonString = reason instanceof Buffer ? reason.toString() : String(reason);
        logger.debug({ ...agentLogCtx, code, reason: reasonString }, 'Agent WebSocket closed by client');
        cleanupLocal();
        if (runtime && sessionId) {
          runtime.clients.delete(ws);
          scheduleAgentRuntimeCleanup(sessionId, runtime, agentLogCtx);
        }
      });

      ws.on('error', (error) => {
        logger.warn({ ...agentLogCtx, err: error }, 'Agent WebSocket error');
        cleanupLocal();
        if (runtime && sessionId) {
          runtime.clients.delete(ws);
          scheduleAgentRuntimeCleanup(sessionId, runtime, agentLogCtx);
        }
      });
    } catch (error: any) {
      logger.error({ ...agentLogCtx, err: error }, 'Agent session WebSocket setup error');
      cleanupLocal();
      if (runtime && sessionId) {
        runtime.clients.delete(ws);
        scheduleAgentRuntimeCleanup(sessionId, runtime, agentLogCtx);
      }
      const failure = await resolveAgentSessionFailureForClient(sessionId, error);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.send(
          JSON.stringify({
            type: 'status',
            status: 'error',
            title: failure.title,
            message: failure.message,
          })
        );
        closeSocket(ws, 1008, `${failure.title}: ${failure.message}`);
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
 * /api/v2/ai/agent/sessions/{sessionId}/editor:
 *   get:
 *     summary: Open the browser editor attached to an active agent session
 *     description: |
 *       Proxies a browser-based VS Code session (code-server) running inside the
 *       agent session pod. The editor uses the same workspace PVC as the agent.
 *
 *       Authentication follows the same session ownership rules as the agent
 *       WebSocket. The first request may include a bearer token via the
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
