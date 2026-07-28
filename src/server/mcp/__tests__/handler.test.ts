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

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { JSONRPCErrorSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpToolRegistry } from '../registry';
import { handleMcpHttpRequest } from '../handler';
import type { McpToolDefinition } from '../contracts';
import { successObjectSchema } from '../schemaValidator';

let server: Server;
let baseUrl: string;
let originalEnv: NodeJS.ProcessEnv;

const definition: McpToolDefinition = {
  name: 'get_context',
  title: 'Get context',
  description: 'Returns context.',
  capabilityId: 'understand-environments',
  access: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: successObjectSchema({ value: { type: 'string' } }, ['value']),
  annotations: { readOnlyHint: true },
  handler: async () => ({ value: 'ok' }),
};

beforeAll(async () => {
  originalEnv = { ...process.env };
  process.env.ENABLE_AUTH = 'true';
  const registry = new McpToolRegistry([definition]);
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!(await handleMcpHttpRequest(req, res, pathname, registry))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.APP_HOST = baseUrl;
  process.env.KEYCLOAK_ISSUER = 'http://localhost/realms/lifecycle';
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = originalEnv;
});

it('serves RFC 9728 protected-resource metadata while product access is off', async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(
    expect.objectContaining({
      resource: `${baseUrl}/mcp`,
      scopes_supported: expect.arrayContaining(['mcp']),
    })
  );
});

it('does not serve a root metadata alias for the different origin-level resource', async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  expect(response.status).toBe(404);
});

it('keeps the stateless MCP endpoint POST-only', async () => {
  const response = await fetch(`${baseUrl}/mcp`);
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('POST, OPTIONS');
});

it('answers browser preflight without authenticating', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'OPTIONS',
    headers: { Origin: baseUrl },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
});

it('rejects a browser origin outside the configured app origin', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(response.status).toBe(403);
});

it('requires OAuth for POST and returns a safe challenge', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toContain('scope="mcp"');
  const body = await response.json();
  expect(body).not.toHaveProperty('id');
  expect(JSONRPCErrorSchema.safeParse(body).success).toBe(true);
});
