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
const mockCheckMcpToolRateLimit = jest.fn();
const mockGetRuntimePolicy = jest.fn();

jest.mock('../auth', () => ({
  authenticateMcpRequest: (...args: unknown[]) => mockAuthenticateMcpRequest(...args),
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

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  ErrorCode,
  JSONRPCErrorSchema,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import type { Principal } from 'server/lib/principal';
import type { McpToolDefinition } from '../contracts';
import { handleMcpHttpRequest } from '../handler';
import { McpToolRegistry } from '../registry';
import { successObjectSchema } from '../schemaValidator';

const principal: Principal = {
  kind: 'user',
  authMethod: 'oauth',
  userId: 'protocol-user',
  actor: 'protocol-user',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
};

const mockToolHandler = jest.fn(async () => ({ value: 'ok' }));
const definition: McpToolDefinition = {
  name: 'get_context',
  title: 'Get context',
  description: 'Returns context.',
  capabilityId: 'understand-environments',
  access: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: successObjectSchema({ value: { type: 'string' } }, ['value']),
  annotations: { readOnlyHint: true },
  handler: mockToolHandler,
};

const registry = new McpToolRegistry(
  [definition],
  { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
  { record: jest.fn() }
);
let server: Server;
let mcpUrl: string;
let originalEnv: NodeJS.ProcessEnv;

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeAll(async () => {
  originalEnv = { ...process.env };
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!(await handleMcpHttpRequest(req, res, pathname, registry))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  process.env.APP_HOST = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = originalEnv;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticateMcpRequest.mockResolvedValue({
    ok: true,
    principal,
    identity: {},
    payload: {},
  });
  mockCheckMcpToolRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockGetRuntimePolicy.mockResolvedValue({ enabled: true, allowChanges: true, sitesAvailable: true });
});

it('completes initialize, initialized, ping, tools/list, and tools/call using the current stable protocol', async () => {
  const initialize = await post({
    jsonrpc: '2.0',
    id: 'init-1',
    method: 'initialize',
    params: {
      protocolVersion: '2024-10-07',
      capabilities: {},
      clientInfo: { name: 'protocol-test', version: '1.0.0' },
    },
  });
  expect(initialize.status).toBe(200);
  await expect(initialize.json()).resolves.toMatchObject({
    jsonrpc: '2.0',
    id: 'init-1',
    result: {
      protocolVersion: '2024-10-07',
      capabilities: { tools: {} },
      serverInfo: { name: 'lifecycle', version: '1.0.0' },
    },
  });

  const initialized = await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION }
  );
  expect(initialized.status).toBe(202);
  expect(await initialized.text()).toBe('');

  const ping = await post(
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION }
  );
  expect(ping.status).toBe(200);
  await expect(ping.json()).resolves.toEqual({ jsonrpc: '2.0', id: 2, result: {} });

  const list = await post(
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    { 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION }
  );
  expect(list.status).toBe(200);
  await expect(list.json()).resolves.toMatchObject({
    jsonrpc: '2.0',
    id: 3,
    result: { tools: [{ name: 'get_context' }] },
  });

  const call = await post(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_context', arguments: {} } },
    { 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION }
  );
  expect(call.status).toBe(200);
  await expect(call.json()).resolves.toMatchObject({
    jsonrpc: '2.0',
    id: 4,
    result: {
      content: [{ type: 'text' }],
      structuredContent: { value: 'ok' },
    },
  });
  expect(mockCheckMcpToolRateLimit).toHaveBeenCalledTimes(1);
});

it.each([...SUPPORTED_PROTOCOL_VERSIONS])('negotiates SDK-supported protocol version %s', async (protocolVersion) => {
  const response = await post({
    jsonrpc: '2.0',
    id: `init-${protocolVersion}`,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'protocol-test', version: '1.0.0' },
    },
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    result: { protocolVersion },
  });
});

it('returns a model-readable tool execution error when the invocation limit is exceeded', async () => {
  mockCheckMcpToolRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });

  const response = await post({
    jsonrpc: '2.0',
    id: 'limited',
    method: 'tools/call',
    params: { name: 'get_context', arguments: {} },
  });

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    jsonrpc: '2.0',
    id: 'limited',
    result: { isError: true, content: [{ type: 'text' }] },
  });
  expect(JSON.parse(body.result.content[0].text)).toMatchObject({
    error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 17, nextAction: 'retry' },
  });
  expect(mockToolHandler).not.toHaveBeenCalled();
});

it('returns the complete catalog in one page and rejects an unissued cursor', async () => {
  const response = await post({
    jsonrpc: '2.0',
    id: 'cursor',
    method: 'tools/list',
    params: { cursor: 'not-issued-by-lifecycle' },
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    jsonrpc: '2.0',
    id: 'cursor',
    error: {
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Lifecycle returns its complete tool catalog in one page.'),
    },
  });
});

it('allows batches through 2025-03-26 and returns the matching response batch', async () => {
  const response = await post(
    [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ],
    { 'Mcp-Protocol-Version': '2025-03-26' }
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual([
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, result: {} },
  ]);
});

it.each(['2025-06-18', '2025-11-25'])('rejects batches after their removal in %s', async (protocolVersion) => {
  const response = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }], { 'Mcp-Protocol-Version': protocolVersion });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({
    jsonrpc: '2.0',
    error: { code: ErrorCode.InvalidRequest, message: expect.stringContaining(protocolVersion) },
  });
  expect(JSONRPCErrorSchema.safeParse(body).success).toBe(true);
});

it('rejects empty batches, initialization batches, and valid JSON that is not an MCP message', async () => {
  for (const invalidBatch of [
    [],
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'batch-client', version: '1.0.0' },
        },
      },
    ],
  ]) {
    const response = await post(invalidBatch, { 'Mcp-Protocol-Version': '2025-03-26' });
    expect(response.status).toBe(400);
    expect(JSONRPCErrorSchema.safeParse(await response.json()).success).toBe(true);
  }

  const invalid = await post({ id: 'known-id' });
  expect(invalid.status).toBe(400);
  const invalidBody = await invalid.json();
  expect(invalidBody).toMatchObject({
    jsonrpc: '2.0',
    id: 'known-id',
    error: { code: ErrorCode.InvalidRequest },
  });
  expect(JSONRPCErrorSchema.safeParse(invalidBody).success).toBe(true);
});

it('distinguishes malformed JSON and malformed UTF-8 from an invalid request', async () => {
  const malformedJson = await post('{');
  expect(malformedJson.status).toBe(400);
  const jsonBody = await malformedJson.json();
  expect(jsonBody).toMatchObject({ jsonrpc: '2.0', error: { code: ErrorCode.ParseError } });
  expect(jsonBody).not.toHaveProperty('id');
  expect(JSONRPCErrorSchema.safeParse(jsonBody).success).toBe(true);

  const malformedUtf8 = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: new Uint8Array([0xc3, 0x28]),
  });
  expect(malformedUtf8.status).toBe(400);
  const utf8Body = await malformedUtf8.json();
  expect(utf8Body).toMatchObject({ jsonrpc: '2.0', error: { code: ErrorCode.ParseError } });
  expect(utf8Body).not.toHaveProperty('id');
  expect(JSONRPCErrorSchema.safeParse(utf8Body).success).toBe(true);
});

it('returns schema-valid errors for content negotiation and unsupported protocol versions', async () => {
  const missingAccept = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  expect(missingAccept.status).toBe(406);
  expect(JSONRPCErrorSchema.safeParse(await missingAccept.json()).success).toBe(true);

  const wrongContentType = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'text/plain',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });
  expect(wrongContentType.status).toBe(415);
  expect(JSONRPCErrorSchema.safeParse(await wrongContentType.json()).success).toBe(true);

  const unsupportedVersion = await post(
    { jsonrpc: '2.0', id: 'unsupported-version', method: 'ping' },
    { 'Mcp-Protocol-Version': '2099-01-01' }
  );
  expect(unsupportedVersion.status).toBe(400);
  const unsupportedVersionBody = await unsupportedVersion.json();
  expect(unsupportedVersionBody).toMatchObject({
    id: null,
    error: { code: -32000, message: expect.stringContaining('2099-01-01') },
  });
  const missingVersion = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'missing-version', method: 'ping' }),
  });
  expect(missingVersion.status).toBe(200);
  const missingVersionBody = await missingVersion.json();
  expect(missingVersionBody).toEqual({ jsonrpc: '2.0', id: 'missing-version', result: {} });
});
