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

import { nanoid } from 'nanoid';
import type { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getLogger } from 'server/lib/logger';
import { authenticateMcpRequest, buildWwwAuthenticate, type McpAuthFailure } from './auth';
import {
  buildProtectedResourceMetadata,
  getMcpResourceUrl,
  isMcpServerEnabled,
  MCP_PATH,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
  MCP_PROTECTED_RESOURCE_METADATA_ROOT_PATH,
} from './config';
import { createLifecycleMcpServer } from './server';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 200;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface McpSession {
  transport: StreamableHTTPServerTransport;
  userSub: string;
  lastActivityAt: number;
}

const sessions = new Map<string, McpSession>();
let sweepTimer: NodeJS.Timeout | null = null;

function ensureSweeper() {
  if (sweepTimer) {
    return;
  }

  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [sessionId, session] of sessions) {
      if (session.lastActivityAt < cutoff) {
        sessions.delete(sessionId);
        session.transport.close().catch(() => undefined);
        getLogger().info(`MCP: evicted idle session ${sessionId}`);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>
) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Native MCP clients send no Origin header; browser-based callers must match the app's
 * own origin or the configured CORS allowlist (DNS-rebinding protection per the
 * Streamable HTTP transport spec).
 */
function isOriginAllowed(req: IncomingMessage): boolean {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin) {
    return true;
  }

  const allowed = new Set(
    (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

  try {
    allowed.add(new URL(getMcpResourceUrl()).origin);
  } catch {
    // ignore malformed resource URL; env-validated elsewhere
  }

  return allowed.has(origin);
}

function serveProtectedResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    return;
  }

  sendJson(res, 200, buildProtectedResourceMetadata(), {
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });
}

async function handleMcpEndpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (!isOriginAllowed(req)) {
    sendJsonRpcError(res, 403, -32000, 'Origin not allowed');
    return;
  }

  const auth = await authenticateMcpRequest(req);
  if (!auth.ok) {
    // strict:false disables discriminated-union narrowing here
    const failed = auth as McpAuthFailure;
    sendJsonRpcError(res, failed.status, -32001, failed.message, { 'WWW-Authenticate': failed.wwwAuthenticate });
    return;
  }

  let parsedBody: unknown;
  if (req.method === 'POST') {
    try {
      const raw = await readBody(req);
      parsedBody = raw ? JSON.parse(raw) : undefined;
    } catch (error) {
      sendJsonRpcError(res, 400, -32700, `Parse error: ${error instanceof Error ? error.message : 'invalid JSON'}`);
      return;
    }
  }

  const sessionIdHeader = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

  if (sessionId) {
    const session = sessions.get(sessionId);
    // Unknown or foreign sessions both surface as 404 so the client transparently re-initializes.
    if (!session || session.userSub !== auth.identity.userId) {
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }

    session.lastActivityAt = Date.now();
    await session.transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
    sendJsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID provided', {
      'WWW-Authenticate': buildWwwAuthenticate(),
    });
    return;
  }

  if (sessions.size >= MAX_SESSIONS) {
    sendJsonRpcError(res, 503, -32000, 'Too many active MCP sessions; retry shortly');
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => nanoid(32),
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, { transport, userSub: auth.identity.userId, lastActivityAt: Date.now() });
      getLogger().info(`MCP: session ${newSessionId} initialized user=${auth.identity.userId}`);
    },
    onsessionclosed: (closedSessionId) => {
      sessions.delete(closedSessionId);
      getLogger().info(`MCP: session ${closedSessionId} closed`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  ensureSweeper();
  const server = createLifecycleMcpServer(auth.identity);
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

/**
 * Entry point wired into ws-server's HTTP handler chain. Returns true when the
 * request was an MCP route and has been fully handled.
 */
export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string | null | undefined
): Promise<boolean> {
  if (!isMcpServerEnabled() || !pathname) {
    return false;
  }

  const normalized = pathname.replace(/\/+$/, '') || '/';

  if (normalized === MCP_PROTECTED_RESOURCE_METADATA_PATH || normalized === MCP_PROTECTED_RESOURCE_METADATA_ROOT_PATH) {
    serveProtectedResourceMetadata(req, res);
    return true;
  }

  if (normalized !== MCP_PATH) {
    return false;
  }

  try {
    await handleMcpEndpoint(req, res);
  } catch (error) {
    getLogger().error({ error }, 'MCP: unhandled request error');
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, 'Internal server error');
    } else {
      res.end();
    }
  }

  return true;
}

/** Test-only helper. */
export function __resetMcpSessions(): void {
  for (const session of sessions.values()) {
    session.transport.close().catch(() => undefined);
  }
  sessions.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
