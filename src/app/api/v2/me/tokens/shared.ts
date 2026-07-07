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

import { AppError, BadRequestError } from 'server/lib/appError';
import GlobalConfigService from 'server/services/globalConfig';
import ApiTokenService from 'server/services/apiToken';
import type ApiToken from 'server/models/ApiToken';

export const TOKEN_CREATE_FIELDS = ['name', 'scopes', 'repositoryAccess', 'ttlHours', 'expiresAt'] as const;

/** A mistyped optional field (e.g. expiresInHours) must fail loudly, not silently mint a non-expiring key. */
export function assertNoUnknownFields(body: object, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown field${unknown.length > 1 ? 's' : ''} ${unknown
        .map((field) => `"${field}"`)
        .join(', ')}; allowed fields: ${allowed.join(', ')}.`,
      'invalid_body'
    );
  }
}

export const serializeUserToken = (record: ApiToken) => ({
  id: record.id,
  name: record.name,
  tokenPrefix: record.tokenPrefix,
  kind: ApiTokenService.tokenKind(record),
  status: ApiTokenService.tokenStatus(record),
  scopes: record.scopes,
  repositoryAllowlist: record.repositoryAllowlist,
  ownerGithubUsername: record.ownerGithubUsername,
  expiresAt: record.expiresAt,
  lastUsedAt: record.lastUsedAt,
  revokedAt: record.revokedAt,
  createdAt: record.createdAt,
});

/** Issuance-only gate: flag off blocks new tokens, never an owner's list/revoke of existing ones. */
export async function assertIssuanceEnabled(): Promise<void> {
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  if ((configs as Record<string, any>)?.api_keys?.issuanceEnabled !== true) {
    throw new AppError({
      httpStatus: 403,
      code: 'api_keys_disabled',
      message: 'API key creation is disabled by the administrator.',
    });
  }
}
