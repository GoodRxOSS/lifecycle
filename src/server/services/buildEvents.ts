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

import type { Knex } from 'knex';
import { getLogger } from 'server/lib/logger';
import { scrubSecretsFromText } from 'server/lib/secretScrub';
import { compactStatusMessage } from 'server/lib/terminalFailure';

export type BuildEventKind =
  | 'deploy_requested'
  | 'run_claimed'
  | 'run_blocked'
  | 'run_superseded'
  | 'run_finished'
  | 'namespace_created'
  | 'namespace_deleted';
export type BuildRunOutcome = 'succeeded' | 'failed';

export interface ServiceRunOutcome {
  name: string;
  type: string | null;
  status: string | null;
  outcome: 'ready' | 'failed' | 'unfinished';
  message: string | null;
}
export const SERVICE_OUTCOME_MESSAGE_LENGTH = 120;
export const SERVICE_OUTCOME_LIMIT = 200;

// SECURITY: reasons arrive already cut, so the scrub must also catch a cut key block.
export function serviceOutcomeMessage(message: string): string {
  return compactStatusMessage(scrubSecretsFromText(message), SERVICE_OUTCOME_MESSAGE_LENGTH);
}

export function boundedServiceOutcomes(outcomes: ServiceRunOutcome[]): ServiceRunOutcome[] {
  return outcomes.length > SERVICE_OUTCOME_LIMIT ? outcomes.slice(0, SERVICE_OUTCOME_LIMIT) : outcomes;
}

export type BuildEventOrigin =
  | 'push'
  | 'label'
  | 'pr_open'
  | 'config_push'
  | 'api'
  | 'redeploy'
  | 'mcp'
  | 'comment'
  | 'agent';

export interface BuildEventInput {
  buildId: number;
  kind: BuildEventKind;
  deployId?: number | null;
  runUUID?: string | null;
  status?: string | null;
  reason?: string | null;
  origin?: BuildEventOrigin | null;
  meta?: Record<string, unknown> | null;
}

type KnexLike = Pick<Knex, 'raw'> & ((table: string) => Knex.QueryBuilder);

const usable = (knex: unknown): knex is KnexLike => typeof knex === 'function';

/** Best-effort: analytics bookkeeping must never fail the deployment work that produces it. */
export async function recordBuildEvent(knex: unknown, input: BuildEventInput): Promise<void> {
  if (!usable(knex)) return;
  try {
    await knex('build_events').insert({
      buildId: input.buildId,
      deployId: input.deployId ?? null,
      runUUID: input.runUUID ?? null,
      kind: input.kind,
      status: input.status ?? null,
      reason:
        input.reason == null
          ? null
          : Array.from(scrubSecretsFromText(String(input.reason)))
              .slice(0, 1000)
              .join(''),
      origin: input.origin ?? null,
      meta: input.meta == null ? null : JSON.stringify(input.meta),
    });
  } catch (error) {
    getLogger().warn({ error, buildId: input.buildId, kind: input.kind }, 'BuildEvents: insert failed');
  }
}

/** Called only after Kubernetes created the namespace, so every call starts a new namespace episode. */
export async function recordNamespaceCreated(knex: unknown, buildUUID: string): Promise<void> {
  if (!usable(knex)) return;
  try {
    const rows = (await knex('builds')
      .where({ uuid: buildUUID })
      .whereNull('deletedAt')
      .update({ namespaceCreatedAt: knex.raw('clock_timestamp()') })
      .returning('id')) as Array<{ id: number } | number>;
    const first = rows[0];
    const buildId = typeof first === 'number' ? first : first?.id;
    if (buildId == null) return;
    await recordBuildEvent(knex, { buildId, kind: 'namespace_created' });
  } catch (error) {
    getLogger().warn({ error, buildUUID }, 'BuildEvents: namespace stamp failed');
  }
}

/** Stamped after the rollout writes settle, outside any row lock, so it cannot deadlock with intent acceptance. */
export async function recordFirstRollout(knex: unknown, buildId: number): Promise<void> {
  if (!usable(knex)) return;
  try {
    await knex('builds')
      .where({ id: buildId })
      .whereNull('firstRolledOutAt')
      .update({ firstRolledOutAt: knex.raw('clock_timestamp()') });
  } catch (error) {
    getLogger().warn({ error, buildId }, 'BuildEvents: rollout stamp failed');
  }
}

/** With a namespace name the stamp lands only while that namespace is still the record's, so a late deletion cannot end a newer episode. */
export async function recordNamespaceDeleted(
  knex: unknown,
  buildId: number,
  runUUID?: string | null,
  namespace?: string | null
): Promise<void> {
  if (!usable(knex)) return;
  try {
    const stamp = knex('builds').where({ id: buildId });
    if (namespace) stamp.where({ namespace });
    await stamp.update({ namespaceDeletedAt: knex.raw('clock_timestamp()') });
  } catch (error) {
    getLogger().warn({ error, buildId }, 'BuildEvents: namespace stamp failed');
  }
  await recordBuildEvent(knex, { buildId, kind: 'namespace_deleted', runUUID });
}
