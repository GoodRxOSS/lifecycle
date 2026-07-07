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

import { getLogger } from 'server/lib/logger';
import { LIFECYCLE_ROLES } from 'server/lib/roles';

const DEFAULT_PRINCIPAL_SYNC_CLIENT_ID = 'lifecycle-api-principal-sync';
const TOKEN_EXPIRY_MARGIN_MS = 30_000;
const DEFAULT_TOKEN_TTL_SECONDS = 60;
const FETCH_TIMEOUT_MS = 10_000;
const GROUPS_PAGE_LIMIT = 100;

const BASE_ROLES: ReadonlySet<string> = new Set(LIFECYCLE_ROLES);

export type KeycloakUserStatus = 'active' | 'disabled' | 'deleted' | 'no_base_role' | 'unknown';

interface RoleRepresentation {
  name?: string;
}

interface GroupRepresentation {
  id?: string;
  path?: string;
}

let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

function principalSyncClientId(): string {
  return process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID?.trim() || DEFAULT_PRINCIPAL_SYNC_CLIENT_ID;
}

function principalSyncClientSecret(): string | null {
  return process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET?.trim() || null;
}

function issuerUrl(): string | null {
  const issuer = process.env.KEYCLOAK_ISSUER_INTERNAL?.trim() || process.env.KEYCLOAK_ISSUER?.trim();
  return issuer ? issuer.replace(/\/+$/, '') : null;
}

/** https://host[/prefix]/realms/<realm> -> https://host[/prefix]/admin/realms/<realm> */
export function keycloakAdminBaseUrl(): string | null {
  const override = process.env.KEYCLOAK_ADMIN_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, '');

  const issuer = issuerUrl();
  if (!issuer) return null;
  try {
    const url = new URL(issuer);
    const segments = url.pathname.split('/').filter(Boolean);
    const realmsIndex = segments.lastIndexOf('realms');
    const realm = realmsIndex === -1 ? undefined : segments[realmsIndex + 1];
    if (!realm) return null;
    return `${url.origin}/${[...segments.slice(0, realmsIndex), 'admin', 'realms', realm].join('/')}`;
  } catch {
    return null;
  }
}

export function isConfigured(): boolean {
  return Boolean(principalSyncClientSecret() && issuerUrl() && keycloakAdminBaseUrl());
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS) {
    return cachedToken.accessToken;
  }

  const issuer = issuerUrl();
  const secret = principalSyncClientSecret();
  if (!issuer || !secret) return null;

  const response = await fetchWithTimeout(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: principalSyncClientId(),
      client_secret: secret,
    }).toString(),
  });
  if (!response.ok) {
    getLogger().warn(`KeycloakAdmin: token fetch failed status=${response.status}`);
    return null;
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) return null;

  cachedToken = {
    accessToken: payload.access_token,
    expiresAtMs: now + (payload.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
  };
  return cachedToken.accessToken;
}

async function adminGetJson<T>(url: string, token: string): Promise<T | null> {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 401) cachedToken = null;
    getLogger().warn(`KeycloakAdmin: admin lookup failed status=${response.status} url=${url.split('?')[0]}`);
    return null;
  }
  return (await response.json()) as T;
}

function includesBaseRole(roles: RoleRepresentation[]): boolean {
  return roles.some((role) => role.name !== undefined && BASE_ROLES.has(role.name));
}

/** Mirrors the JWT realm_access base-role check; 'unknown' whenever a grant path can't be ruled out. */
async function resolveBaseRoleStatus(
  adminBase: string,
  token: string,
  sub: string
): Promise<'active' | 'no_base_role' | 'unknown'> {
  const encodedSub = encodeURIComponent(sub);

  // Composite endpoint: expands default-roles-<realm> and any other composite grants.
  const userRoles = await adminGetJson<RoleRepresentation[]>(
    `${adminBase}/users/${encodedSub}/role-mappings/realm/composite`,
    token
  );
  if (!userRoles) return 'unknown';
  if (includesBaseRole(userRoles)) return 'active';

  const groups = await adminGetJson<GroupRepresentation[]>(
    `${adminBase}/users/${encodedSub}/groups?briefRepresentation=true&max=${GROUPS_PAGE_LIMIT}`,
    token
  );
  if (!groups) return 'unknown';
  if (groups.length === 0) return 'no_base_role';
  if (groups.length >= GROUPS_PAGE_LIMIT) return 'unknown';

  let sawParentGroups = false;
  for (const group of groups) {
    // A nested (or path-less) group may inherit roles from ancestors we don't resolve.
    if ((group.path ?? '').split('/').filter(Boolean).length !== 1) sawParentGroups = true;
    if (!group.id) return 'unknown';
    const groupRoles = await adminGetJson<RoleRepresentation[]>(
      `${adminBase}/groups/${encodeURIComponent(group.id)}/role-mappings/realm/composite`,
      token
    );
    if (!groupRoles) return 'unknown';
    if (includesBaseRole(groupRoles)) return 'active';
  }

  return sawParentGroups ? 'unknown' : 'no_base_role';
}

/** Fail-safe: 'active' = enabled AND holds a base realm role; any lookup error resolves to 'unknown'. */
export async function getUserStatus(sub: string): Promise<KeycloakUserStatus> {
  try {
    const adminBase = keycloakAdminBaseUrl();
    if (!adminBase) return 'unknown';

    const token = await fetchAccessToken();
    if (!token) return 'unknown';

    const response = await fetchWithTimeout(`${adminBase}/users/${encodeURIComponent(sub)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return 'deleted';
    if (!response.ok) {
      if (response.status === 401) cachedToken = null;
      getLogger().warn(`KeycloakAdmin: user lookup failed status=${response.status}`);
      return 'unknown';
    }

    const user = (await response.json()) as { enabled?: boolean };
    if (user.enabled === false) return 'disabled';

    return resolveBaseRoleStatus(adminBase, token, sub);
  } catch (error) {
    getLogger().warn({ error }, 'KeycloakAdmin: user lookup failed');
    return 'unknown';
  }
}
