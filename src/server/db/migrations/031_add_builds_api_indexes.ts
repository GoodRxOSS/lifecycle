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

import { Knex } from 'knex';

// CREATE INDEX CONCURRENTLY cannot run inside a transaction.
export const config = {
  transaction: false,
};

const BUILDS_INDEXES = [
  { name: 'builds_createdbytokenid_index', definition: 'on builds ("createdByTokenId")' },
  { name: 'builds_createdbyuserid_index', definition: 'on builds ("createdByUserId")' },
  { name: 'builds_triggertype_index', definition: 'on builds ("triggerType")' },
  {
    name: 'builds_api_expiry_sweep',
    definition: `on builds ("expiresAt") where "triggerType" = 'api' and "expiresAt" is not null`,
  },
  {
    name: 'builds_api_auto_track',
    definition: `on builds ("githubRepositoryId", "branchName") where "triggerType" = 'api' and "autoTrack" = true`,
  },
] as const;

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an invalid index that IF NOT EXISTS would silently keep.
  const { rows } = await knex.raw<{ rows: { relname: string }[] }>(
    `select c.relname from pg_index i
     join pg_class c on c.oid = i.indexrelid
     where not i.indisvalid and c.relname = any(?)`,
    [BUILDS_INDEXES.map((index) => index.name)]
  );
  for (const { relname } of rows) {
    await knex.raw(`drop index if exists ??`, [relname]);
  }

  for (const { name, definition } of BUILDS_INDEXES) {
    await knex.raw(`create index concurrently if not exists ?? ${definition}`, [name]);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const { name } of BUILDS_INDEXES) {
    await knex.raw(`drop index if exists ??`, [name]);
  }
}
