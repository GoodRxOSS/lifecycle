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

export const config = {
  transaction: true,
};

const EMPTY_ARRAY = '[]';
const EMPTY_OBJECT = '{}';
const BUILD_CONTEXT_CHAT_INDEX_NAME = 'agent_sessions_active_build_context_chat_unique';
const AGENT_DEFINITIONS_OWNER_STATUS_UPDATED_AT_INDEX = 'agent_definitions_owner_status_updated_at_idx';
const AGENT_DEFINITIONS_OWNER_DEFINITION_ID_INDEX = 'agent_definitions_owner_definition_id_idx';
const LEGACY_GLOBAL_CONFIG_KEY = 'aiAgent';
const RUNTIME_GLOBAL_CONFIG_KEY = 'agentRuntime';
const LEGACY_REPO_CONFIG_TABLE = 'ai_agent_repo_config';
const RUNTIME_REPO_CONFIG_TABLE = 'agent_runtime_repo_config';

async function migrateGlobalConfigKey(knex: Knex, fromKey: string, toKey: string, description: string): Promise<void> {
  const fromRow = await knex('global_config').where({ key: fromKey }).first();
  const toRow = await knex('global_config').where({ key: toKey }).first();

  if (fromRow && !toRow) {
    await knex('global_config').where({ key: fromKey }).update({
      key: toKey,
      description,
      updatedAt: knex.fn.now(),
    });
    return;
  }

  if (fromRow && toRow) {
    await knex('global_config').where({ key: fromKey }).delete();
  }
}

async function copyRepoConfigRows(knex: Knex, fromTable: string, toTable: string): Promise<void> {
  await knex.raw(
    `
      INSERT INTO ?? ("repositoryFullName", config, "createdAt", "updatedAt", "deletedAt")
      SELECT "repositoryFullName", config, "createdAt", "updatedAt", "deletedAt"
      FROM ??
      ON CONFLICT ("repositoryFullName") DO UPDATE SET
        config = EXCLUDED.config,
        "updatedAt" = EXCLUDED."updatedAt",
        "deletedAt" = EXCLUDED."deletedAt"
    `,
    [toTable, fromTable]
  );
}

async function renameRepoConfigTable(knex: Knex, fromTable: string, toTable: string): Promise<void> {
  const hasFromTable = await knex.schema.hasTable(fromTable);
  const hasToTable = await knex.schema.hasTable(toTable);

  if (hasFromTable && !hasToTable) {
    await knex.schema.renameTable(fromTable, toTable);
    return;
  }

  if (hasFromTable && hasToTable) {
    await copyRepoConfigRows(knex, fromTable, toTable);
    await knex.schema.dropTable(fromTable);
  }
}

async function renamePostgresIdentifier(
  knex: Knex,
  type: 'constraint' | 'index' | 'sequence',
  tableName: string,
  from: string,
  to: string
): Promise<void> {
  if (type === 'constraint') {
    const fromExists = await knex('pg_constraint as c')
      .join('pg_class as rel', 'rel.oid', 'c.conrelid')
      .where('c.conname', from)
      .where('rel.relname', tableName)
      .first('c.oid');
    const toExists = await knex('pg_constraint as c')
      .join('pg_class as rel', 'rel.oid', 'c.conrelid')
      .where('c.conname', to)
      .where('rel.relname', tableName)
      .first('c.oid');

    if (fromExists && !toExists) {
      await knex.raw('ALTER TABLE ?? RENAME CONSTRAINT ?? TO ??', [tableName, from, to]);
    }
    return;
  }

  const relkind = type === 'index' ? 'i' : 'S';
  const fromExists = await knex('pg_class').where({ relname: from, relkind }).first('oid');
  const toExists = await knex('pg_class').where({ relname: to, relkind }).first('oid');

  if (!fromExists || toExists) {
    return;
  }

  await knex.raw(`ALTER ${type === 'index' ? 'INDEX' : 'SEQUENCE'} ?? RENAME TO ??`, [from, to]);
}

async function renameRepoConfigPostgresObjects(knex: Knex, direction: 'up' | 'down'): Promise<void> {
  const fromPrefix = direction === 'up' ? 'ai_agent_repo_config' : 'agent_runtime_repo_config';
  const toPrefix = direction === 'up' ? 'agent_runtime_repo_config' : 'ai_agent_repo_config';
  const tableName = direction === 'up' ? RUNTIME_REPO_CONFIG_TABLE : LEGACY_REPO_CONFIG_TABLE;

  await renamePostgresIdentifier(knex, 'constraint', tableName, `${fromPrefix}_pkey`, `${toPrefix}_pkey`);
  await renamePostgresIdentifier(
    knex,
    'constraint',
    tableName,
    `${fromPrefix}_repositoryfullname_unique`,
    `${toPrefix}_repositoryfullname_unique`
  );
  await renamePostgresIdentifier(
    knex,
    'index',
    tableName,
    `${fromPrefix}_repositoryfullname_index`,
    `${toPrefix}_repositoryfullname_index`
  );
  await renamePostgresIdentifier(knex, 'sequence', tableName, `${fromPrefix}_id_seq`, `${toPrefix}_id_seq`);
}

async function createAgentDefinitionsTable(knex: Knex): Promise<void> {
  await knex.schema.createTable('agent_definitions', (table) => {
    table.increments('id').primary();
    table.string('definitionId', 255).notNullable().unique();
    table.integer('version').notNullable().defaultTo(1);
    table.string('ownerKind', 32).notNullable();
    table.string('ownerUserId', 255).nullable();
    table.string('ownerOrganizationId', 255).nullable();
    table.string('name', 255).notNullable();
    table.text('description').nullable();
    table.jsonb('instructionRefs').notNullable().defaultTo(EMPTY_ARRAY);
    table.text('instructionAddendum').nullable();
    table.jsonb('capabilityRefs').notNullable().defaultTo(EMPTY_ARRAY);
    table.jsonb('requiredCapabilityRefs').notNullable().defaultTo(EMPTY_ARRAY);
    table.jsonb('optionalCapabilityRefs').notNullable().defaultTo(EMPTY_ARRAY);
    table.jsonb('resourcePolicy').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('modelPreference').nullable();
    table.string('status', 32).notNullable().defaultTo('active');
    table.boolean('codeOwned').notNullable().defaultTo(false);
    table.boolean('readOnly').notNullable().defaultTo(false);
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.index(['definitionId']);
    table.index(['ownerKind']);
    table.index(['status']);
    table.index(['ownerKind', 'ownerUserId', 'status', 'updatedAt'], AGENT_DEFINITIONS_OWNER_STATUS_UPDATED_AT_INDEX);
    table.index(['ownerKind', 'ownerUserId', 'definitionId'], AGENT_DEFINITIONS_OWNER_DEFINITION_ID_INDEX);
  });
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create unique index if not exists "${BUILD_CONTEXT_CHAT_INDEX_NAME}"
    on agent_sessions ("userId", "buildUuid")
    where "buildUuid" is not null
      and "sessionKind" = 'chat'
      and "status" = 'active'
      and "chatStatus" = 'ready'
  `);

  await knex.schema.alterTable('agent_runs', (table) => {
    table.jsonb('runPlanSnapshot').nullable();
  });

  await createAgentDefinitionsTable(knex);

  await migrateGlobalConfigKey(
    knex,
    LEGACY_GLOBAL_CONFIG_KEY,
    RUNTIME_GLOBAL_CONFIG_KEY,
    'Global configuration for agent runtime providers, limits, approvals, capabilities, and custom-agent creation.'
  );

  await renameRepoConfigTable(knex, LEGACY_REPO_CONFIG_TABLE, RUNTIME_REPO_CONFIG_TABLE);
  await renameRepoConfigPostgresObjects(knex, 'up');
}

export async function down(knex: Knex): Promise<void> {
  await migrateGlobalConfigKey(
    knex,
    RUNTIME_GLOBAL_CONFIG_KEY,
    LEGACY_GLOBAL_CONFIG_KEY,
    'Global configuration for AI agent providers, limits, approvals, capabilities, and custom-agent creation.'
  );

  await renameRepoConfigTable(knex, RUNTIME_REPO_CONFIG_TABLE, LEGACY_REPO_CONFIG_TABLE);
  await renameRepoConfigPostgresObjects(knex, 'down');

  await knex.schema.dropTableIfExists('agent_definitions');

  await knex.schema.alterTable('agent_runs', (table) => {
    table.dropColumn('runPlanSnapshot');
  });

  await knex.raw(`drop index if exists "${BUILD_CONTEXT_CHAT_INDEX_NAME}"`);
}
