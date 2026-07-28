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

import { enableMcp, inspectMcpEnablement, McpEnablementError, type McpEnablementDependencies } from './mcpEnablement';

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
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }) as jest.MockedFunction<typeof fetch>;
}

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

  await expect(enableMcp({}, deps)).resolves.toEqual({
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
  const fetcher = successfulFetch();
  fetcher.mockImplementationOnce(async () => json(discovery()));
  fetcher.mockImplementationOnce(async () =>
    json({ keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', n: 'modulus', e: 'AQAB' }] })
  );
  fetcher.mockImplementationOnce(async () => json({ error: 'insufficient_scope' }, 403));
  const deps = dependencies(fetcher);

  await expect(enableMcp({}, deps)).rejects.toMatchObject({
    code: 'mcp_registration_unavailable',
    httpStatus: 409,
  });
  expect(deps.provision).toHaveBeenCalledTimes(1);
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
