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
  deriveKeycloakAdminBaseUrl,
  KeycloakAdminClient,
  KeycloakAdminError,
  type KeycloakAdminClientOptions,
} from './adminClient';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type ClientOverrides = Partial<
  Pick<
    KeycloakAdminClientOptions,
    'issuer' | 'adminBaseUrl' | 'clientId' | 'clientSecret' | 'timeoutMs' | 'allowInternalHttp'
  >
>;

function client(fetcher: typeof fetch, overrides: ClientOverrides = {}) {
  return new KeycloakAdminClient({
    issuer: overrides.issuer ?? 'https://auth.example.com/realms/lifecycle',
    adminBaseUrl: overrides.adminBaseUrl ?? 'https://auth.example.com/admin/realms/lifecycle',
    clientId: overrides.clientId ?? 'management-client',
    clientSecret: overrides.clientSecret ?? 'management-secret',
    fetch: fetcher,
    timeoutMs: overrides.timeoutMs ?? 100,
    allowInternalHttp: overrides.allowInternalHttp,
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('exposes stable error metadata and only attaches a supplied cause', () => {
  const withoutCause = new KeycloakAdminError('not_found', 404, 'missing');
  const cause = new Error('provider detail');
  const withCause = new KeycloakAdminError('unavailable', null, 'unreachable', { cause });

  expect(withoutCause).toMatchObject({
    name: 'KeycloakAdminError',
    kind: 'not_found',
    status: 404,
    message: 'missing',
  });
  expect('cause' in withoutCause).toBe(false);
  expect(withCause).toMatchObject({
    name: 'KeycloakAdminError',
    kind: 'unavailable',
    status: null,
    message: 'unreachable',
    cause,
  });
});

describe('configuration', () => {
  it.each([
    ['https://auth.example.com/realms/lifecycle', 'https://auth.example.com/admin/realms/lifecycle'],
    ['https://auth.example.com/auth/realms/lifecycle/', 'https://auth.example.com/auth/admin/realms/lifecycle'],
    [
      'https://auth.example.com/root/realms/outer/realms/inner',
      'https://auth.example.com/root/realms/outer/admin/realms/inner',
    ],
  ])('derives the admin base URL from %s', (issuer, expected) => {
    expect(deriveKeycloakAdminBaseUrl(issuer)).toBe(expected);
  });

  it.each([
    'not a URL',
    'https://auth.example.com/',
    'https://auth.example.com/realms',
    'https://auth.example.com/realms/lifecycle/clients',
  ])('does not derive an admin base URL from %s', (issuer) => {
    expect(deriveKeycloakAdminBaseUrl(issuer)).toBeNull();
  });

  it.each([
    ['not a URL', 'not a valid URL'],
    ['ftp://auth.example.com/realms/lifecycle', 'not a canonical HTTP(S) URL'],
    ['https://user@auth.example.com/realms/lifecycle', 'not a canonical HTTP(S) URL'],
    ['https://:secret@auth.example.com/realms/lifecycle', 'not a canonical HTTP(S) URL'],
    ['https://auth.example.com/realms/lifecycle?prompt=login', 'not a canonical HTTP(S) URL'],
    ['https://auth.example.com/realms/lifecycle#fragment', 'not a canonical HTTP(S) URL'],
  ])('rejects a non-canonical issuer %s', (issuer, message) => {
    const fetcher = jest.fn() as jest.MockedFunction<typeof fetch>;

    expect(() => client(fetcher, { issuer })).toThrow(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('identifies an invalid admin base URL in its configuration error', () => {
    expect(() =>
      client(jest.fn() as jest.MockedFunction<typeof fetch>, {
        adminBaseUrl: 'invalid admin URL',
      })
    ).toThrow('Keycloak admin base URL is not a valid URL.');
  });

  it.each([
    ['   ', 'management-secret'],
    ['management-client', '   '],
  ])('rejects blank management credentials before making a request', (clientId, clientSecret) => {
    const fetcher = jest.fn() as jest.MockedFunction<typeof fetch>;

    expect(() => client(fetcher, { clientId, clientSecret })).toThrow(
      'Keycloak management credentials are not configured.'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows loopback HTTP without an internal-network override and normalizes trailing slashes', () => {
    const configured = client(jest.fn() as jest.MockedFunction<typeof fetch>, {
      issuer: 'http://localhost:8080/realms/lifecycle///',
      adminBaseUrl: 'http://127.0.0.1:8080/admin/realms/lifecycle///',
    });

    expect(configured.issuer).toBe('http://localhost:8080/realms/lifecycle');
    expect(configured.adminBaseUrl).toBe('http://127.0.0.1:8080/admin/realms/lifecycle');
  });
});

it('keeps token caches isolated per credential profile', async () => {
  const tokenCalls: string[] = [];
  const adminAuthorizations: string[] = [];
  const fetcher = jest.fn(async (input, init) => {
    if (String(input).endsWith('/token')) {
      const clientId = new URLSearchParams(String(init?.body)).get('client_id')!;
      tokenCalls.push(clientId);
      return json({ access_token: `token-for-${clientId}`, expires_in: 300 });
    }
    adminAuthorizations.push(new Headers(init?.headers).get('authorization')!);
    return json([]);
  }) as jest.MockedFunction<typeof fetch>;

  const management = client(fetcher, { clientId: 'management' });
  const principalSync = client(fetcher, { clientId: 'principal-sync' });
  await management.get('/clients');
  await principalSync.get('/clients');
  await management.get('/roles');

  expect(tokenCalls).toEqual(['management', 'principal-sync']);
  expect(adminAuthorizations).toEqual([
    'Bearer token-for-management',
    'Bearer token-for-principal-sync',
    'Bearer token-for-management',
  ]);
});

it('uses the default token lifetime and refreshes at the expiry safety margin', async () => {
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  let tokenNumber = 0;
  const adminAuthorizations: string[] = [];
  const fetcher = jest.fn(async (input, init) => {
    if (String(input).endsWith('/token')) {
      tokenNumber += 1;
      return json({ access_token: `token-${tokenNumber}` });
    }
    adminAuthorizations.push(new Headers(init?.headers).get('authorization')!);
    return json({ ok: true });
  }) as jest.MockedFunction<typeof fetch>;
  const configured = client(fetcher);

  await configured.get('/clients');
  now += 29_999;
  await configured.get('/roles');
  now += 1;
  await configured.get('/groups');

  expect(tokenNumber).toBe(2);
  expect(adminAuthorizations).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
});

it.each([
  ['null payload', 'null'],
  ['array payload', '[]'],
  ['missing access token', '{}'],
  ['empty access token', '{"access_token":""}'],
  ['non-string access token', '{"access_token":42}'],
  ['non-numeric expiry', '{"access_token":"token","expires_in":"60"}'],
  ['non-finite expiry', '{"access_token":"token","expires_in":1e400}'],
  ['zero expiry', '{"access_token":"token","expires_in":0}'],
  ['negative expiry', '{"access_token":"token","expires_in":-1}'],
])('rejects a %s from the token endpoint without calling the admin API', async (_label, tokenBody) => {
  const fetcher = jest.fn(
    async () => new Response(tokenBody, { headers: { 'content-type': 'application/json' } })
  ) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).rejects.toMatchObject({
    kind: 'invalid_response',
    status: 200,
    message: 'Keycloak returned an invalid token response.',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/protocol\/openid-connect\/token$/);
});

it.each([
  [401, 'unauthorized'],
  [422, 'bad_request'],
] as const)('maps token endpoint HTTP %s to %s without calling the admin API', async (status, kind) => {
  const fetcher = jest.fn(async () => new Response(null, { status })) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).rejects.toMatchObject({ kind, status });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('requires an explicit internal allowance before sending credentials over remote HTTP', () => {
  expect(
    () =>
      new KeycloakAdminClient({
        issuer: 'http://keycloak.lifecycle.svc.cluster.local/realms/lifecycle',
        adminBaseUrl: 'http://keycloak.lifecycle.svc.cluster.local/admin/realms/lifecycle',
        clientId: 'management',
        clientSecret: 'management-secret',
      })
  ).toThrow('must use HTTPS unless KEYCLOAK_ISSUER_INTERNAL is set or the host is loopback');

  expect(
    () =>
      new KeycloakAdminClient({
        issuer: 'http://keycloak.lifecycle.svc.cluster.local/realms/lifecycle',
        adminBaseUrl: 'http://keycloak.lifecycle.svc.cluster.local/admin/realms/lifecycle',
        clientId: 'management',
        clientSecret: 'management-secret',
        allowInternalHttp: true,
      })
  ).not.toThrow();
});

it('rejects unsafe admin paths before requesting a token', async () => {
  const fetcher = jest.fn() as jest.MockedFunction<typeof fetch>;
  const configured = client(fetcher);

  await expect(configured.get('clients')).rejects.toMatchObject({
    kind: 'bad_request',
    status: null,
    message: 'Keycloak Admin API paths must be relative.',
  });
  await expect(configured.get('//attacker.example/clients')).rejects.toMatchObject({
    kind: 'bad_request',
    status: null,
    message: 'Keycloak Admin API paths must be relative.',
  });
  await expect(configured.get('/\\attacker.example/clients')).rejects.toMatchObject({
    kind: 'bad_request',
    status: null,
    message: 'Keycloak Admin API path is invalid.',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it('constructs requests for every public method and normalizes successful empty responses', async () => {
  const adminRequests: Array<{ url: string; init: RequestInit }> = [];
  let deleteCount = 0;
  const fetcher = jest.fn(async (input, init) => {
    if (String(input).endsWith('/token')) {
      return json({ access_token: 'management-token', expires_in: 300 });
    }
    adminRequests.push({ url: String(input), init: init! });
    if (init?.method === 'GET') return json({ id: 'client-1' });
    if (init?.method === 'POST') return new Response('ignored', { status: 201 });
    if (init?.method === 'PUT') return new Response(null, { status: 204 });
    deleteCount += 1;
    return deleteCount === 1
      ? new Response('not-json', { headers: { 'content-length': '0' } })
      : new Response(null, { status: 204 });
  }) as jest.MockedFunction<typeof fetch>;
  const configured = client(fetcher, {
    issuer: 'https://auth.example.com/realms/lifecycle///',
    adminBaseUrl: 'https://auth.example.com/admin/realms/lifecycle///',
    clientId: '  management-client  ',
    clientSecret: '  management-secret  ',
  });

  await expect(configured.get('/clients?first=0&max=10')).resolves.toEqual({ id: 'client-1' });
  await expect(configured.post('/clients', { clientId: 'new-client' })).resolves.toBeUndefined();
  await expect(configured.put('/clients/client-1', { enabled: true })).resolves.toBeUndefined();
  await expect(configured.delete('/roles/obsolete', { id: 'role-1' })).resolves.toBeUndefined();
  await expect(configured.delete('/roles/unused')).resolves.toBeUndefined();

  const tokenCall = fetcher.mock.calls[0];
  expect(tokenCall[0]).toBe('https://auth.example.com/realms/lifecycle/protocol/openid-connect/token');
  expect(tokenCall[1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
  );
  expect(new Headers(tokenCall[1]?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(new URLSearchParams(String(tokenCall[1]?.body)))).toEqual({
    grant_type: 'client_credentials',
    client_id: 'management-client',
    client_secret: 'management-secret',
  });

  expect(adminRequests.map(({ url }) => url)).toEqual([
    'https://auth.example.com/admin/realms/lifecycle/clients?first=0&max=10',
    'https://auth.example.com/admin/realms/lifecycle/clients',
    'https://auth.example.com/admin/realms/lifecycle/clients/client-1',
    'https://auth.example.com/admin/realms/lifecycle/roles/obsolete',
    'https://auth.example.com/admin/realms/lifecycle/roles/unused',
  ]);
  expect(
    adminRequests.map(({ init }) => ({
      method: init.method,
      authorization: new Headers(init.headers).get('authorization'),
      accept: new Headers(init.headers).get('accept'),
      contentType: new Headers(init.headers).get('content-type'),
      body: init.body,
      redirect: init.redirect,
      hasSignal: init.signal instanceof AbortSignal,
    }))
  ).toEqual([
    {
      method: 'GET',
      authorization: 'Bearer management-token',
      accept: 'application/json',
      contentType: null,
      body: undefined,
      redirect: 'error',
      hasSignal: true,
    },
    {
      method: 'POST',
      authorization: 'Bearer management-token',
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify({ clientId: 'new-client' }),
      redirect: 'error',
      hasSignal: true,
    },
    {
      method: 'PUT',
      authorization: 'Bearer management-token',
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true }),
      redirect: 'error',
      hasSignal: true,
    },
    {
      method: 'DELETE',
      authorization: 'Bearer management-token',
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify({ id: 'role-1' }),
      redirect: 'error',
      hasSignal: true,
    },
    {
      method: 'DELETE',
      authorization: 'Bearer management-token',
      accept: 'application/json',
      contentType: null,
      body: undefined,
      redirect: 'error',
      hasSignal: true,
    },
  ]);
});

it('uses the global fetch implementation and default timeout when no overrides are provided', async () => {
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) =>
      String(input).endsWith('/token')
        ? json({ access_token: 'global-token', expires_in: 300 })
        : json({ source: 'global' })
    );
  const configured = new KeycloakAdminClient({
    issuer: 'https://auth.example.com/realms/lifecycle',
    adminBaseUrl: 'https://auth.example.com/admin/realms/lifecycle',
    clientId: 'management-client',
    clientSecret: 'management-secret',
  });

  await expect(configured.get('/clients')).resolves.toEqual({ source: 'global' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('refreshes once after a 401 and never includes response bodies in errors', async () => {
  let tokenNumber = 0;
  const fetcher = jest.fn(async (input) => {
    if (String(input).endsWith('/token')) {
      tokenNumber += 1;
      return json({ access_token: `token-${tokenNumber}`, expires_in: 300 });
    }
    if (tokenNumber === 1) return new Response('sensitive-provider-body', { status: 401 });
    return json({ ok: true });
  }) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).resolves.toEqual({ ok: true });
  expect(tokenNumber).toBe(2);

  const forbidden = jest.fn(async (input) =>
    String(input).endsWith('/token')
      ? json({ access_token: 'token', expires_in: 300 })
      : new Response('sensitive-provider-body', { status: 403 })
  ) as jest.MockedFunction<typeof fetch>;
  const error = await client(forbidden)
    .get('/clients')
    .catch((caught) => caught);
  expect(error).toMatchObject({ kind: 'forbidden', status: 403 });
  expect(String(error)).not.toContain('sensitive-provider-body');
});

it('stops after one token refresh when Keycloak keeps returning 401', async () => {
  let tokenNumber = 0;
  const adminAuthorizations: string[] = [];
  const fetcher = jest.fn(async (input, init) => {
    if (String(input).endsWith('/token')) {
      tokenNumber += 1;
      return json({ access_token: `token-${tokenNumber}`, expires_in: 300 });
    }
    adminAuthorizations.push(new Headers(init?.headers).get('authorization')!);
    return new Response(null, { status: 401 });
  }) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).rejects.toMatchObject({
    kind: 'unauthorized',
    status: 401,
    message: 'Keycloak rejected the management credential.',
  });
  expect(tokenNumber).toBe(2);
  expect(adminAuthorizations).toEqual(['Bearer token-1', 'Bearer token-2']);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it.each([
  [400, 'bad_request'],
  [422, 'bad_request'],
  [404, 'not_found'],
  [409, 'conflict'],
  [429, 'rate_limited'],
  [500, 'unavailable'],
] as const)('maps HTTP %s to %s', async (status, kind) => {
  const fetcher = jest.fn(async (input) =>
    String(input).endsWith('/token') ? json({ access_token: 'token', expires_in: 300 }) : new Response(null, { status })
  ) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).rejects.toMatchObject({ kind, status });
});

it('preserves the network failure as the cause of an unavailable error', async () => {
  const networkFailure = new Error('connection refused');
  const fetcher = jest.fn(async () => {
    throw networkFailure;
  }) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).rejects.toEqual(
    expect.objectContaining({
      name: 'KeycloakAdminError',
      kind: 'unavailable',
      status: null,
      message: 'Lifecycle could not reach Keycloak.',
      cause: networkFailure,
    } satisfies Partial<KeycloakAdminError>)
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reports invalid JSON without exposing its contents and retains the parser failure', async () => {
  const fetcher = jest.fn(async (input) =>
    String(input).endsWith('/token')
      ? json({ access_token: 'token', expires_in: 300 })
      : new Response('{not valid json')
  ) as jest.MockedFunction<typeof fetch>;

  const error = await client(fetcher)
    .get('/clients')
    .catch((caught) => caught);
  expect(error).toMatchObject({
    kind: 'invalid_response',
    status: 200,
    message: 'Keycloak returned invalid JSON.',
    cause: expect.any(SyntaxError),
  });
  expect(String(error)).not.toContain('{not valid json');
});

it('reports an unreadable response and retains the stream failure', async () => {
  const streamFailure = new Error('stream failed');
  const unreadable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(streamFailure);
    },
  });
  const fetcher = jest.fn(async (input) =>
    String(input).endsWith('/token') ? json({ access_token: 'token', expires_in: 300 }) : new Response(unreadable)
  ) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).rejects.toEqual(
    expect.objectContaining({
      kind: 'invalid_response',
      status: 200,
      message: 'Keycloak returned an unreadable response.',
      cause: streamFailure,
    } satisfies Partial<KeycloakAdminError>)
  );
});

it('cancels an undeclared chunked body once it exceeds the byte limit', async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(700_000));
      controller.enqueue(new Uint8Array(400_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = jest.fn(async (input) =>
    String(input).endsWith('/token') ? json({ access_token: 'token', expires_in: 300 }) : new Response(oversized)
  ) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher).get('/clients')).rejects.toMatchObject({
    kind: 'invalid_response',
    message: 'Keycloak returned an oversized response.',
  });
  expect(cancelled).toBe(true);
});

it('keeps its timeout active until the response body is consumed', async () => {
  jest.useFakeTimers();
  let signalRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    signalRequestStarted = resolve;
  });
  const fetcher = jest.fn(async (input, init) => {
    if (String(input).endsWith('/token')) {
      return json({ access_token: 'token', expires_in: 300 });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
    });
    signalRequestStarted();
    return new Response(body);
  }) as jest.MockedFunction<typeof fetch>;

  const request = client(fetcher, { timeoutMs: 5 }).get('/clients');
  await requestStarted;
  jest.advanceTimersByTime(5);

  await expect(request).rejects.toEqual(
    expect.objectContaining({ kind: 'unavailable' } satisfies Partial<KeycloakAdminError>)
  );
});
