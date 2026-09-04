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

import type { McpSharedConnectionConfig, McpTransportConfig } from '../types';
import {
  redactMcpConfigSecrets,
  redactSharedConfigSecrets,
  restoreRedactedSharedConfig,
  restoreRedactedTransport,
  sanitizeMcpErrorMessage,
  sanitizeMcpResult,
  sharedConfigContainsRedactedSecret,
  sharedConfigContainsSecretValue,
  transportTargetChanged,
} from '../mcpConfigSecrets';

const REDACTED = '******';

describe('sanitizeMcpErrorMessage', () => {
  it('redacts raw and encoded secrets collected from every supported source', () => {
    const error = new Error(
      [
        'direct=value-secret',
        'nested=nested-secret',
        'header=Bearer header-secret',
        'query=query/secret+value',
        'encoded=query%2Fsecret%2Bvalue',
        'form=query%2Fsecret%2Bvalue',
        'env=env-secret',
        'arg=arg-secret',
        'url=url/secret',
        'urlEncoded=url%2Fsecret',
        'transport=transport-secret',
        'extra=extra-secret',
        'stdio=stdio-secret',
      ].join(' ')
    );

    const message = sanitizeMcpErrorMessage(error, [
      {
        values: {
          direct: ' value-secret ',
          nested: { token: 'nested-secret' },
          ignoredNumber: 123,
        },
        compiledConfig: {
          headers: { Authorization: 'Bearer header-secret' },
          query: { api_key: 'query/secret+value' },
          env: { API_TOKEN: 'env-secret' },
          defaultArgs: { token: 'arg-secret' },
        },
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp?api_key=url%2Fsecret',
          headers: { Authorization: 'transport-secret' },
        },
        extraSecrets: [[{ token: 'extra-secret' }], null],
      },
      {
        transport: {
          type: 'stdio',
          command: 'sample-mcp',
          env: { API_TOKEN: 'stdio-secret' },
        },
      },
    ]);

    for (const secret of [
      'value-secret',
      'nested-secret',
      'Bearer header-secret',
      'query/secret+value',
      'query%2Fsecret%2Bvalue',
      'env-secret',
      'arg-secret',
      'url/secret',
      'url%2Fsecret',
      'transport-secret',
      'extra-secret',
      'stdio-secret',
    ]) {
      expect(message).not.toContain(secret);
    }
    expect(message).toContain(REDACTED);
  });

  it('redacts raw malformed query values while tolerating empty and flag parameters', () => {
    const message = sanitizeMcpErrorMessage(new Error('bad%ZZ raw-secret remains-safe'), [
      {
        transport: {
          type: 'sse',
          url: 'not a valid URL?broken=bad%ZZ&&empty=&flag&good=raw-secret#fragment',
        },
      },
    ]);

    expect(message).toBe(`${REDACTED} ${REDACTED} remains-safe`);
  });

  it('redacts HTTP header secrets when the transport URL has no query', () => {
    expect(
      sanitizeMcpErrorMessage(new Error('Authorization=Bearer transport-secret'), [
        {
          transport: {
            type: 'http',
            url: 'https://mcp.example.com/v1/mcp',
            headers: { Authorization: 'Bearer transport-secret' },
          },
        },
      ])
    ).toBe(`Authorization=${REDACTED}`);
  });

  it('ignores placeholders, short values, primitives, and common non-secret protocol words', () => {
    const original = 'abc Bearer true none ****** 42 null';

    expect(
      sanitizeMcpErrorMessage(original, [
        {
          values: {
            short: 'abc',
            bearer: 'Bearer',
            bool: 'true',
            none: 'none',
            placeholder: REDACTED,
            number: 42,
            nil: null,
          },
          compiledConfig: null,
          transport: null,
        },
      ])
    ).toBe(original);
  });

  it('normalizes non-Error values and leaves messages unchanged when no sources are supplied', () => {
    expect(sanitizeMcpErrorMessage(42)).toBe('42');
    expect(sanitizeMcpErrorMessage(new Error('safe message'))).toBe('safe message');
  });
});

describe('sanitizeMcpResult', () => {
  it('recursively redacts strings without mutating nested results', () => {
    const result = {
      message: 'token=result-secret',
      content: ['encoded=result%2Fsecret', { text: 'nested result-secret', count: 2, enabled: true, empty: null }],
    };

    const sanitized = sanitizeMcpResult(result, [{ values: { token: 'result-secret', encoded: 'result/secret' } }]);

    expect(sanitized).toEqual({
      message: `token=${REDACTED}`,
      content: [`encoded=${REDACTED}`, { text: `nested ${REDACTED}`, count: 2, enabled: true, empty: null }],
    });
    expect(sanitized).not.toBe(result);
    expect(sanitized.content).not.toBe(result.content);
    expect(result.message).toBe('token=result-secret');
  });

  it('uses the no-source default without changing scalar results', () => {
    expect(sanitizeMcpResult('safe')).toBe('safe');
    expect(sanitizeMcpResult(undefined)).toBeUndefined();
  });
});

describe('redactSharedConfigSecrets', () => {
  it('redacts every configured section without mutating the input', () => {
    const config = {
      id: 7,
      sharedConfig: {
        headers: { Authorization: 'Bearer header-secret' },
        query: { api_key: 'query-secret' },
        env: { API_TOKEN: 'env-secret' },
        defaultArgs: { token: 'arg-secret' },
      },
    };

    const redacted = redactSharedConfigSecrets(config);

    expect(redacted).toEqual({
      id: 7,
      sharedConfig: {
        headers: { Authorization: REDACTED },
        query: { api_key: REDACTED },
        env: { API_TOKEN: REDACTED },
        defaultArgs: { token: REDACTED },
      },
    });
    expect(redacted).not.toBe(config);
    expect(config.sharedConfig.headers.Authorization).toBe('Bearer header-secret');
  });

  const unchangedSharedConfigs: Array<[string, { id: number; sharedConfig?: McpSharedConnectionConfig | null }]> = [
    ['absent shared config', { id: 1 }],
    ['null shared config', { id: 1, sharedConfig: null }],
    ['empty shared config', { id: 1, sharedConfig: {} }],
  ];

  it.each(unchangedSharedConfigs)('preserves object identity for %s', (_label, config) => {
    expect(redactSharedConfigSecrets(config)).toBe(config);
  });
});

describe('redactMcpConfigSecrets', () => {
  it('redacts SSE query parameters, flag parameters, and headers while preserving fragments', () => {
    const config = {
      transport: {
        type: 'sse' as const,
        url: 'https://mcp.example.com/events?flag&api_key=query-secret&&workspace=sample#section',
        headers: { Authorization: 'Bearer header-secret' },
      },
    };

    expect(redactMcpConfigSecrets(config)).toEqual({
      transport: {
        type: 'sse',
        url: `https://mcp.example.com/events?flag=${REDACTED}&api_key=${REDACTED}&&workspace=${REDACTED}#section`,
        headers: { Authorization: REDACTED },
      },
    });
    expect(config.transport.url).toContain('query-secret');
  });

  it('redacts headers even when an HTTP URL has no query', () => {
    const config = {
      transport: {
        type: 'http' as const,
        url: 'https://mcp.example.com/v1/mcp',
        headers: { Authorization: 'Bearer header-secret' },
      },
    };

    expect(redactMcpConfigSecrets(config).transport?.headers).toEqual({ Authorization: REDACTED });
  });

  it('redacts an HTTP query without adding an absent headers record', () => {
    const config = {
      transport: {
        type: 'http' as const,
        url: 'https://mcp.example.com/v1/mcp?api_key=query-secret',
      },
    };

    expect(redactMcpConfigSecrets(config)).toEqual({
      transport: {
        type: 'http',
        url: `https://mcp.example.com/v1/mcp?api_key=${REDACTED}`,
      },
    });
  });

  const unchangedMcpConfigs: Array<[string, { id?: number; transport?: McpTransportConfig | null }]> = [
    ['absent transport', { id: 1 }],
    ['HTTP transport without secrets', { transport: { type: 'http' as const, url: 'https://mcp.example.com/v1/mcp' } }],
    [
      'HTTP transport with an empty query',
      { transport: { type: 'http' as const, url: 'https://mcp.example.com/v1/mcp?' } },
    ],
    ['stdio transport without env', { transport: { type: 'stdio' as const, command: 'sample-mcp' } }],
  ];

  it.each(unchangedMcpConfigs)('preserves object identity for %s', (_label, config) => {
    expect(redactMcpConfigSecrets(config)).toBe(config);
  });
});

describe('restoreRedactedSharedConfig', () => {
  it('restores matching placeholders while preserving explicit and unmatched values', () => {
    const next: McpSharedConnectionConfig = {
      headers: {
        Authorization: REDACTED,
        'x-new-token': 'replacement-token',
        'x-missing-token': REDACTED,
      },
      query: { api_key: REDACTED },
      env: { API_TOKEN: REDACTED },
    };
    const existing: McpSharedConnectionConfig = {
      headers: {
        Authorization: 'Bearer existing-secret',
        'x-new-token': 'old-token',
        'x-missing-token': '',
      },
      query: { api_key: 'existing-query-secret' },
    };

    const restored = restoreRedactedSharedConfig(next, existing);

    expect(restored).toEqual({
      headers: {
        Authorization: 'Bearer existing-secret',
        'x-new-token': 'replacement-token',
        'x-missing-token': REDACTED,
      },
      query: { api_key: 'existing-query-secret' },
      env: { API_TOKEN: REDACTED },
    });
    expect(restored).not.toBe(next);
    expect(next.headers?.Authorization).toBe(REDACTED);
  });

  it('preserves identity when no placeholder can be restored', () => {
    const next: McpSharedConnectionConfig = {
      headers: { Authorization: 'replacement-token' },
      env: { API_TOKEN: REDACTED },
    };
    const existing: McpSharedConnectionConfig = { headers: { Authorization: 'old-token' } };

    expect(restoreRedactedSharedConfig(next, existing)).toBe(next);
  });
});

describe('transportTargetChanged', () => {
  const cases: Array<[string, McpTransportConfig, McpTransportConfig, boolean]> = [
    [
      'transport type',
      { type: 'stdio', command: 'sample-mcp' },
      { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
      true,
    ],
    [
      'HTTP query and fragment only',
      { type: 'http', url: 'https://mcp.example.com/v1/mcp?token=new#next' },
      { type: 'http', url: 'https://mcp.example.com/v1/mcp?token=old#old' },
      false,
    ],
    [
      'HTTP protocol',
      { type: 'http', url: 'http://mcp.example.com/v1/mcp' },
      { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
      true,
    ],
    [
      'HTTP host',
      { type: 'http', url: 'https://other.example.com/v1/mcp' },
      { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
      true,
    ],
    [
      'HTTP pathname',
      { type: 'http', url: 'https://mcp.example.com/v2/mcp' },
      { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
      true,
    ],
    [
      'same invalid URL base',
      { type: 'http', url: 'not a URL?token=new' },
      { type: 'http', url: 'not a URL?token=old' },
      false,
    ],
    [
      'different invalid URL base',
      { type: 'http', url: 'other invalid URL?token=new' },
      { type: 'http', url: 'not a URL?token=old' },
      true,
    ],
    [
      'stdio command',
      { type: 'stdio', command: 'other-mcp', args: ['--stdio'] },
      { type: 'stdio', command: 'sample-mcp', args: ['--stdio'] },
      true,
    ],
    [
      'stdio args',
      { type: 'stdio', command: 'sample-mcp', args: ['--other'] },
      { type: 'stdio', command: 'sample-mcp', args: ['--stdio'] },
      true,
    ],
    [
      'omitted and empty stdio args',
      { type: 'stdio', command: 'sample-mcp' },
      { type: 'stdio', command: 'sample-mcp', args: [] },
      false,
    ],
  ];

  it.each(cases)('reports whether the %s changes the target', (_label, next, existing, expected) => {
    expect(transportTargetChanged(next, existing)).toBe(expected);
  });
});

describe('shared config secret presence', () => {
  it('distinguishes redaction placeholders from ordinary configured values', () => {
    expect(sharedConfigContainsRedactedSecret({ defaultArgs: { token: REDACTED } })).toBe(true);
    expect(sharedConfigContainsRedactedSecret({ headers: { Authorization: 'Bearer actual-token' } })).toBe(false);
    expect(sharedConfigContainsRedactedSecret({})).toBe(false);

    expect(sharedConfigContainsSecretValue({ env: { API_TOKEN: '' } })).toBe(true);
    expect(sharedConfigContainsSecretValue({ headers: {}, query: {} })).toBe(false);
    expect(sharedConfigContainsSecretValue({})).toBe(false);
  });
});

describe('restoreRedactedTransport', () => {
  it('requires secrets to be re-entered when the transport type changes', () => {
    const next: McpTransportConfig = { type: 'stdio', command: 'sample-mcp', env: { API_TOKEN: REDACTED } };
    const existing: McpTransportConfig = { type: 'http', url: 'https://mcp.example.com/v1/mcp' };

    expect(() => restoreRedactedTransport(next, existing)).toThrow(
      'Re-enter MCP transport secrets when changing the MCP transport target'
    );
  });

  it('returns a changed transport type unchanged when it contains no placeholder', () => {
    const next: McpTransportConfig = { type: 'stdio', command: 'sample-mcp', env: { API_TOKEN: 'new-token' } };
    const existing: McpTransportConfig = { type: 'http', url: 'https://mcp.example.com/v1/mcp' };

    expect(restoreRedactedTransport(next, existing)).toBe(next);
  });

  it('requires HTTP secrets to be re-entered when the endpoint target changes', () => {
    const next: McpTransportConfig = {
      type: 'http',
      url: `https://other.example.com/v1/mcp?api_key=${REDACTED}`,
      headers: { Authorization: REDACTED },
    };
    const existing: McpTransportConfig = {
      type: 'http',
      url: 'https://mcp.example.com/v1/mcp?api_key=old-query-secret',
      headers: { Authorization: 'Bearer old-header-secret' },
    };

    expect(() => restoreRedactedTransport(next, existing)).toThrow(
      'Re-enter MCP transport secrets when changing the MCP transport target'
    );
  });

  it('restores matching HTTP header and ordered query placeholders on the same target', () => {
    const next: McpTransportConfig = {
      type: 'http',
      url: `https://mcp.example.com/v1/mcp?flag&api_key=${REDACTED}&api_key=${REDACTED}&missing=${REDACTED}&explicit=new-value#section`,
      headers: { Authorization: REDACTED, 'x-explicit': 'new-header', 'x-missing': REDACTED },
    };
    const existing: McpTransportConfig = {
      type: 'http',
      url: 'https://mcp.example.com/v1/mcp?flag&api_key=first-secret&api_key=second-secret#old',
      headers: { Authorization: 'Bearer header-secret', 'x-explicit': 'old-header' },
    };

    const restored = restoreRedactedTransport(next, existing);

    expect(restored).toEqual({
      type: 'http',
      url: `https://mcp.example.com/v1/mcp?flag&api_key=first-secret&api_key=second-secret&missing=${REDACTED}&explicit=new-value#section`,
      headers: {
        Authorization: 'Bearer header-secret',
        'x-explicit': 'new-header',
        'x-missing': REDACTED,
      },
    });
    expect(restored).not.toBe(next);
    expect(next.headers?.Authorization).toBe(REDACTED);
  });

  it('restores matching SSE secrets without treating query and fragment changes as a new target', () => {
    const next: McpTransportConfig = {
      type: 'sse',
      url: `https://mcp.example.com/events?api_key=${REDACTED}&explicit=new-value#next`,
      headers: { Authorization: REDACTED },
    };
    const existing: McpTransportConfig = {
      type: 'sse',
      url: 'https://mcp.example.com/events?api_key=existing-query-secret#previous',
      headers: { Authorization: 'Bearer existing-header-secret' },
    };

    expect(restoreRedactedTransport(next, existing)).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com/events?api_key=existing-query-secret&explicit=new-value#next',
      headers: { Authorization: 'Bearer existing-header-secret' },
    });
    expect(next.url).toContain(REDACTED);
    expect(next.headers?.Authorization).toBe(REDACTED);
  });

  it.each([
    [
      'HTTP transport without placeholders',
      { type: 'http' as const, url: 'https://mcp.example.com/v1/mcp', headers: { Authorization: 'new-token' } },
      { type: 'http' as const, url: 'https://mcp.example.com/v1/mcp', headers: { Authorization: 'old-token' } },
    ],
    [
      'HTTP transport whose existing URL has no query',
      { type: 'http' as const, url: `https://mcp.example.com/v1/mcp?api_key=${REDACTED}` },
      { type: 'http' as const, url: 'https://mcp.example.com/v1/mcp' },
    ],
    [
      'stdio transport without env',
      { type: 'stdio' as const, command: 'sample-mcp' },
      { type: 'stdio' as const, command: 'sample-mcp' },
    ],
  ])('preserves identity for %s', (_label, next, existing) => {
    expect(restoreRedactedTransport(next, existing)).toBe(next);
  });

  it('preserves an unmatched HTTP query placeholder without allocating a replacement transport', () => {
    const next: McpTransportConfig = {
      type: 'http',
      url: `https://mcp.example.com/v1/mcp?api_key=${REDACTED}`,
    };
    const existing: McpTransportConfig = {
      type: 'http',
      url: 'https://mcp.example.com/v1/mcp?workspace=existing-workspace',
    };

    expect(restoreRedactedTransport(next, existing)).toBe(next);
  });

  it('restores stdio env placeholders when the command target is unchanged', () => {
    const next: McpTransportConfig = {
      type: 'stdio',
      command: 'sample-mcp',
      args: ['--stdio'],
      env: { API_TOKEN: REDACTED, MODE: 'new-mode', MISSING: REDACTED },
    };
    const existing: McpTransportConfig = {
      type: 'stdio',
      command: 'sample-mcp',
      args: ['--stdio'],
      env: { API_TOKEN: 'existing-token', MODE: 'old-mode' },
    };

    expect(restoreRedactedTransport(next, existing)).toEqual({
      ...next,
      env: { API_TOKEN: 'existing-token', MODE: 'new-mode', MISSING: REDACTED },
    });
  });

  it('requires stdio env secrets to be re-entered when command arguments change', () => {
    const next: McpTransportConfig = {
      type: 'stdio',
      command: 'sample-mcp',
      args: ['--other'],
      env: { API_TOKEN: REDACTED },
    };
    const existing: McpTransportConfig = {
      type: 'stdio',
      command: 'sample-mcp',
      args: ['--stdio'],
      env: { API_TOKEN: 'existing-token' },
    };

    expect(() => restoreRedactedTransport(next, existing)).toThrow(
      'Re-enter MCP transport secrets when changing the MCP transport target'
    );
  });

  it('keeps explicit stdio env values when a command target changes', () => {
    const next: McpTransportConfig = {
      type: 'stdio',
      command: 'other-mcp',
      env: { API_TOKEN: 'replacement-token' },
    };
    const existing: McpTransportConfig = {
      type: 'stdio',
      command: 'sample-mcp',
      env: { API_TOKEN: 'existing-token' },
    };

    expect(restoreRedactedTransport(next, existing)).toBe(next);
  });
});
