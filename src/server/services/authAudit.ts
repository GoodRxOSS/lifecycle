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

import type { Transaction } from 'objection';
import AuthAuditEvent from 'server/models/AuthAuditEvent';
import { getLogger } from 'server/lib/logger';

export interface AuthAuditEventInput {
  event: string;
  principalKind: string;
  principalId?: string | null;
  /** Who performed the action (admin/owner sub or system marker); principalId identifies the credential acted on. */
  actorId?: string | null;
  tokenId?: number | null;
  requestId?: string | null;
  route?: string | null;
  outcome: string;
  meta?: Record<string, unknown> | null;
}

function auditRow(input: AuthAuditEventInput) {
  return {
    event: input.event,
    principalKind: input.principalKind,
    principalId: input.principalId ?? null,
    actorId: input.actorId ?? null,
    tokenId: input.tokenId ?? null,
    requestId: input.requestId ?? null,
    route: input.route ?? null,
    outcome: input.outcome,
    meta: input.meta ?? null,
  };
}

/** Best-effort insert: auditing must never break the caller. Mutations get same-transaction variants below. */
export async function recordAuthAuditEvent(input: AuthAuditEventInput): Promise<void> {
  try {
    await AuthAuditEvent.query().insert(auditRow(input));
  } catch (error) {
    getLogger().warn({ error }, `AuthAudit: event insert failed event=${input.event} outcome=${input.outcome}`);
  }
}

/**
 * Same-transaction insert for state-change audit: the row commits or rolls back with the
 * mutation it describes. Unlike the best-effort variant this THROWS, so a failed audit aborts the tx.
 */
export async function recordAuthAuditEventInTransaction(trx: Transaction, input: AuthAuditEventInput): Promise<void> {
  await AuthAuditEvent.query(trx).insert(auditRow(input));
}
