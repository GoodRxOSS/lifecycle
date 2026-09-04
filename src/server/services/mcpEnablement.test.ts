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

const mockLoggerWarn = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: (...args: unknown[]) => mockLoggerWarn(...args) }),
}));

import {
  enableMcp,
  hasMcpApplicationSigningKey,
  inspectMcpEnablement,
  McpEnablementError,
  type McpEnablementDependencies,
} from './mcpEnablement';
import { McpProvisioningError } from './keycloak/mcpProvisioning';

const issuer = 'http://localhost/realms/lifecycle';
const internalJwksUrl = 'http://keycloak.lifecycle.svc.cluster.local/realms/lifecycle/certs';
const publicJwksUrl = `${issuer}/protocol/openid-connect/certs`;
const registrationUrl = `${issuer}/clients-registrations/openid-connect`;
const registrationClientUrl = `${registrationUrl}/probe-client`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function discovery(jwksUri = publicJwksUrl): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    jwks_uri: jwksUri,
    registration_endpoint: registrationUrl,
    code_challenge_methods_supported: ['S256'],
  };
}

function successfulFetch(): jest.MockedFunction<typeof fetch> {
  return jest.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return json(discovery());
    if (url === publicJwksUrl) {
      return json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] });
    }
    if (url === registrationUrl && init?.method === 'POST') {
      return json(
        {
          client_id: 'probe-client',
          registration_client_uri: registrationClientUrl,
          registration_access_token: 'delete-probe-client',
        },
        201
      );
    }
    if (url === registrationClientUrl && init?.method === 'DELETE') {
      return new Response('discarded cleanup response', { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as jest.MockedFunction<typeof fetch>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

function dependencies(
  fetcher = successfulFetch(),
  overrides: Partial<McpEnablementDependencies> = {}
): McpEnablementDependencies {
  return {
    env: {
      NODE_ENV: 'production',
      KEYCLOAK_ISSUER: issuer,
      KEYCLOAK_JWKS_URL: internalJwksUrl,
      KEYCLOAK_MANAGEMENT_CLIENT_ID: 'lifecycle-api-keycloak-management',
      KEYCLOAK_MANAGEMENT_CLIENT_SECRET: 'management-secret',
      ENCRYPTION_KEY: 'a'.repeat(64),
    },
    fetch: fetcher,
    isServingProcess: () => true,
    loadRuntimeConfig: () => ({
      authEnabled: true,
      maxWaitSeconds: 50,
      resourceUrl: 'http://localhost:3000/mcp',
    }),
    provision: jest.fn(async () => undefined),
    timeoutMs: 100,
    ...overrides,
  };
}

it('recognizes a trimmed, case-insensitive application signing key from the default environment', () => {
  const original = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = `  ${'A'.repeat(64)}  `;
  try {
    expect(hasMcpApplicationSigningKey()).toBe(true);
  } finally {
    if (original === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = original;
    }
  }
});

it('returns an endpoint issue without calling later dependencies when runtime configuration cannot load', () => {
  const fetcher = successfulFetch();
  const isServingProcess = jest.fn();
  const provision = jest.fn();

  expect(
    inspectMcpEnablement(undefined, {
      ...dependencies(fetcher),
      loadRuntimeConfig: () => {
        throw new Error('invalid APP_HOST');
      },
      isServingProcess,
      provision,
    })
  ).toEqual({
    ok: false,
    endpoint: null,
    issue: {
      code: 'mcp_endpoint_invalid',
      message: 'Lifecycle APP_HOST is not configured as a valid public URL.',
    },
  });
  expect(isServingProcess).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(provision).not.toHaveBeenCalled();
});

it('reports that MCP is unavailable outside the serving process and stops local inspection', () => {
  const fetcher = successfulFetch();
  const deps = dependencies(fetcher, { isServingProcess: () => false });

  expect(inspectMcpEnablement({}, deps)).toEqual({
    ok: false,
    endpoint: 'http://localhost:3000/mcp',
    issue: {
      code: 'mcp_not_available',
      message: 'Lifecycle MCP is served only by the Lifecycle web process.',
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(deps.provision).not.toHaveBeenCalled();
});

it('rejects a malformed runtime endpoint before checking authentication or networking', () => {
  const fetcher = successfulFetch();
  const deps = dependencies(fetcher, {
    loadRuntimeConfig: () => ({ authEnabled: true, maxWaitSeconds: 50, resourceUrl: 'not a URL' }),
  });

  expect(inspectMcpEnablement({}, deps)).toEqual({
    ok: false,
    endpoint: null,
    issue: {
      code: 'mcp_endpoint_invalid',
      message: 'Lifecycle APP_HOST is not configured as a valid public URL.',
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(deps.provision).not.toHaveBeenCalled();
});

it('requires Lifecycle authentication before checking OAuth provider configuration', () => {
  const fetcher = successfulFetch();
  const deps = dependencies(fetcher, {
    loadRuntimeConfig: () => ({
      authEnabled: false,
      maxWaitSeconds: 50,
      resourceUrl: 'http://localhost:3000/mcp',
    }),
  });

  expect(inspectMcpEnablement({}, deps)).toEqual({
    ok: false,
    endpoint: 'http://localhost:3000/mcp',
    issue: {
      code: 'mcp_oauth_not_configured',
      message: 'Enable Lifecycle authentication before turning on Lifecycle MCP.',
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(deps.provision).not.toHaveBeenCalled();
});

it('requires OAuth provider configuration before checking management credentials', () => {
  const fetcher = successfulFetch();
  const deps = dependencies(fetcher);
  delete deps.env.KEYCLOAK_ISSUER;

  expect(inspectMcpEnablement({}, deps)).toEqual({
    ok: false,
    endpoint: 'http://localhost:3000/mcp',
    issue: {
      code: 'mcp_oauth_not_configured',
      message: 'Configure Lifecycle OAuth issuer and signing keys before turning on Lifecycle MCP.',
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(deps.provision).not.toHaveBeenCalled();
});

it('requires Keycloak management credentials before public verification', () => {
  const fetcher = successfulFetch();
  const deps = dependencies(fetcher);
  delete deps.env.KEYCLOAK_MANAGEMENT_CLIENT_SECRET;

  expect(inspectMcpEnablement({}, deps)).toEqual({
    ok: false,
    endpoint: 'http://localhost:3000/mcp',
    issue: {
      code: 'mcp_keycloak_not_configured',
      message: 'Complete Lifecycle MCP sign-in setup before turning it on.',
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(deps.provision).not.toHaveBeenCalled();
});

it('keeps inspection local and allows a production loopback endpoint', () => {
  const fetcher = successfulFetch();
  const deps = dependencies(fetcher);

  expect(inspectMcpEnablement({}, deps)).toEqual({
    ok: true,
    endpoint: 'http://localhost:3000/mcp',
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(deps.provision).not.toHaveBeenCalled();
});

it('rejects a remote HTTP endpoint even outside enablement networking', () => {
  const result = inspectMcpEnablement(
    {},
    dependencies(successfulFetch(), {
      loadRuntimeConfig: () => ({
        authEnabled: true,
        maxWaitSeconds: 50,
        resourceUrl: 'http://lifecycle.example.com/mcp',
      }),
    })
  );

  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      issue: expect.objectContaining({ code: 'mcp_endpoint_invalid' }),
    })
  );
});

it('verifies public OAuth, provisions, then probes and cleans up a ported-loopback registration', async () => {
  const fetcher = successfulFetch();
  const deps = dependencies(fetcher);

  await expect(enableMcp(undefined, deps)).resolves.toEqual({
    ok: true,
    endpoint: 'http://localhost:3000/mcp',
  });
  expect(deps.provision).toHaveBeenCalledWith('http://localhost:3000/mcp', deps.env);
  expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
    `${issuer}/.well-known/openid-configuration`,
    publicJwksUrl,
    registrationUrl,
    registrationClientUrl,
  ]);
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST', 'DELETE']);
  const provisionOrder = (deps.provision as jest.Mock).mock.invocationCallOrder[0];
  expect(provisionOrder).toBeGreaterThan(fetcher.mock.invocationCallOrder[1]);
  expect(provisionOrder).toBeLessThan(fetcher.mock.invocationCallOrder[2]);
  expect(fetcher.mock.calls[2][1]).toEqual(
    expect.objectContaining({
      body: expect.stringContaining('"redirect_uris":["http://127.0.0.1:53987/callback"]'),
      redirect: 'error',
    })
  );
  expect(fetcher.mock.calls[3][1]).toEqual(
    expect.objectContaining({
      headers: { Authorization: 'Bearer delete-probe-client' },
      redirect: 'error',
    })
  );
});

it('refuses enablement when Keycloak rejects a ported-loopback registration after provisioning', async () => {
  const cancel = jest.fn();
  const rejectedBody = new ReadableStream<Uint8Array>({ cancel });
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(async () => new Response(rejectedBody, { status: 403 }));
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_registration_unavailable',
    httpStatus: 409,
  });
  expect(deps.provision).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST']);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('handles a bodyless ported-loopback registration rejection', async () => {
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(async () => new Response(null, { status: 403 }));
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_registration_unavailable',
    httpStatus: 409,
  });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST']);
});

it('does not follow an untrusted registration cleanup URI', async () => {
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(async () =>
    json(
      {
        client_id: 'probe-client',
        registration_client_uri: 'https://attacker.example/probe-client',
        registration_access_token: 'do-not-send',
      },
      201
    )
  );
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('rejects incomplete registration cleanup credentials without issuing a DELETE', async () => {
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(async () =>
    json(
      {
        client_id: 'probe-client',
        registration_client_uri: registrationClientUrl,
      },
      201
    )
  );
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(deps.provision).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST']);
});

it('cancels an unsuccessful cleanup response and reports dynamic registration as unavailable', async () => {
  const cancel = jest.fn();
  const rejectedBody = new ReadableStream<Uint8Array>({ cancel });
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(async () =>
    json(
      {
        client_id: 'probe-client',
        registration_client_uri: registrationClientUrl,
        registration_access_token: 'delete-probe-client',
      },
      201
    )
  );
  fetcher.mockImplementationOnce(async () => new Response(rejectedBody, { status: 502 }));
  const deps = dependencies(fetcher);

  await expect(enableMcp({ requestId: 'cleanup-request' }, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[3][1]).toEqual(
    expect.objectContaining({
      method: 'DELETE',
      headers: { Authorization: 'Bearer delete-probe-client' },
    })
  );
  expect(mockLoggerWarn).toHaveBeenCalledWith(
    { error: { name: 'Error' }, requestId: 'cleanup-request' },
    'MCP enablement dynamic registration verification failed'
  );
});

it('handles a bodyless cleanup rejection without masking its HTTP failure', async () => {
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(async () =>
    json(
      {
        client_id: 'probe-client',
        registration_client_uri: registrationClientUrl,
        registration_access_token: 'delete-probe-client',
      },
      201
    )
  );
  fetcher.mockImplementationOnce(async () => new Response(null, { status: 502 }));
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST', 'DELETE']);
});

it('aborts a hanging dynamic registration request after provisioning', async () => {
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
  );
  const deps = dependencies(fetcher, { timeoutMs: 5 });

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(deps.provision).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST']);
});

it('fails without provisioning when the public advertised JWKS is unavailable', async () => {
  const unreachablePublicJwks = `${issuer}/public-certs`;
  const fetcher = jest.fn(async (input) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json(discovery(unreachablePublicJwks));
    }
    if (url === unreachablePublicJwks) return new Response(null, { status: 503 });
    if (url === internalJwksUrl) {
      return json({ keys: [{ kty: 'RSA', alg: 'RS256', n: 'modulus', e: 'AQAB' }] });
    }
    return new Response(null, { status: 404 });
  }) as jest.MockedFunction<typeof fetch>;
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    name: 'McpEnablementError',
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(fetcher).not.toHaveBeenCalledWith(internalJwksUrl, expect.anything());
  expect(deps.provision).not.toHaveBeenCalled();
});

it('contains malformed discovery JSON, logs only the error class, and does not provision', async () => {
  const fetcher = jest.fn(async () => new Response('{invalid JSON', { status: 200 })) as jest.MockedFunction<
    typeof fetch
  >;
  const deps = dependencies(fetcher);

  await expect(enableMcp({ requestId: 'request-123' }, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(deps.provision).not.toHaveBeenCalled();
  expect(mockLoggerWarn).toHaveBeenCalledWith(
    { error: { name: 'Error' }, requestId: 'request-123' },
    'MCP enablement public OAuth verification failed'
  );
});

it.each([
  ['an issuer mismatch', { ...discovery(), issuer: 'http://localhost/realms/other' }],
  [
    'an unsafe authorization endpoint',
    { ...discovery(), authorization_endpoint: 'http://keycloak.example.com/authorize' },
  ],
])('rejects discovery with %s before fetching signing keys', async (_label, advertised) => {
  const fetcher = jest.fn(async () => json(advertised)) as unknown as jest.MockedFunction<typeof fetch>;
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
    httpStatus: 503,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(deps.provision).not.toHaveBeenCalled();
});

it('rejects a JWKS document without a usable RS256 signing key before provisioning', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(json(discovery()))
    .mockResolvedValueOnce(
      json({ keys: [{ kty: 'EC', use: 'sig', alg: 'ES256', x: 'x', y: 'y' }] })
    ) as jest.MockedFunction<typeof fetch>;
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_not_configured',
    httpStatus: 409,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(deps.provision).not.toHaveBeenCalled();
});

it('rejects malformed JWKS metadata without provisioning', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(json(discovery()))
    .mockResolvedValueOnce(json({ issuer })) as jest.MockedFunction<typeof fetch>;
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_oauth_not_configured',
    httpStatus: 409,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(deps.provision).not.toHaveBeenCalled();
});

it('accepts an RSA signing key without optional use or alg metadata and a bodyless cleanup response', async () => {
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () => json({ keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] }));
  fetcher.mockImplementationOnce(async () =>
    json(
      {
        client_id: 'probe-client',
        registration_client_uri: registrationClientUrl,
        registration_access_token: 'delete-probe-client',
      },
      201
    )
  );
  fetcher.mockImplementationOnce(async () => new Response(null, { status: 204 }));
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).resolves.toEqual({
    ok: true,
    endpoint: 'http://localhost:3000/mcp',
  });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST', 'DELETE']);
});

it.each([
  [new McpProvisioningError('mcp_keycloak_unavailable', 'Keycloak is unavailable'), 'mcp_keycloak_unavailable', 503],
  [new McpProvisioningError('mcp_keycloak_conflict', 'Keycloak state conflicts'), 'mcp_keycloak_conflict', 409],
  [new Error('unexpected provisioning failure'), 'mcp_keycloak_unavailable', 503],
] as const)(
  'maps provisioning failure %# and does not create a probe client',
  async (provisioningError, code, status) => {
    const fetcher = successfulFetch();
    const provision = jest.fn().mockRejectedValue(provisioningError);
    const deps = dependencies(fetcher, { provision });

    await expect(enableMcp({}, deps)).rejects.toMatchObject({
      name: 'McpEnablementError',
      code,
      httpStatus: status,
      cause: provisioningError,
    });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${issuer}/.well-known/openid-configuration`,
      publicJwksUrl,
    ]);
    expect(provision).toHaveBeenCalledTimes(1);
  }
);

it.each([undefined, '', 'not-hex', 'a'.repeat(63)])(
  'does not provision or fetch when the application encryption key is invalid (%p)',
  async (encryptionKey) => {
    const deps = dependencies();
    if (encryptionKey === undefined) {
      delete deps.env.ENCRYPTION_KEY;
    } else {
      deps.env.ENCRYPTION_KEY = encryptionKey;
    }

    await expect(enableMcp({}, deps)).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        issue: expect.objectContaining({
          code: 'mcp_application_signing_unavailable',
          message: 'Configure Lifecycle application encryption before turning on Lifecycle MCP.',
        }),
      })
    );
    expect(deps.provision).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  }
);

it('requires PKCE S256 and dynamic registration metadata', async () => {
  for (const advertised of [
    { ...discovery(), code_challenge_methods_supported: ['plain'] },
    { ...discovery(), code_challenge_methods_supported: undefined },
    { ...discovery(), registration_endpoint: undefined },
  ]) {
    const fetcher = jest.fn(async () => json(advertised)) as unknown as jest.MockedFunction<typeof fetch>;
    await expect(enableMcp({}, dependencies(fetcher))).rejects.toBeInstanceOf(McpEnablementError);
  }
});

it('cancels a chunked provider document as soon as it exceeds the byte limit', async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(200_000));
      controller.enqueue(new Uint8Array(100_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = jest.fn(async () => new Response(oversized)) as unknown as jest.MockedFunction<typeof fetch>;

  await expect(enableMcp({}, dependencies(fetcher))).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
  });
  expect(cancelled).toBe(true);
});

it('keeps the timeout active while a response body is streaming', async () => {
  const fetcher = jest.fn(async (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
    });
    return new Response(body);
  }) as jest.MockedFunction<typeof fetch>;

  await expect(enableMcp({}, dependencies(fetcher, { timeoutMs: 5 }))).rejects.toMatchObject({
    code: 'mcp_oauth_unavailable',
  });
});
