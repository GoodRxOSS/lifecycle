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

const TABLE_NAME = 'agent_instruction_rules';
const SCOPE_INDEX_NAME = 'agent_instruction_rules_scope_index';
// Never consumed by any runtime path; removed from the config contract in this release.
const DEAD_RUNTIME_CONFIG_KEYS = ['additiveRules', 'systemPromptOverride'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(TABLE_NAME, (table) => {
    table.increments('id').primary();
    table.string('agentRef', 255).notNullable();
    table.string('repositoryFullName', 512).nullable();
    table.text('content').notNullable();
    table.integer('position').notNullable().defaultTo(0);
    table.string('updatedBy', 255).nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.index(['repositoryFullName', 'agentRef'], SCOPE_INDEX_NAME);
  });

  const globalRow = await knex('global_config').where({ key: 'agentRuntime' }).first();
  if (globalRow) {
    const value = typeof globalRow.config === 'string' ? JSON.parse(globalRow.config) : globalRow.config;
    if (value && DEAD_RUNTIME_CONFIG_KEYS.some((key) => key in value)) {
      for (const key of DEAD_RUNTIME_CONFIG_KEYS) {
        delete value[key];
      }
      await knex('global_config')
        .where({ key: 'agentRuntime' })
        .update({ config: JSON.stringify(value), updatedAt: knex.fn.now() });
    }
  }

  const repoRows = await knex('agent_runtime_repo_config').select('id', 'config');
  for (const row of repoRows) {
    const value = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    if (value && DEAD_RUNTIME_CONFIG_KEYS.some((key) => key in value)) {
      for (const key of DEAD_RUNTIME_CONFIG_KEYS) {
        delete value[key];
      }
      await knex('agent_runtime_repo_config')
        .where({ id: row.id })
        .update({ config: JSON.stringify(value), updatedAt: knex.fn.now() });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE_NAME);
}
