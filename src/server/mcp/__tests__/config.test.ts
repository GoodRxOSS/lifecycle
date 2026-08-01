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

import {
  buildProtectedResourceMetadata,
  getMcpResourceUrl,
  isMcpServingProcess,
  loadMcpRuntimeConfig,
} from '../config';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    APP_HOST: 'https://lifecycle.example.test',
    ENABLE_AUTH: 'true',
    KEYCLOAK_ISSUER: 'https://auth.example.test/realms/lifecycle',
  };
});

afterAll(() => {
  process.env = originalEnv;
});

it('derives the canonical MCP resource from the ordinary Lifecycle host', () => {
  expect(loadMcpRuntimeConfig()).toEqual({
    authEnabled: true,
    maxWaitSeconds: 15,
    resourceUrl: 'https://lifecycle.example.test/mcp',
  });
  expect(getMcpResourceUrl('https://lifecycle.example.test/base/path')).toBe('https://lifecycle.example.test/mcp');
});

it.each([
  'https://user:password@example.test',
  'https://example.test?token=x',
  'https://example.test#fragment',
  'ftp://example.test',
  'http://lifecycle.example.test',
])('rejects an unsafe APP_HOST %s', (value) => {
  expect(() => getMcpResourceUrl(value)).toThrow();
});

it.each(['http://localhost:5001', 'http://127.0.0.1:5001', 'http://[::1]:5001'])(
  'allows loopback HTTP even in production deployments: %s',
  (value) => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    expect(getMcpResourceUrl(value)).toMatch(/\/mcp$/);
  }
);

it('identifies only web-serving Lifecycle processes', () => {
  expect(isMcpServingProcess('web')).toBe(true);
  expect(isMcpServingProcess('all')).toBe(true);
  expect(isMcpServingProcess('worker')).toBe(false);
});

it('serves the fixed wait ceiling without an MCP installation flag', () => {
  expect(loadMcpRuntimeConfig().maxWaitSeconds).toBe(15);
});

it('emits protected-resource metadata for the derived resource', () => {
  expect(buildProtectedResourceMetadata()).toMatchObject({
    resource: 'https://lifecycle.example.test/mcp',
    authorization_servers: ['https://auth.example.test/realms/lifecycle'],
    scopes_supported: expect.arrayContaining(['mcp']),
  });

  delete process.env.KEYCLOAK_ISSUER;
  expect(() => buildProtectedResourceMetadata()).toThrow('KEYCLOAK_ISSUER is not configured');

  process.env.KEYCLOAK_ISSUER = 'http://auth.example.test/realms/lifecycle';
  expect(() => buildProtectedResourceMetadata()).toThrow('must use HTTPS unless it is a loopback URL');

  process.env.KEYCLOAK_ISSUER = 'http://localhost:8081/realms/lifecycle';
  expect(buildProtectedResourceMetadata()).toMatchObject({
    authorization_servers: ['http://localhost:8081/realms/lifecycle'],
  });
});
