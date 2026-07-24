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

import ApiToken from 'server/models/ApiToken';
import ApiTokenService from 'server/services/apiToken';
import { recordAuthAuditEvent } from 'server/services/authAudit';
import { getUserStatus, isConfigured } from 'server/services/keycloakAdmin';
import { getLogger } from 'server/lib/logger';

export const API_TOKEN_OWNER_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_REVOKED_BY = 'system:owner-sweep';
const UNCONFIGURED_WARNING = 'API key owner sweep skipped: Keycloak principal-sync client not configured';

export function warnIfApiTokenOwnerSweepUnconfigured(): void {
  if (!isConfigured()) {
    getLogger().warn(UNCONFIGURED_WARNING);
  }
}

async function listActivePersonalKeyOwners(): Promise<string[]> {
  const rows = await ApiToken.query()
    .distinct('ownerUserId')
    .where('kind', 'personal')
    .whereNotNull('ownerUserId')
    .whereNull('revokedAt')
    .where((builder) => {
      builder.whereNull('expiresAt').orWhere('expiresAt', '>', new Date().toISOString());
    });
  return rows.map((row) => row.ownerUserId).filter((sub): sub is string => Boolean(sub));
}

export async function processApiTokenOwnerSweep(): Promise<void> {
  if (!isConfigured()) {
    getLogger().warn(UNCONFIGURED_WARNING);
    return;
  }

  const owners = await listActivePersonalKeyOwners();
  let revokedOwners = 0;
  let revokedKeys = 0;
  let unknown = 0;
  let failures = 0;

  for (const sub of owners) {
    const status = await getUserStatus(sub);
    if (status === 'active') continue;
    if (status === 'unknown') {
      // Fail safe: never revoke because Keycloak was unreachable or the lookup errored.
      unknown++;
      getLogger().warn(`ApiToken: owner sweep lookup inconclusive, keys left active ownerUserId=${sub}`);
      continue;
    }

    const lostRole = status === 'no_base_role';
    try {
      const { count } = await ApiTokenService.revokeByOwnerIdentifier(
        'ownerUserId',
        sub,
        SWEEP_REVOKED_BY,
        lostRole ? 'owner_lost_role' : 'owner_disabled'
      );
      revokedOwners++;
      revokedKeys += count;
      await recordAuthAuditEvent({
        event: lostRole ? 'api_token.owner_lost_role_revoke' : 'api_token.owner_disabled_revoke',
        principalKind: 'user',
        principalId: sub,
        actorId: SWEEP_REVOKED_BY,
        outcome: 'revoked',
        meta: { count },
      });
      getLogger().info(`ApiToken: owner sweep revoked keys ownerUserId=${sub} status=${status} count=${count}`);
    } catch (error) {
      failures++;
      getLogger().error({ error }, `ApiToken: owner sweep revoke failed ownerUserId=${sub}`);
    }
  }

  getLogger().info(
    `ApiToken: owner sweep complete owners=${owners.length} revokedOwners=${revokedOwners} revokedKeys=${revokedKeys} unknown=${unknown} failures=${failures}`
  );
}
