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

import { NextRequest } from 'next/server';

const mockListMcpPresets = jest.fn();

jest.mock('server/services/ai/mcp/presets', () => ({
  listMcpPresets: (...args: unknown[]) => mockListMcpPresets(...args),
}));

import { GET } from './route';

function makeRequest(url = 'http://localhost/api/v2/ai/config/mcp-presets') {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/config/mcp-presets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListMcpPresets.mockReturnValue([
      {
        key: 'oauth-http',
        label: 'OAuth 2.1',
        description: 'Each user signs in with OAuth 2.1 for a remote MCP server.',
        transportType: 'http',
        endpointPlaceholder: 'https://mcp.example.com/mcp',
        authConfig: { mode: 'oauth', provider: 'generic-oauth2.1' },
      },
    ]);
  });

  it('returns MCP presets for the admin MCP editor', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        key: 'oauth-http',
        authConfig: { mode: 'oauth', provider: 'generic-oauth2.1' },
      }),
    ]);
  });
});
