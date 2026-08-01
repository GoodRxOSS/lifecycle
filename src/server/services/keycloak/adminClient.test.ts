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

import { KeycloakAdminClient, KeycloakAdminError } from './adminClient';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetcher: typeof fetch, overrides: { clientId?: string; timeoutMs?: number } = {}) {
  return new KeycloakAdminClient({
    issuer: 'https://auth.example.com/realms/lifecycle',
    adminBaseUrl: 'https://auth.example.com/admin/realms/lifecycle',
    clientId: overrides.clientId ?? 'management-client',
    clientSecret: 'management-secret',
    fetch: fetcher,
    timeoutMs: overrides.timeoutMs ?? 100,
  });
}

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

it.each([
  [400, 'bad_request'],
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
    return new Response(body);
  }) as jest.MockedFunction<typeof fetch>;

  await expect(client(fetcher, { timeoutMs: 5 }).get('/clients')).rejects.toEqual(
    expect.objectContaining({ kind: 'unavailable' } satisfies Partial<KeycloakAdminError>)
  );
});
