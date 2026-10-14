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

const BUILD_COLUMNS = [
  'firstReadyAt',
  'firstRolledOutAt',
  'lastTornDownAt',
  'namespaceCreatedAt',
  'namespaceDeletedAt',
];
const INDEXES: Array<[name: string, table: string, columns: string]> = [
  ['build_events_requested_idx', 'build_events', `("createdAt") WHERE kind = 'deploy_requested'`],
  [
    'build_events_run_idx',
    'build_events',
    `("buildId", "runUUID", kind) WHERE kind IN ('run_claimed', 'run_blocked', 'run_superseded', 'run_finished')`,
  ],
  ['build_events_created_at_brin', 'build_events', 'USING brin ("createdAt")'],
  ['builds_kind_created_at_idx', 'builds', '(kind, "createdAt")'],
  ['builds_pull_request_id_idx', 'builds', '("pullRequestId")'],
  ['pull_requests_created_at_idx', 'pull_requests', '("createdAt")'],
  ['deployables_build_id_build_uuid_idx', 'deployables', '("buildId", "buildUUID")'],
  ['agent_runs_created_at_idx', 'agent_runs', '("createdAt")'],
  ['auth_audit_events_event_created_at_idx', 'auth_audit_events', '(event, "createdAt")'],
];

// Pre-release drafts of this migration created these; nothing reads them.
const DRAFT_INDEXES = [
  'build_events_build_id_created_at_idx',
  'build_events_kind_created_at_idx',
  'build_events_created_at_idx',
  'build_events_build_id_run_uuid_idx',
];

const BACKFILL_BATCH = 5000;

// PostgreSQL concurrent index operations cannot run inside Knex's migration transaction.
export const config = { transaction: false };

async function indexState(knex: Knex, name: string): Promise<'valid' | 'invalid' | 'missing'> {
  const row = await knex('pg_index as i')
    .join('pg_class as c', 'c.oid', 'i.indexrelid')
    .where('c.relname', name)
    .select('i.indisvalid')
    .first();
  if (!row) return 'missing';
  return row.indisvalid ? 'valid' : 'invalid';
}

// An interrupted concurrent build leaves an invalid index behind; a finished one is kept as it is.
async function ensureIndex(knex: Knex, name: string, table: string, columns: string): Promise<void> {
  const state = await indexState(knex, name);
  if (state === 'valid') return;
  if (state === 'invalid') await knex.raw('drop index concurrently if exists ??', [name]);
  await knex.raw(`create index concurrently ?? on ?? ${columns}`, [name, table]);
}

// Deploy runs look deploys up by build many times each; a legacy index on the column makes another one pure write cost.
async function ensureDeployBuildIndex(knex: Knex): Promise<void> {
  const indexes: Array<{ name: string; indexdef: string; indisvalid: boolean }> = await knex('pg_index as i')
    .join('pg_class as c', 'c.oid', 'i.indexrelid')
    .join('pg_class as t', 't.oid', 'i.indrelid')
    .where('t.relname', 'deploys')
    .select('c.relname as name', knex.raw('pg_get_indexdef(i.indexrelid) as indexdef'), 'i.indisvalid');
  const covered = indexes.some(
    ({ indexdef, indisvalid }) =>
      indisvalid && /USING btree \("buildId"[,)]/.test(indexdef) && !/ WHERE /.test(indexdef)
  );
  if (!covered) await ensureIndex(knex, 'deploys_build_id_idx', 'deploys', '("buildId")');
}

// Whole-table updates would hold every row lock until they commit; id batches keep the deploy pipeline moving.
async function backfillBuilds(knex: Knex): Promise<void> {
  let last = 0;
  for (;;) {
    const rows: Array<{ id: number }> = await knex('builds')
      .select('id')
      .where('id', '>', last)
      .orderBy('id')
      .limit(BACKFILL_BATCH);
    if (!rows.length) return;
    const ids = rows.map((row) => Number(row.id));
    const batch = `{${ids.join(',')}}`;
    // Records that rolled out or deployed before this migration have no recorded times; the sentinels mark the fact and keep later stamps from landing.
    await knex.raw(
      `UPDATE builds b SET "firstRolledOutAt" = '-infinity'
        WHERE b.id = ANY(?::int[]) AND b."firstRolledOutAt" IS NULL
          AND EXISTS (SELECT 1 FROM deploys d WHERE d."buildId" = b.id AND d."isRunningLatest")`,
      [batch]
    );
    await knex.raw(
      `UPDATE builds SET "firstReadyAt" = '-infinity'
        WHERE id = ANY(?::int[]) AND "firstReadyAt" IS NULL AND (status = 'deployed' OR "firstRolledOutAt" IS NOT NULL)`,
      [batch]
    );
    // The PR webhook stored nothing here because it looked GitHub's id up as a row id.
    await knex.raw(
      `UPDATE builds b
          SET "githubRepositoryId" = r."githubRepositoryId"
         FROM pull_requests p
         JOIN repositories r ON r.id = p."repositoryId"
        WHERE b.id = ANY(?::int[]) AND b."pullRequestId" = p.id AND b."githubRepositoryId" IS NULL`,
      [batch]
    );
    last = ids[ids.length - 1];
  }
}

// Runs outside a transaction, so every step is guarded to make a retry after a failed step safe.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('build_events'))) {
    await knex.schema.createTable('build_events', (table) => {
      table.bigIncrements('id').primary();
      table.integer('buildId').notNullable();
      table.integer('deployId').nullable();
      table.text('runUUID').nullable();
      table.text('kind').notNullable();
      table.text('status').nullable();
      table.text('reason').nullable();
      table.text('origin').nullable();
      table.jsonb('meta').nullable();
      table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.raw('clock_timestamp()'));
    });
  }

  for (const column of BUILD_COLUMNS) {
    if (await knex.schema.hasColumn('builds', column)) continue;
    await knex.schema.alterTable('builds', (table) => {
      table.timestamp(column, { useTz: true }).nullable();
    });
  }

  await ensureDeployBuildIndex(knex);
  await backfillBuilds(knex);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION builds_status_stamps() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'deployed' AND NEW."firstReadyAt" IS NULL THEN
        NEW."firstReadyAt" := clock_timestamp();
      END IF;
      IF NEW.status = 'torn_down' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'torn_down') THEN
        NEW."lastTornDownAt" := clock_timestamp();
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);
  await knex.raw('DROP TRIGGER IF EXISTS builds_status_stamps ON builds');
  await knex.raw(`
    CREATE TRIGGER builds_status_stamps BEFORE INSERT OR UPDATE OF status ON builds
    FOR EACH ROW EXECUTE FUNCTION builds_status_stamps()
  `);

  // Dropped wherever a pre-release draft of this migration created them; status rows had no reader and cost WAL on every deploy update.
  await knex.raw('DROP TRIGGER IF EXISTS deploys_rolled_out_stamp ON deploys');
  await knex.raw('DROP FUNCTION IF EXISTS deploys_rolled_out_stamp()');
  await knex.raw('DROP TRIGGER IF EXISTS builds_status_event ON builds');
  await knex.raw('DROP TRIGGER IF EXISTS deploys_status_event ON deploys');
  await knex.raw('DROP FUNCTION IF EXISTS builds_status_event()');
  await knex.raw('DROP FUNCTION IF EXISTS deploys_status_event()');
  await knex('build_events').whereIn('kind', ['build_status', 'deploy_status']).delete();

  const retention = await knex('global_config').where('key', 'analytics_retention').first();
  if (!retention) {
    await knex('global_config').insert({
      key: 'analytics_retention',
      config: { mcpToolCallDays: 0, buildEventDays: 0 },
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description:
        'Daily retention in days for recorded MCP tool calls (mcpToolCallDays) and build events (buildEventDays). 0 keeps everything. Other audit events are never deleted.',
    });
  }

  for (const [name, table, columns] of INDEXES) {
    await ensureIndex(knex, name, table, columns);
  }
  for (const name of DRAFT_INDEXES) {
    await knex.raw('drop index concurrently if exists ??', [name]);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index concurrently if exists ??', ['deploys_build_id_idx']);
  for (const [name] of INDEXES) {
    await knex.raw('drop index concurrently if exists ??', [name]);
  }
  await knex.raw('DROP TRIGGER IF EXISTS deploys_rolled_out_stamp ON deploys');
  await knex.raw('DROP FUNCTION IF EXISTS deploys_rolled_out_stamp()');
  await knex.raw('DROP TRIGGER IF EXISTS deploys_status_event ON deploys');
  await knex.raw('DROP TRIGGER IF EXISTS builds_status_event ON builds');
  await knex.raw('DROP TRIGGER IF EXISTS builds_status_stamps ON builds');
  await knex.raw('DROP FUNCTION IF EXISTS deploys_status_event()');
  await knex.raw('DROP FUNCTION IF EXISTS builds_status_event()');
  await knex.raw('DROP FUNCTION IF EXISTS builds_status_stamps()');
  await knex('global_config').where('key', 'analytics_retention').delete();
  for (const column of BUILD_COLUMNS) {
    if (!(await knex.schema.hasColumn('builds', column))) continue;
    await knex.schema.alterTable('builds', (table) => {
      table.dropColumn(column);
    });
  }
  await knex.schema.dropTableIfExists('build_events');
}
