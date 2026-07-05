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

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { parse } from 'url';

jest.mock('server/services/build', () => {
  return jest.fn().mockImplementation(() => ({
    getAllBuilds: jest.fn().mockResolvedValue({
      data: [
        {
          uuid: 'test-build-1',
          status: 'deployed',
          namespace: 'env-test-build-1',
          pullRequest: { title: 'Test PR', fullName: 'org/repo', pullRequestNumber: 1, branchName: 'main' },
          deploys: [{ deployable: { name: 'web' } }],
        },
      ],
      paginationMetadata: { page: 1, limit: 25, total: 1 },
    }),
    getBuildByUUID: jest.fn().mockResolvedValue(null),
  }));
});

import { handleMcpHttpRequest } from '../handler';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.MCP_SERVER_ENABLED = 'true';
  process.env.ENABLE_AUTH = 'false';
  process.env.MCP_RESOURCE_URL = 'http://localhost:3000/mcp';
  process.env.KEYCLOAK_ISSUER = 'http://localhost/realms/lifecycle-test';

  server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url || '', true);
    if (await handleMcpHttpRequest(req, res, parsedUrl.pathname)) {
      return;
    }
    res.writeHead(404);
    res.end('not-mcp');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function mcpPost(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function initializeRequestBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'jest', version: '0.0.1' },
    },
  };
}

/** Parse a JSON-RPC payload from either a JSON or SSE response body. */
async function readRpcResponse(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    const dataLine = text
      .split('\n')
      .reverse()
      .find((line) => line.startsWith('data: '));
    return dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null;
  }
  return text ? JSON.parse(text) : null;
}

describe('handleMcpHttpRequest routing (stateless)', () => {
  it('ignores unrelated paths', async () => {
    const response = await fetch(`${baseUrl}/api/v2/builds`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not-mcp');
  });

  it('serves RFC 9728 protected resource metadata at the path-inserted well-known location', async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);

    const metadata = await response.json();
    expect(metadata.resource).toBe('http://localhost:3000/mcp');
    expect(metadata.authorization_servers).toEqual(['http://localhost/realms/lifecycle-test']);
    expect(metadata.scopes_supported).toEqual(['mcp', 'offline_access']);
    expect(metadata.bearer_methods_supported).toEqual(['header']);
  });

  it('serves the same metadata at the root well-known location', async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    expect((await response.json()).resource).toBe('http://localhost:3000/mcp');
  });

  it('rejects requests from disallowed origins', async () => {
    const response = await mcpPost(initializeRequestBody(), { Origin: 'https://evil.example.com' });
    expect(response.status).toBe(403);
  });

  it('allows the resource URL origin', async () => {
    const response = await mcpPost(initializeRequestBody(), { Origin: 'http://localhost:3000' });
    expect(response.status).toBe(200);
  });

  it('answers initialize without issuing a session id', async () => {
    const initResponse = await mcpPost(initializeRequestBody());
    expect(initResponse.status).toBe(200);
    expect(initResponse.headers.get('mcp-session-id')).toBeNull();

    const initRpc = await readRpcResponse(initResponse);
    expect(initRpc.result.serverInfo.name).toBe('lifecycle');
  });

  it('serves tools/list and tools/call as independent requests (no session required)', async () => {
    const toolsResponse = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(toolsResponse.status).toBe(200);
    const toolsRpc = await readRpcResponse(toolsResponse);
    const toolNames = toolsRpc.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['list_builds', 'get_build', 'list_services', 'get_job_logs', 'list_sites', 'get_site'])
    );

    const callResponse = await mcpPost({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_builds', arguments: {} },
    });
    expect(callResponse.status).toBe(200);
    const callRpc = await readRpcResponse(callResponse);
    expect(callRpc.result.isError).toBeFalsy();
    const payload = JSON.parse(callRpc.result.content[0].text);
    expect(payload.builds[0].uuid).toBe('test-build-1');
    expect(payload.builds[0].serviceNames).toEqual(['web']);
  });

  it('accepts notifications with 202', async () => {
    const response = await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(response.status).toBe(202);
  });

  it('rejects GET and DELETE (no standalone SSE stream or sessions in stateless mode)', async () => {
    const getResponse = await fetch(`${baseUrl}/mcp`);
    expect(getResponse.status).toBe(405);
    const deleteResponse = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(405);
  });

  it('does nothing when the feature flag is off', async () => {
    process.env.MCP_SERVER_ENABLED = 'false';
    try {
      const response = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('not-mcp');
    } finally {
      process.env.MCP_SERVER_ENABLED = 'true';
    }
  });
});
