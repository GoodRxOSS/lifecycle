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

const mockAuthenticateMcpRequest = jest.fn();
const mockBuildProtectedResourceMetadata = jest.fn();
const mockGetMcpResourceUrl = jest.fn();
const mockLoggerError = jest.fn();
const mockCheckMcpToolRateLimit = jest.fn();
const mockGetRuntimePolicy = jest.fn();
const mockCreateLifecycleMcpServer = jest.fn();
const mockServerConnect = jest.fn();
const mockServerClose = jest.fn();
const mockTransportConstructor = jest.fn();
const mockTransportHandleRequest = jest.fn();
const mockTransportClose = jest.fn();
const mockRandomUuid = jest.fn();

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: () => mockRandomUuid(),
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation((options) => {
    mockTransportConstructor(options);
    return {
      handleRequest: mockTransportHandleRequest,
      close: mockTransportClose,
    };
  }),
}));

jest.mock('../auth', () => ({
  authenticateMcpRequest: (...args: unknown[]) => mockAuthenticateMcpRequest(...args),
}));

jest.mock('../config', () => ({
  MCP_PATH: '/mcp',
  MCP_PROTECTED_RESOURCE_METADATA_PATH: '/.well-known/oauth-protected-resource/mcp',
  buildProtectedResourceMetadata: () => mockBuildProtectedResourceMetadata(),
  getMcpResourceUrl: () => mockGetMcpResourceUrl(),
}));

jest.mock('../server', () => ({
  createLifecycleMcpServer: (...args: unknown[]) => mockCreateLifecycleMcpServer(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ error: mockLoggerError }),
}));

jest.mock('server/services/authRateLimit', () => ({
  checkMcpToolRateLimit: (...args: unknown[]) => mockCheckMcpToolRateLimit(...args),
}));

jest.mock('server/services/mcpConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getRuntimePolicy: mockGetRuntimePolicy }),
  },
}));

import { EventEmitter } from 'events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Principal } from 'server/lib/principal';
import { handleMcpHttpRequest } from '../handler';
import type { McpToolRegistry } from '../registry';

const principal: Principal = {
  kind: 'user',
  authMethod: 'oauth',
  userId: 'handler-user',
  actor: 'handler-user',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
};

const registry = Object.freeze({}) as McpToolRegistry;
const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
const validHeaders: IncomingHttpHeaders = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};
const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

type MockRequest = IncomingMessage & {
  pause: jest.Mock;
  destroy: jest.Mock;
};

type ResponseState = {
  status?: number;
  headers: Map<string, string | number | readonly string[]>;
  body?: string | Buffer;
};

function request(method = 'POST', headers: IncomingHttpHeaders = validHeaders): MockRequest {
  const req = new EventEmitter() as MockRequest;
  req.method = method;
  req.headers = { ...headers };
  req.pause = jest.fn();
  req.destroy = jest.fn();
  return req;
}

function response(): { res: ServerResponse; state: ResponseState } {
  const state: ResponseState = { headers: new Map() };
  const res = {
    headersSent: false,
    setHeader: jest.fn((name: string, value: string | number | readonly string[]) => {
      state.headers.set(name.toLowerCase(), value);
    }),
    writeHead: jest.fn((status: number, headers: Record<string, string> = {}) => {
      state.status = status;
      res.headersSent = true;
      for (const [name, value] of Object.entries(headers)) {
        state.headers.set(name.toLowerCase(), value);
      }
      return res;
    }),
    end: jest.fn((body?: string | Buffer) => {
      state.body = body;
      return res;
    }),
  };
  return { res: res as unknown as ServerResponse, state };
}

function json(state: ResponseState): Record<string, unknown> {
  return JSON.parse(String(state.body)) as Record<string, unknown>;
}

type BodyEvent = { chunks?: Buffer[]; error?: unknown };

async function handleWithBody(
  req: MockRequest,
  res: ServerResponse,
  pathname: string,
  event: BodyEvent = { chunks: [Buffer.from(JSON.stringify(ping))] }
): Promise<boolean> {
  const handled = handleMcpHttpRequest(req, res, pathname, registry);
  setImmediate(() => {
    if ('error' in event) {
      req.emit('error', event.error);
      return;
    }
    for (const chunk of event.chunks || []) {
      req.emit('data', chunk);
    }
    req.emit('end');
  });
  return handled;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ALLOWED_ORIGINS;
  mockRandomUuid.mockReturnValue('00000000-0000-4000-8000-000000000001');
  mockGetMcpResourceUrl.mockReturnValue('https://lifecycle.example/mcp');
  mockBuildProtectedResourceMetadata.mockReturnValue({
    resource: 'https://lifecycle.example/mcp',
    scopes_supported: ['mcp'],
  });
  mockAuthenticateMcpRequest.mockResolvedValue({ ok: true, principal });
  mockGetRuntimePolicy.mockResolvedValue({ enabled: true, allowChanges: true, sitesAvailable: true });
  mockCheckMcpToolRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockServerConnect.mockResolvedValue(undefined);
  mockServerClose.mockResolvedValue(undefined);
  mockTransportClose.mockResolvedValue(undefined);
  mockTransportHandleRequest.mockImplementation(async (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
  });
  mockCreateLifecycleMcpServer.mockReturnValue({ connect: mockServerConnect, close: mockServerClose });
});

afterAll(() => {
  if (originalAllowedOrigins === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
  }
});

describe('route selection and protected-resource metadata', () => {
  it('leaves missing, unrelated, and slash-only paths for the next HTTP handler', async () => {
    for (const pathname of [null, '/unrelated', '////']) {
      const req = request('GET');
      const { res } = response();

      await expect(handleMcpHttpRequest(req, res, pathname, registry)).resolves.toBe(false);
    }

    expect(mockAuthenticateMcpRequest).not.toHaveBeenCalled();
    expect(mockBuildProtectedResourceMetadata).not.toHaveBeenCalled();
  });

  it('rejects unsupported metadata methods before building metadata', async () => {
    const req = request('POST');
    const { res, state } = response();

    await expect(handleMcpHttpRequest(req, res, '/.well-known/oauth-protected-resource/mcp/', registry)).resolves.toBe(
      true
    );

    expect(state.status).toBe(405);
    expect(state.headers.get('allow')).toBe('GET, HEAD');
    expect(json(state)).toEqual({ error: 'method_not_allowed' });
    expect(mockBuildProtectedResourceMetadata).not.toHaveBeenCalled();
  });

  it('serves metadata headers without a body for HEAD', async () => {
    const req = request('HEAD');
    const { res, state } = response();

    await expect(handleMcpHttpRequest(req, res, '/.well-known/oauth-protected-resource/mcp', registry)).resolves.toBe(
      true
    );

    expect(state.status).toBe(200);
    expect(state.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(state.headers.get('access-control-allow-origin')).toBe('*');
    expect(state.body).toBeUndefined();
  });

  it('returns a non-cacheable service error when OAuth metadata is not configured', async () => {
    const metadataError = new Error('KEYCLOAK_ISSUER is not configured');
    mockBuildProtectedResourceMetadata.mockImplementation(() => {
      throw metadataError;
    });
    const req = request('GET');
    const { res, state } = response();

    await expect(handleMcpHttpRequest(req, res, '/.well-known/oauth-protected-resource/mcp', registry)).resolves.toBe(
      true
    );

    expect(state.status).toBe(503);
    expect(state.headers.get('cache-control')).toBe('no-store');
    expect(json(state)).toEqual({ error: 'mcp_oauth_not_configured' });
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: metadataError },
      'MCP: protected-resource metadata is not configured'
    );
  });
});

describe('origin and authorization boundaries', () => {
  it('reflects an allowlisted Origin value on preflight without authenticating', async () => {
    process.env.ALLOWED_ORIGINS = ' https://browser.example , https://other.example ';
    const req = request('OPTIONS', { origin: 'https://browser.example' });
    const { res, state } = response();

    await expect(handleMcpHttpRequest(req, res, '/mcp', registry)).resolves.toBe(true);

    expect(state.status).toBe(204);
    expect(state.headers.get('access-control-allow-origin')).toBe('https://browser.example');
    expect(state.headers.get('vary')).toBe('Origin');
    expect(mockAuthenticateMcpRequest).not.toHaveBeenCalled();
  });

  it('rejects an untrusted origin before authentication or server construction', async () => {
    const req = request('POST', { ...validHeaders, origin: 'https://attacker.example' });
    const { res, state } = response();

    await expect(handleMcpHttpRequest(req, res, '/mcp', registry)).resolves.toBe(true);

    expect(state.status).toBe(403);
    expect(json(state)).toMatchObject({ error: { code: -32000, message: 'Origin not allowed' } });
    expect(mockAuthenticateMcpRequest).not.toHaveBeenCalled();
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });

  it('returns retry guidance without inventing an authentication challenge', async () => {
    mockAuthenticateMcpRequest.mockResolvedValue({
      ok: false,
      status: 429,
      message: 'Authentication temporarily rate limited.',
      retryAfterSeconds: 11,
    });
    const req = request();
    const { res, state } = response();

    await expect(handleMcpHttpRequest(req, res, '/mcp', registry)).resolves.toBe(true);

    expect(state.status).toBe(429);
    expect(state.headers.get('retry-after')).toBe('11');
    expect(state.headers.has('www-authenticate')).toBe(false);
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });
});

describe('request parsing and validation', () => {
  it.each([
    ['Accept', { 'content-type': 'application/json' }, 406],
    ['Content-Type', { accept: 'application/json, text/event-stream' }, 415],
  ])('rejects a request with no %s header before reading its body', async (_label, headers, expectedStatus) => {
    const req = request('POST', headers);
    const { res, state } = response();

    await expect(handleMcpHttpRequest(req, res, '/mcp', registry)).resolves.toBe(true);

    expect(state.status).toBe(expectedStatus);
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });

  it('normalizes Accept casing and Content-Type parameters before dispatch', async () => {
    const req = request('POST', {
      accept: 'APPLICATION/JSON, TEXT/EVENT-STREAM',
      'content-type': 'Application/JSON; Charset=UTF-8',
    });
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp///')).resolves.toBe(true);

    expect(state.status).toBe(200);
    expect(mockTransportHandleRequest).toHaveBeenCalledWith(req, res, ping);
    expect(mockCreateLifecycleMcpServer).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized body, stops consumption, and destroys the request after writing 413', async () => {
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp', { chunks: [Buffer.alloc(4 * 1024 * 1024 + 1, 1)] })).resolves.toBe(
      true
    );

    expect(state.status).toBe(413);
    expect(json(state)).toMatchObject({ error: { code: -32000, message: 'Request body exceeds the 4MB limit' } });
    expect(req.pause).toHaveBeenCalledTimes(1);
    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });

  it('returns a parse error for a request-stream failure without constructing a server', async () => {
    const streamError = new Error('request stream reset');
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp', { error: streamError })).resolves.toBe(true);

    expect(state.status).toBe(400);
    expect(json(state)).toMatchObject({
      error: { code: ErrorCode.ParseError, message: 'Parse error: request stream reset' },
    });
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });

  it('treats an empty body as an invalid request rather than malformed JSON', async () => {
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp', { chunks: [] })).resolves.toBe(true);

    expect(state.status).toBe(400);
    expect(json(state)).toMatchObject({ error: { code: ErrorCode.InvalidRequest } });
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });

  it.each([
    ['an integer request id', { id: 7 }, 7],
    ['a fractional request id', { id: 7.5 }, undefined],
    ['a primitive request', false, undefined],
  ])('correlates invalid requests with %s only when JSON-RPC permits it', async (_label, body, expectedId) => {
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp', { chunks: [Buffer.from(JSON.stringify(body))] })).resolves.toBe(true);

    const parsed = json(state);
    expect(state.status).toBe(400);
    expect(parsed).toMatchObject({ error: { code: ErrorCode.InvalidRequest } });
    if (expectedId === undefined) {
      expect(parsed).not.toHaveProperty('id');
    } else {
      expect(parsed).toHaveProperty('id', expectedId);
    }
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a mixed batch containing an invalid message and honors an array protocol header', async () => {
    const req = request('POST', {
      ...validHeaders,
      'mcp-protocol-version': ['2025-03-26'],
    });
    const { res, state } = response();
    const body = [ping, { jsonrpc: '2.0', id: 2 }];

    await expect(handleWithBody(req, res, '/mcp', { chunks: [Buffer.from(JSON.stringify(body))] })).resolves.toBe(true);

    expect(state.status).toBe(400);
    expect(json(state)).toMatchObject({ error: { code: ErrorCode.InvalidRequest } });
    expect(mockCreateLifecycleMcpServer).not.toHaveBeenCalled();
  });

  it('dispatches a valid legacy batch when no protocol-version header is supplied', async () => {
    const req = request();
    const { res } = response();
    const body = [ping, { jsonrpc: '2.0', id: 2, method: 'ping' }];

    await expect(handleWithBody(req, res, '/mcp', { chunks: [Buffer.from(JSON.stringify(body))] })).resolves.toBe(true);

    expect(mockTransportHandleRequest).toHaveBeenCalledWith(req, res, body);
  });
});

describe('server wiring, cleanup, and unhandled failures', () => {
  it('passes lazy policy and rate-limit boundaries with a deterministic request id', async () => {
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp')).resolves.toBe(true);

    const [calledPrincipal, requestId, calledRegistry, loadPolicy, rateLimit] =
      mockCreateLifecycleMcpServer.mock.calls[0];
    expect(calledPrincipal).toBe(principal);
    expect(requestId).toBe('mcp_00000000-0000-4000-8000-000000000001');
    expect(calledRegistry).toBe(registry);
    await expect(loadPolicy()).resolves.toEqual({ enabled: true, allowChanges: true, sitesAvailable: true });
    await expect(rateLimit()).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(mockCheckMcpToolRateLimit).toHaveBeenCalledWith(principal);
    expect(state.headers.get('x-request-id')).toBe(requestId);
    expect(mockServerConnect).toHaveBeenCalledTimes(1);
    expect(mockTransportClose).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful response when both best-effort close operations fail', async () => {
    mockTransportClose.mockRejectedValue(new Error('transport close failed'));
    mockServerClose.mockRejectedValue(new Error('server close failed'));
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp')).resolves.toBe(true);

    expect(state.status).toBe(200);
    expect(mockTransportClose).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('returns an internal JSON-RPC error when server connection fails before headers are sent', async () => {
    const connectError = new Error('server connect failed');
    mockServerConnect.mockRejectedValue(connectError);
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp')).resolves.toBe(true);

    expect(state.status).toBe(500);
    expect(json(state)).toMatchObject({ error: { code: -32603, message: 'Internal server error' } });
    expect(mockLoggerError).toHaveBeenCalledWith({ error: connectError }, 'MCP: unhandled request error');
    expect(mockTransportHandleRequest).not.toHaveBeenCalled();
    expect(mockTransportClose).not.toHaveBeenCalled();
    expect(mockServerClose).not.toHaveBeenCalled();
  });

  it('ends a started response without trying to replace its status when dispatch fails', async () => {
    const dispatchError = new Error('response stream failed');
    mockTransportHandleRequest.mockImplementation(async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      throw dispatchError;
    });
    const req = request();
    const { res, state } = response();

    await expect(handleWithBody(req, res, '/mcp')).resolves.toBe(true);

    expect(state.status).toBe(200);
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(mockTransportClose).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith({ error: dispatchError }, 'MCP: unhandled request error');
  });
});
