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

import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ErrorCode,
  isInitializeRequest,
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { getLogger } from 'server/lib/logger';
import { checkMcpToolRateLimit } from 'server/services/authRateLimit';
import McpConfigService from 'server/services/mcpConfig';
import { authenticateMcpRequest, type McpAuthFailure } from './auth';
import {
  buildProtectedResourceMetadata,
  getMcpResourceUrl,
  MCP_PATH,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
} from './config';
import type { McpToolRegistry } from './registry';
import { createLifecycleMcpServer } from './server';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BATCH_REMOVED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-11-25']);

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
  id?: RequestId
) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, ...(id === undefined ? {} : { id }) }, headers);
}

class BodyTooLargeError extends Error {}

function requestIdFrom(value: unknown): RequestId | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  if (typeof id === 'string') return id;
  return typeof id === 'number' && Number.isInteger(id) ? id : undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    return;
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = buildProtectedResourceMetadata();
  } catch (error) {
    getLogger().error({ error }, 'MCP: protected-resource metadata is not configured');
    sendJson(res, 503, { error: 'mcp_oauth_not_configured' }, { 'Cache-Control': 'no-store' });
    return;
  }

  const headers = { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
    res.end();
    return;
  }
  sendJson(res, 200, metadata, headers);
}

/** Each POST gets a fresh stateless server/transport pair so behavior matches across web replicas. */
async function handleMcpEndpoint(req: IncomingMessage, res: ServerResponse, registry: McpToolRegistry): Promise<void> {
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
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After, X-Request-Id');
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

  if (req.method !== 'POST') {
    // Stateless mode: no server-initiated SSE stream (GET) and no session to delete (DELETE).
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
    return;
  }

  const auth = await authenticateMcpRequest(req);
  if (!auth.ok) {
    // strict:false disables discriminated-union narrowing here
    const failed = auth as McpAuthFailure;
    sendJsonRpcError(res, failed.status, -32001, failed.message, {
      ...(failed.wwwAuthenticate ? { 'WWW-Authenticate': failed.wwwAuthenticate } : {}),
      ...(failed.retryAfterSeconds ? { 'Retry-After': String(failed.retryAfterSeconds) } : {}),
    });
    return;
  }

  const accept = (Array.isArray(req.headers.accept) ? req.headers.accept[0] : req.headers.accept)?.toLowerCase();
  if (!accept?.includes('application/json') || !accept.includes('text/event-stream')) {
    sendJsonRpcError(
      res,
      406,
      -32000,
      'Not Acceptable: client must accept both application/json and text/event-stream.'
    );
    return;
  }
  const contentType = (
    Array.isArray(req.headers['content-type']) ? req.headers['content-type'][0] : req.headers['content-type']
  )
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    sendJsonRpcError(res, 415, -32000, 'Unsupported Media Type: Content-Type must be application/json.');
    return;
  }

  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    parsedBody = text ? JSON.parse(text) : undefined;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJsonRpcError(res, 413, -32000, error.message);
      req.destroy();
      return;
    }
    sendJsonRpcError(
      res,
      400,
      ErrorCode.ParseError,
      `Parse error: ${error instanceof Error ? error.message : 'invalid JSON'}`
    );
    return;
  }

  let parsedMessage: JSONRPCMessage | JSONRPCMessage[];
  if (Array.isArray(parsedBody)) {
    const protocolVersionHeader = Array.isArray(req.headers['mcp-protocol-version'])
      ? req.headers['mcp-protocol-version'][0]
      : req.headers['mcp-protocol-version'];
    if (BATCH_REMOVED_PROTOCOL_VERSIONS.has(protocolVersionHeader ?? '')) {
      sendJsonRpcError(
        res,
        400,
        ErrorCode.InvalidRequest,
        `Invalid Request: protocol ${protocolVersionHeader} does not support JSON-RPC batches.`
      );
      return;
    }
    const parsedBatch = parsedBody.map((message) => JSONRPCMessageSchema.safeParse(message));
    if (
      parsedBatch.length === 0 ||
      parsedBatch.some((result) => !result.success) ||
      parsedBatch.some((result) => result.success && isInitializeRequest(result.data))
    ) {
      sendJsonRpcError(
        res,
        400,
        ErrorCode.InvalidRequest,
        'Invalid Request: expected a non-empty batch of non-initialization JSON-RPC 2.0 messages.'
      );
      return;
    }
    parsedMessage = parsedBatch.map((result) => {
      if (!result.success) throw new Error('unreachable');
      return result.data;
    });
  } else {
    const singleMessage = JSONRPCMessageSchema.safeParse(parsedBody);
    if (!singleMessage.success) {
      sendJsonRpcError(
        res,
        400,
        ErrorCode.InvalidRequest,
        'Invalid Request: expected one JSON-RPC 2.0 message.',
        {},
        requestIdFrom(parsedBody)
      );
      return;
    }
    parsedMessage = singleMessage.data;
  }
  const requestId = `mcp_${randomUUID()}`;
  res.setHeader('X-Request-Id', requestId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createLifecycleMcpServer(
    auth.principal,
    requestId,
    registry,
    () => McpConfigService.getInstance().getRuntimePolicy(),
    () => checkMcpToolRateLimit(auth.principal)
  );

  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, parsedMessage);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/**
 * Entry point wired into ws-server's HTTP handler chain. Returns true when the
 * request was an MCP route and has been fully handled.
 */
export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string | null | undefined,
  registry: McpToolRegistry
): Promise<boolean> {
  if (!pathname) {
    return false;
  }

  const normalized = pathname.replace(/\/+$/, '') || '/';

  if (normalized === MCP_PROTECTED_RESOURCE_METADATA_PATH) {
    serveProtectedResourceMetadata(req, res);
    return true;
  }

  if (normalized !== MCP_PATH) {
    return false;
  }

  try {
    await handleMcpEndpoint(req, res, registry);
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
