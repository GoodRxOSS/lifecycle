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

import type { NextRequest } from 'next/server';
import ApiTokenService from 'server/services/apiToken';
import GlobalConfigService from 'server/services/globalConfig';
import type ApiToken from 'server/models/ApiToken';
import type { ApiTokenScope } from 'server/models/ApiToken';
import { AppError } from './appError';
import { bearerApiKey } from './apiTokenShape';
import { getRequestUserIdentity, type RequestUserIdentity } from './get-user';
import type { LifecycleRole } from './roles';

export type PrincipalKind = 'user' | 'personal_key' | 'service_key';

export interface Principal {
  kind: PrincipalKind;
  authMethod: 'session' | 'api_key';
  /** Keycloak sub; owner sub for personal keys; null for service keys. */
  userId: string | null;
  /** sub, or `token:<name>` for service keys — audit/attribution string. */
  actor: string;
  /** Realm roles for sessions; [] for keys. */
  roles: LifecycleRole[];
  /** null = unscoped session; non-null = scope-capped key. */
  scopes: ApiTokenScope[] | null;
  tokenId: number | null;
  repositoryAllowlist: string[] | null;
  repositoryAllowlistRepoIds: number[] | null;
  /** Full for sessions; rebuilt from the mint snapshot for personal keys; null for service keys. */
  identity: RequestUserIdentity | null;
}

function invalidCredential(message: string): AppError {
  return new AppError({ httpStatus: 401, code: 'invalid_credential', message });
}

interface ApiKeysConfig {
  personalAuthEnabled?: boolean;
  serviceAuthEnabled?: boolean;
}

async function apiKeysConfig(): Promise<ApiKeysConfig> {
  return ((await GlobalConfigService.getInstance().getConfig('api_keys')) ?? {}) as ApiKeysConfig;
}

function personalKeyIdentity(record: ApiToken, ownerUserId: string): RequestUserIdentity {
  const displayName =
    record.ownerDisplayName ?? record.ownerGithubUsername ?? record.ownerPreferredUsername ?? ownerUserId;
  return {
    userId: ownerUserId,
    githubUsername: record.ownerGithubUsername ?? null,
    preferredUsername: record.ownerPreferredUsername ?? null,
    email: record.ownerEmail ?? null,
    firstName: null,
    lastName: null,
    displayName,
    gitUserName: displayName,
    gitUserEmail: record.ownerEmail ?? '',
    roles: [],
  };
}

async function resolveKeyPrincipal(token: string): Promise<Principal> {
  // SECURITY: keys never authenticate while ENABLE_AUTH is off (mirrors the machine-route fail-open refusal).
  if (process.env.ENABLE_AUTH !== 'true') {
    throw invalidCredential('API keys require ENABLE_AUTH=true; they never authenticate while auth is off.');
  }

  const record = await ApiTokenService.verifyToken(token);
  if (!record) {
    throw invalidCredential('Invalid, expired, or revoked API key.');
  }

  const config = await apiKeysConfig();
  const personal = record.kind === 'personal';
  const authEnabled = personal ? config.personalAuthEnabled === true : config.serviceAuthEnabled === true;
  if (!authEnabled) {
    throw new AppError({
      httpStatus: 403,
      code: 'api_keys_disabled',
      message: `${personal ? 'Personal' : 'Service'} API keys are currently disabled by the administrator.`,
    });
  }

  if (personal) {
    const ownerUserId = record.ownerUserId;
    if (!ownerUserId) {
      throw invalidCredential('Invalid, expired, or revoked API key.');
    }
    ApiTokenService.touchLastUsed(record);
    return {
      kind: 'personal_key',
      authMethod: 'api_key',
      userId: ownerUserId,
      actor: ownerUserId,
      roles: [],
      scopes: record.scopes,
      tokenId: record.id,
      repositoryAllowlist: record.repositoryAllowlist ?? null,
      repositoryAllowlistRepoIds: record.repositoryAllowlistRepoIds ?? null,
      identity: personalKeyIdentity(record, ownerUserId),
    };
  }

  ApiTokenService.touchLastUsed(record);
  return {
    kind: 'service_key',
    authMethod: 'api_key',
    userId: null,
    actor: `token:${record.name}`,
    roles: [],
    scopes: record.scopes,
    tokenId: record.id,
    repositoryAllowlist: record.repositoryAllowlist ?? null,
    repositoryAllowlistRepoIds: record.repositoryAllowlistRepoIds ?? null,
    identity: null,
  };
}

/** Ordered resolver: API key → middleware-verified x-user session → local-dev fail-open → 401. */
export async function resolvePrincipal(req: NextRequest): Promise<Principal> {
  const token = bearerApiKey(req.headers.get('authorization'));
  if (token) {
    return resolveKeyPrincipal(token);
  }

  const identity = getRequestUserIdentity(req);
  if (identity) {
    return {
      kind: 'user',
      authMethod: 'session',
      userId: identity.userId,
      actor: identity.userId,
      roles: identity.roles,
      scopes: null,
      tokenId: null,
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      identity,
    };
  }

  throw new AppError({ httpStatus: 401, code: 'authentication_required', message: 'Authentication is required.' });
}
