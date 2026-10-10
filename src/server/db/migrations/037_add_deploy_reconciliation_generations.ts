/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Knex } from 'knex';

const PENDING_INDEX = 'deploys_reconcile_pending';

// PostgreSQL concurrent index operations cannot run inside Knex's migration transaction.
export const config = { transaction: false };

// Runs outside a transaction, so every step is guarded to make a retry after a failed concurrent index build safe.
export async function up(knex: Knex): Promise<void> {
  for (const column of ['desiredGeneration', 'observedGeneration']) {
    if (await knex.schema.hasColumn('deploys', column)) continue;
    await knex.schema.alterTable('deploys', (table) => {
      table.bigInteger(column).notNullable().defaultTo(0);
    });
  }

  // Intents of environments with nothing pending are finished; marking them keeps the sweep from replaying them.
  await knex.raw(`
    update builds
       set "acceptedRefs" = (
         select coalesce(jsonb_object_agg(entry.key, entry.value || jsonb_build_object('observedGen', entry.value -> 'gen')), '{}'::jsonb)
           from jsonb_each("acceptedRefs") as entry
       )
     where "acceptedRefs" <> '{}'::jsonb
       and "desiredGeneration" = "observedGeneration"
       and "deletedAt" is null
  `);

  // A failed concurrent build leaves an invalid index with this name behind.
  await knex.raw('drop index concurrently if exists ??', [PENDING_INDEX]);
  await knex.raw(
    `create index concurrently ?? on deploys ("buildId") where "desiredGeneration" > "observedGeneration"`,
    [PENDING_INDEX]
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index concurrently if exists ??', [PENDING_INDEX]);

  await knex.schema.alterTable('deploys', (table) => {
    table.dropColumn('observedGeneration');
    table.dropColumn('desiredGeneration');
  });
}
