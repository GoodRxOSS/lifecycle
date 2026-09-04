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
  applyCompiledConnectionConfigToTransport,
  applyCompiledQueryParams,
  buildMcpDefinitionFingerprint,
  buildMcpOAuthCallbackUrl,
  compileFieldConnectionConfig,
  getAuthMode,
  getFieldSchema,
  mergeCompiledConnectionConfig,
  normalizeAuthConfig,
  normalizeFieldSchema,
  normalizeSharedConnectionConfig,
  normalizeTransportConfig,
  normalizeUserConnectionValues,
  requiresUserConnection,
  validateFieldConnectionValues,
} from '../connectionConfig';

describe('buildMcpOAuthCallbackUrl', () => {
  it('uses an IPv4 literal for a local HTTP callback', () => {
    expect(buildMcpOAuthCallbackUrl('lifecycle', 'http://localhost:5001')).toBe(
      'http://127.0.0.1:5001/api/v2/ai/agent/mcp-connections/lifecycle/oauth/callback'
    );
  });

  it('preserves a public HTTPS host', () => {
    expect(buildMcpOAuthCallbackUrl('sample/oauth', 'https://app.example.com')).toBe(
      'https://app.example.com/api/v2/ai/agent/mcp-connections/sample%2Foauth/oauth/callback'
    );
  });

  it('uses the configured app host when no host override is provided', () => {
    expect(buildMcpOAuthCallbackUrl('configured')).toContain(
      '/api/v2/ai/agent/mcp-connections/configured/oauth/callback'
    );
  });
});

describe('connection configuration normalization', () => {
  it.each([null, undefined, 'value', [], 4])('normalizes non-record user values %p to empty', (input) => {
    expect(normalizeUserConnectionValues(input)).toEqual({});
  });

  it('keeps trimmed nonempty string values and ignores other user fields', () => {
    expect(
      normalizeUserConnectionValues({
        ' apiKey ': ' secret ',
        empty: ' ',
        number: 7,
        nested: { value: 'ignored' },
      })
    ).toEqual({ apiKey: 'secret' });
  });

  it('normalizes fields and every supported binding shape', () => {
    expect(
      normalizeFieldSchema({
        fields: [
          {
            key: ' username ',
            label: ' User name ',
            description: ' Login identity ',
            placeholder: ' octocat ',
            required: true,
            inputType: 'email',
          },
          { key: 'password', label: 'Password', inputType: 'password' },
          { key: 'token', label: 'Token', inputType: 'unsupported' },
          { key: '', label: 'Missing key' },
          { key: 'missing-label' },
          null,
        ],
        bindings: [
          {
            target: 'header',
            key: ' Authorization ',
            format: 'basic',
            usernameFieldKey: ' username ',
            passwordFieldKey: ' password ',
          },
          { target: 'header', key: 'X-Token', fieldKey: 'token', format: 'bearer' },
          { target: 'header', key: 'X-Plain', fieldKey: 'token', format: 'unknown' },
          { target: 'query', key: 'key', fieldKey: 'token' },
          { target: 'env', key: 'TOKEN', fieldKey: 'token' },
          { target: 'defaultArg', key: 'token', fieldKey: 'token' },
          { target: 'header', key: 'missing-field' },
          null,
        ],
      })
    ).toEqual({
      fields: [
        {
          key: 'username',
          label: 'User name',
          description: 'Login identity',
          placeholder: 'octocat',
          required: true,
          inputType: 'email',
        },
        { key: 'password', label: 'Password', inputType: 'password' },
        { key: 'token', label: 'Token' },
      ],
      bindings: [
        {
          target: 'header',
          key: 'Authorization',
          format: 'basic',
          usernameFieldKey: 'username',
          passwordFieldKey: 'password',
        },
        { target: 'header', key: 'X-Token', fieldKey: 'token', format: 'bearer' },
        { target: 'header', key: 'X-Plain', fieldKey: 'token', format: 'plain' },
        { target: 'query', key: 'key', fieldKey: 'token' },
        { target: 'env', key: 'TOKEN', fieldKey: 'token' },
        { target: 'defaultArg', key: 'token', fieldKey: 'token' },
      ],
    });
  });

  it('defaults malformed schemas and missing schema arrays', () => {
    expect(normalizeFieldSchema(null)).toEqual({ fields: [], bindings: [] });
    expect(normalizeFieldSchema({ fields: 'not-array', bindings: 'not-array' })).toEqual({
      fields: [],
      bindings: [],
    });
  });

  it('normalizes each auth mode and OAuth display metadata', () => {
    const schema = { fields: [{ key: 'token', label: 'Token' }], bindings: [] };
    expect(normalizeAuthConfig({ mode: 'user-fields', schema })).toEqual({ mode: 'user-fields', schema });
    expect(normalizeAuthConfig({ mode: 'shared-fields', schema })).toEqual({ mode: 'shared-fields', schema });
    expect(
      normalizeAuthConfig({ mode: 'oauth', clientName: ' Example ', instructions: ' Sign in ', provider: 'ignored' })
    ).toEqual({
      mode: 'oauth',
      provider: 'generic-oauth2.1',
      clientName: 'Example',
      instructions: 'Sign in',
    });
    expect(normalizeAuthConfig({ mode: 'oauth', clientName: 4, instructions: null })).toEqual({
      mode: 'oauth',
      provider: 'generic-oauth2.1',
      clientName: undefined,
      instructions: undefined,
    });
    expect(normalizeAuthConfig({ mode: 'unknown' })).toEqual({ mode: 'none' });
    expect(normalizeAuthConfig([])).toEqual({ mode: 'none' });
  });

  it('normalizes shared headers, query, env, and default arguments', () => {
    expect(
      normalizeSharedConnectionConfig({
        headers: { ' X-Key ': ' secret ', empty: '' },
        query: { tenant: ' acme ' },
        env: { TOKEN: ' token ' },
        defaultArgs: { region: ' us-west-2 ' },
      })
    ).toEqual({
      headers: { 'X-Key': 'secret' },
      query: { tenant: 'acme' },
      env: { TOKEN: 'token' },
      defaultArgs: { region: 'us-west-2' },
    });
    expect(normalizeSharedConnectionConfig(null)).toEqual({});
  });
});

describe('transport normalization and resolution', () => {
  it('normalizes stdio arguments and environment', () => {
    expect(
      normalizeTransportConfig({
        type: 'stdio',
        command: ' npx ',
        args: ['-y', '', 4, 'server'],
        env: { ' TOKEN ': ' secret ', EMPTY: '' },
      })
    ).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'secret' },
    });
    expect(normalizeTransportConfig({ type: 'stdio', command: 'node', args: null, env: [] })).toEqual({
      type: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
  });

  it.each(['http', 'sse'] as const)('normalizes a %s transport', (type) => {
    expect(
      normalizeTransportConfig({ type, url: ' https://mcp.example/path ', headers: { ' X-Key ': ' value ' } })
    ).toEqual({ type, url: 'https://mcp.example/path', headers: { 'X-Key': 'value' } });
  });

  it('defaults malformed HTTP headers', () => {
    expect(normalizeTransportConfig({ type: 'http', url: 'https://mcp.example', headers: [] })).toEqual({
      type: 'http',
      url: 'https://mcp.example',
      headers: {},
    });
  });

  it('rejects missing and invalid transports with stable messages', () => {
    expect(() => normalizeTransportConfig(null)).toThrow('MCP transport is required');
    expect(() => normalizeTransportConfig({ type: 'stdio', command: ' ' })).toThrow(
      'MCP stdio transport requires a command'
    );
    expect(() => normalizeTransportConfig({ type: 'http', url: '' })).toThrow(
      'MCP transport must be a valid http, sse, or stdio configuration'
    );
  });

  it('applies query parameters without replacing existing URL parameters', () => {
    expect(applyCompiledQueryParams('https://mcp.example/path?existing=yes', undefined)).toBe(
      'https://mcp.example/path?existing=yes'
    );
    expect(applyCompiledQueryParams('https://mcp.example/path?existing=yes', {})).toBe(
      'https://mcp.example/path?existing=yes'
    );
    expect(applyCompiledQueryParams('https://mcp.example/path?existing=yes', { tenant: 'acme', existing: 'new' })).toBe(
      'https://mcp.example/path?existing=new&tenant=acme'
    );
  });

  it('merges HTTP headers/query and attaches an OAuth provider', () => {
    const authProvider = { tokens: jest.fn() } as any;
    expect(
      applyCompiledConnectionConfigToTransport(
        { type: 'http', url: 'https://mcp.example', headers: { Existing: 'transport' } },
        { headers: { Existing: 'connection', Added: 'yes' }, query: { tenant: 'acme' }, env: {}, defaultArgs: {} },
        { authProvider }
      )
    ).toEqual({
      type: 'http',
      url: 'https://mcp.example/?tenant=acme',
      headers: { Existing: 'connection', Added: 'yes' },
      authProvider,
    });
  });

  it('merges stdio environment and works without compiled config', () => {
    expect(
      applyCompiledConnectionConfigToTransport(
        { type: 'stdio', command: 'node', args: [], env: { EXISTING: 'transport' } },
        { headers: {}, query: {}, env: { EXISTING: 'connection', ADDED: 'yes' }, defaultArgs: {} }
      )
    ).toEqual({
      type: 'stdio',
      command: 'node',
      args: [],
      env: { EXISTING: 'connection', ADDED: 'yes' },
    });
    expect(
      applyCompiledConnectionConfigToTransport(
        { type: 'sse', url: 'https://mcp.example', headers: undefined },
        undefined
      )
    ).toEqual({ type: 'sse', url: 'https://mcp.example', headers: {} });
    expect(
      applyCompiledConnectionConfigToTransport({ type: 'stdio', command: 'node', args: [], env: undefined }, undefined)
    ).toEqual({ type: 'stdio', command: 'node', args: [], env: {} });
  });
});

describe('field authentication compilation', () => {
  const schema = {
    fields: [
      { key: 'username', label: 'User name', required: true },
      { key: 'password', label: 'Password', required: true },
      { key: 'token', label: 'Token' },
      { key: 'tenant', label: 'Tenant' },
      { key: 'environment', label: 'Environment' },
      { key: 'region', label: 'Region' },
    ],
    bindings: [
      {
        target: 'header' as const,
        key: 'Authorization',
        format: 'basic' as const,
        usernameFieldKey: 'username',
        passwordFieldKey: 'password',
      },
      { target: 'header' as const, key: 'X-Token', fieldKey: 'token', format: 'bearer' as const },
      { target: 'header' as const, key: 'X-Raw', fieldKey: 'token', format: 'plain' as const },
      { target: 'query' as const, key: 'tenant', fieldKey: 'tenant' },
      { target: 'env' as const, key: 'MCP_ENV', fieldKey: 'environment' },
      { target: 'defaultArg' as const, key: 'region', fieldKey: 'region' },
    ],
  };

  it('identifies field, OAuth, and no-auth connection modes', () => {
    const userFields = { mode: 'user-fields' as const, schema };
    const sharedFields = { mode: 'shared-fields' as const, schema };
    const oauth = { mode: 'oauth' as const, provider: 'generic-oauth2.1' as const };

    expect(getFieldSchema(undefined)).toBeUndefined();
    expect(getFieldSchema(userFields)).toBe(schema);
    expect(getFieldSchema(sharedFields)).toBe(schema);
    expect(getFieldSchema(oauth)).toBeUndefined();
    expect(requiresUserConnection(undefined)).toBe(false);
    expect(requiresUserConnection(userFields)).toBe(true);
    expect(requiresUserConnection(sharedFields)).toBe(false);
    expect(requiresUserConnection(oauth)).toBe(true);
    expect(getAuthMode(userFields)).toBe('fields');
    expect(getAuthMode(sharedFields)).toBe('fields');
    expect(getAuthMode(oauth)).toBe('oauth');
    expect(getAuthMode({ mode: 'none' })).toBe('none');
    expect(getAuthMode(undefined)).toBe('none');
  });

  it('validates known values, required fields, and every binding reference', () => {
    expect(() =>
      validateFieldConnectionValues(schema, {
        username: 'octocat',
        password: 'secret',
      })
    ).not.toThrow();
    expect(() =>
      validateFieldConnectionValues(schema, {
        username: 'octocat',
        password: 'secret',
        unknown: 'value',
      })
    ).toThrow("Unknown MCP connection field 'unknown'");
    expect(() => validateFieldConnectionValues(schema, { username: 'octocat' })).toThrow(
      "Missing required MCP connection field 'Password'"
    );

    expect(() =>
      validateFieldConnectionValues(
        { fields: schema.fields, bindings: [{ target: 'query', key: 'key', fieldKey: 'missing' }] },
        { username: 'octocat', password: 'secret' }
      )
    ).toThrow("MCP binding references unknown field 'missing'");
    expect(() =>
      validateFieldConnectionValues(
        {
          fields: schema.fields,
          bindings: [
            {
              target: 'header',
              key: 'Authorization',
              format: 'basic',
              usernameFieldKey: 'missing',
              passwordFieldKey: 'password',
            },
          ],
        },
        { username: 'octocat', password: 'secret' }
      )
    ).toThrow("MCP binding references unknown field 'missing'");
    expect(() =>
      validateFieldConnectionValues(
        {
          fields: schema.fields,
          bindings: [
            {
              target: 'header',
              key: 'Authorization',
              format: 'basic',
              usernameFieldKey: 'username',
              passwordFieldKey: 'missing',
            },
          ],
        },
        { username: 'octocat', password: 'secret' }
      )
    ).toThrow("MCP binding references unknown field 'missing'");
  });

  it('compiles basic, bearer, plain, query, env, and default argument bindings', () => {
    expect(
      compileFieldConnectionConfig(schema, {
        username: 'octocat',
        password: 'secret',
        token: 'token-1',
        tenant: 'acme',
        environment: 'production',
        region: 'us-west-2',
      })
    ).toEqual({
      headers: {
        Authorization: `Basic ${Buffer.from('octocat:secret').toString('base64')}`,
        'X-Token': 'Bearer token-1',
        'X-Raw': 'token-1',
      },
      query: { tenant: 'acme' },
      env: { MCP_ENV: 'production' },
      defaultArgs: { region: 'us-west-2' },
    });
  });

  it('skips optional bindings whose values are absent', () => {
    const optionalSchema = {
      ...schema,
      fields: schema.fields.map((field) => ({ ...field, required: false })),
    };

    expect(compileFieldConnectionConfig(optionalSchema, { username: 'octocat' })).toEqual({
      headers: {},
      query: {},
      env: {},
      defaultArgs: {},
    });
  });

  it('merges shared and user connection data with user values taking precedence', () => {
    expect(
      mergeCompiledConnectionConfig(
        {
          headers: { Shared: 'yes', Override: 'shared' },
          query: { shared: 'yes' },
          env: { SHARED: 'yes' },
          defaultArgs: { region: 'east' },
        },
        {
          headers: { User: 'yes', Override: 'user' },
          query: { user: 'yes' },
          env: { USER: 'yes' },
          defaultArgs: { region: 'west' },
        }
      )
    ).toEqual({
      headers: { Shared: 'yes', User: 'yes', Override: 'user' },
      query: { shared: 'yes', user: 'yes' },
      env: { SHARED: 'yes', USER: 'yes' },
      defaultArgs: { region: 'west' },
    });
    expect(mergeCompiledConnectionConfig(undefined, undefined)).toEqual({
      headers: {},
      query: {},
      env: {},
      defaultArgs: {},
    });
  });
});

describe('definition fingerprinting', () => {
  it('is stable across object key order and changes with definition behavior', () => {
    const first = buildMcpDefinitionFingerprint({
      preset: 'github',
      transport: { type: 'http', url: 'https://mcp.example', headers: { B: '2', A: '1' } },
      sharedConfig: { headers: { Z: 'last', A: 'first' } },
      authConfig: { mode: 'none' },
    });
    const reordered = buildMcpDefinitionFingerprint({
      preset: 'github',
      transport: { type: 'http', url: 'https://mcp.example', headers: { A: '1', B: '2' } },
      sharedConfig: { headers: { A: 'first', Z: 'last' } },
      authConfig: { mode: 'none' },
    });
    const changed = buildMcpDefinitionFingerprint({
      preset: null,
      transport: { type: 'http', url: 'https://mcp.example', headers: { A: '1', B: '2' } },
      sharedConfig: { headers: { A: 'first', Z: 'last' } },
      authConfig: { mode: 'none' },
    });

    expect(first).toMatch(/^[a-f0-9]{40}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});
