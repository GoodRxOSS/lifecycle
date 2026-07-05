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

import type { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getLogger } from 'server/lib/logger';
import { authenticateMcpRequest, type McpAuthFailure } from './auth';
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

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop consuming but keep the socket writable so the 413 can reach the client.
        req.pause();
        req.removeAllListeners('data');
        reject(new BodyTooLargeError('Request body exceeds the 4MB limit'));
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

/**
 * Each POST is served by a fresh, stateless server/transport pair. The web deployment
 * runs multiple replicas behind a load balancer without session affinity, so per-pod
 * session state would 404 whenever consecutive requests land on different pods (and the
 * 2026-07-28 MCP revision drops sessions from the core protocol anyway).
 */
async function handleMcpEndpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isOriginAllowed(req)) {
    sendJsonRpcError(res, 403, -32000, 'Origin not allowed');
    return;
  }

  // Only ever reflect an allowlisted origin, and do so on every response (not just
  // the preflight) so browser-based clients can actually read the results.
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const auth = await authenticateMcpRequest(req);
  if (!auth.ok) {
    // strict:false disables discriminated-union narrowing here
    const failed = auth as McpAuthFailure;
    sendJsonRpcError(res, failed.status, -32001, failed.message, { 'WWW-Authenticate': failed.wwwAuthenticate });
    return;
  }

  if (req.method !== 'POST') {
    // Stateless mode: no server-initiated SSE stream (GET) and no session to delete (DELETE).
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
    return;
  }

  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJsonRpcError(res, 413, -32000, error.message);
      req.destroy();
      return;
    }
    sendJsonRpcError(res, 400, -32700, `Parse error: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createLifecycleMcpServer(auth.identity);
  res.on('close', () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });

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
