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
import {
  deriveKeycloakAdminBaseUrl,
  KeycloakAdminClient,
  KeycloakAdminError,
  type KeycloakAdminClientOptions,
} from './adminClient';

const DEFAULT_PRINCIPAL_SYNC_CLIENT_ID = 'lifecycle-api-principal-sync';
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

function principalStatusClientOptions(): KeycloakAdminClientOptions | null {
  const issuer = process.env.KEYCLOAK_ISSUER_INTERNAL?.trim() || process.env.KEYCLOAK_ISSUER?.trim();
  const secret = process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET?.trim();
  const adminBaseUrl =
    process.env.KEYCLOAK_ADMIN_BASE_URL?.trim() || (issuer ? deriveKeycloakAdminBaseUrl(issuer) : null);
  if (!issuer || !secret || !adminBaseUrl) return null;
  return {
    issuer,
    adminBaseUrl,
    clientId: process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID?.trim() || DEFAULT_PRINCIPAL_SYNC_CLIENT_ID,
    clientSecret: secret,
    allowInternalHttp: Boolean(process.env.KEYCLOAK_ISSUER_INTERNAL?.trim()),
  };
}

export function isConfigured(): boolean {
  return principalStatusClientOptions() !== null;
}

function includesBaseRole(roles: RoleRepresentation[]): boolean {
  return roles.some((role) => role.name !== undefined && BASE_ROLES.has(role.name));
}

export class KeycloakPrincipalStatus {
  constructor(private readonly client: KeycloakAdminClient) {}

  /** Fail-safe: active means enabled and holding a base realm role. */
  async getUserStatus(sub: string): Promise<KeycloakUserStatus> {
    try {
      const encodedSub = encodeURIComponent(sub);
      let user: { enabled?: boolean };
      try {
        user = await this.client.get<{ enabled?: boolean }>(`/users/${encodedSub}`);
      } catch (error) {
        if (error instanceof KeycloakAdminError && error.kind === 'not_found') return 'deleted';
        throw error;
      }
      if (user.enabled === false) return 'disabled';
      return this.resolveBaseRoleStatus(encodedSub);
    } catch (error) {
      getLogger().warn(
        {
          error:
            error instanceof KeycloakAdminError
              ? { name: error.name, kind: error.kind, status: error.status }
              : error instanceof Error
              ? { name: error.name }
              : 'unknown',
        },
        'Keycloak principal-status lookup failed'
      );
      return 'unknown';
    }
  }

  private async resolveBaseRoleStatus(encodedSub: string): Promise<'active' | 'no_base_role' | 'unknown'> {
    // Composite endpoint: expands default-roles-<realm> and any other composite grants.
    const userRoles = await this.client.get<RoleRepresentation[]>(`/users/${encodedSub}/role-mappings/realm/composite`);
    if (!Array.isArray(userRoles)) return 'unknown';
    if (includesBaseRole(userRoles)) return 'active';

    const groups = await this.client.get<GroupRepresentation[]>(
      `/users/${encodedSub}/groups?briefRepresentation=true&max=${GROUPS_PAGE_LIMIT}`
    );
    if (!Array.isArray(groups)) return 'unknown';
    if (groups.length === 0) return 'no_base_role';
    if (groups.length >= GROUPS_PAGE_LIMIT) return 'unknown';

    // A nested (or path-less) group may inherit roles from ancestors we don't resolve.
    let sawParentGroups = false;
    for (const group of groups) {
      if ((group.path ?? '').split('/').filter(Boolean).length !== 1) sawParentGroups = true;
      if (!group.id) return 'unknown';
      const groupRoles = await this.client.get<RoleRepresentation[]>(
        `/groups/${encodeURIComponent(group.id)}/role-mappings/realm/composite`
      );
      if (!Array.isArray(groupRoles)) return 'unknown';
      if (includesBaseRole(groupRoles)) return 'active';
    }
    return sawParentGroups ? 'unknown' : 'no_base_role';
  }
}

let defaultService: { signature: string; service: KeycloakPrincipalStatus } | null = null;

function configuredService(): KeycloakPrincipalStatus | null {
  const options = principalStatusClientOptions();
  if (!options) return null;
  const signature = [options.issuer, options.adminBaseUrl, options.clientId, options.clientSecret].join('\0');
  if (!defaultService || defaultService.signature !== signature) {
    defaultService = {
      signature,
      service: new KeycloakPrincipalStatus(new KeycloakAdminClient(options)),
    };
  }
  return defaultService.service;
}

export async function getUserStatus(sub: string): Promise<KeycloakUserStatus> {
  return (await configuredService()?.getUserStatus(sub)) ?? 'unknown';
}
