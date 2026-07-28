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

import { readBoundedResponseText, ResponseBodyTooLargeError } from 'server/lib/readBoundedResponse';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_TTL_SECONDS = 60;
const TOKEN_EXPIRY_MARGIN_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type KeycloakAdminErrorKind =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response';

export class KeycloakAdminError extends Error {
  constructor(
    readonly kind: KeycloakAdminErrorKind,
    readonly status: number | null,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'KeycloakAdminError';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface KeycloakAdminClientOptions {
  issuer: string;
  adminBaseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  allowInternalHttp?: boolean;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

function canonicalBaseUrl(value: string, label: string, allowInternalHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new KeycloakAdminError('bad_request', null, `${label} is not a valid URL.`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new KeycloakAdminError('bad_request', null, `${label} is not a canonical HTTP(S) URL.`);
  }
  if (
    parsed.protocol === 'http:' &&
    !allowInternalHttp &&
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
  ) {
    throw new KeycloakAdminError(
      'bad_request',
      null,
      `${label} must use HTTPS unless KEYCLOAK_ISSUER_INTERNAL is set or the host is loopback.`
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

/** https://host[/prefix]/realms/<realm> -> https://host[/prefix]/admin/realms/<realm> */
export function deriveKeycloakAdminBaseUrl(issuer: string): string | null {
  try {
    const url = new URL(issuer);
    const segments = url.pathname.split('/').filter(Boolean);
    const realmsIndex = segments.lastIndexOf('realms');
    const realm = realmsIndex === -1 ? undefined : segments[realmsIndex + 1];
    if (!realm || realmsIndex + 2 !== segments.length) return null;
    return `${url.origin}/${[...segments.slice(0, realmsIndex), 'admin', 'realms', realm].join('/')}`;
  } catch {
    return null;
  }
}

function safePath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new KeycloakAdminError('bad_request', null, 'Keycloak Admin API paths must be relative.');
  }
  const parsed = new URL(path, 'https://keycloak.invalid');
  if (parsed.origin !== 'https://keycloak.invalid' || parsed.pathname.split('/').includes('..')) {
    throw new KeycloakAdminError('bad_request', null, 'Keycloak Admin API path is invalid.');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function errorForStatus(status: number): KeycloakAdminError {
  if (status === 400 || status === 422) {
    return new KeycloakAdminError('bad_request', status, 'Keycloak rejected the requested configuration.');
  }
  if (status === 401) {
    return new KeycloakAdminError('unauthorized', status, 'Keycloak rejected the management credential.');
  }
  if (status === 403) {
    return new KeycloakAdminError('forbidden', status, 'The Keycloak management credential lacks permission.');
  }
  if (status === 404) {
    return new KeycloakAdminError('not_found', status, 'The requested Keycloak object was not found.');
  }
  if (status === 409) {
    return new KeycloakAdminError('conflict', status, 'The requested Keycloak object conflicts with existing state.');
  }
  if (status === 429) {
    return new KeycloakAdminError('rate_limited', status, 'Keycloak is temporarily rate limiting management calls.');
  }
  return new KeycloakAdminError('unavailable', status, 'Keycloak could not complete the management request.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class KeycloakAdminClient {
  readonly issuer: string;
  readonly adminBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private token: CachedToken | null = null;

  constructor(options: KeycloakAdminClientOptions) {
    this.issuer = canonicalBaseUrl(options.issuer, 'Keycloak issuer', options.allowInternalHttp === true);
    this.adminBaseUrl = canonicalBaseUrl(
      options.adminBaseUrl,
      'Keycloak admin base URL',
      options.allowInternalHttp === true
    );
    if (!options.clientId.trim() || !options.clientSecret.trim()) {
      throw new KeycloakAdminError('bad_request', null, 'Keycloak management credentials are not configured.');
    }
    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async get<T>(path: string): Promise<T> {
    return this.requestJson<T>('GET', path);
  }

  async post(path: string, body: unknown): Promise<void> {
    await this.requestJson('POST', path, body);
  }

  async put(path: string, body: unknown): Promise<void> {
    await this.requestJson('PUT', path, body);
  }

  async delete(path: string, body?: unknown): Promise<void> {
    await this.requestJson('DELETE', path, body);
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS) {
      return this.token.accessToken;
    }

    const { payload, status } = await this.fetchWithTimeout(
      `${this.issuer}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }).toString(),
      },
      async (response) => {
        if (!response.ok) throw errorForStatus(response.status);
        return { payload: await this.readJson(response), status: response.status };
      }
    );
    if (
      !isRecord(payload) ||
      typeof payload.access_token !== 'string' ||
      !payload.access_token ||
      (payload.expires_in !== undefined &&
        (typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0))
    ) {
      throw new KeycloakAdminError('invalid_response', status, 'Keycloak returned an invalid token response.');
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : DEFAULT_TOKEN_TTL_SECONDS;
    this.token = {
      accessToken: payload.access_token,
      expiresAtMs: now + expiresIn * 1000,
    };
    return this.token.accessToken;
  }

  private async requestJson<T = void>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.adminBaseUrl}${safePath(path)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const result = await this.fetchWithTimeout(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        async (response) => {
          if (response.status === 401) return { unauthorized: true as const };
          if (!response.ok) throw errorForStatus(response.status);
          if (response.status === 204 || response.status === 201 || response.headers.get('content-length') === '0') {
            return { unauthorized: false as const, value: undefined as T };
          }
          return { unauthorized: false as const, value: (await this.readJson(response)) as T };
        }
      );
      if (result.unauthorized && attempt === 0) {
        this.token = null;
        continue;
      }
      if (result.unauthorized) throw errorForStatus(401);
      return result.value;
    }
    throw new KeycloakAdminError('unauthorized', 401, 'Keycloak rejected the management credential.');
  }

  private async readJson(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
    } catch (cause) {
      if (!(cause instanceof ResponseBodyTooLargeError)) {
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
        throw new KeycloakAdminError('invalid_response', response.status, 'Keycloak returned an unreadable response.', {
          cause,
        });
      }
      throw new KeycloakAdminError('invalid_response', response.status, 'Keycloak returned an oversized response.');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new KeycloakAdminError('invalid_response', response.status, 'Keycloak returned invalid JSON.', { cause });
    }
  }

  private async fetchWithTimeout<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal, redirect: 'error' });
      return await consume(response);
    } catch (cause) {
      if (cause instanceof KeycloakAdminError) throw cause;
      throw new KeycloakAdminError('unavailable', null, 'Lifecycle could not reach Keycloak.', { cause });
    } finally {
      clearTimeout(timeout);
    }
  }
}
