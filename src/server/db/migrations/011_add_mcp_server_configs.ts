/**
 * Copyright 2025 GoodRx, Inc.
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

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('mcp_server_configs', (table) => {
    table.increments('id').primary();
    table.string('slug', 100).notNullable();
    table.string('name', 255).notNullable();
    table.string('description', 1000).nullable();
    table.string('url', 2048).notNullable();
    table.string('scope', 255).notNullable().defaultTo('global');
    table.jsonb('headers').notNullable().defaultTo('{}');
    table.jsonb('envVars').notNullable().defaultTo('{}');
    table.boolean('enabled').notNullable().defaultTo(true);
    table.integer('timeout').notNullable().defaultTo(30);
    table.jsonb('cachedTools').notNullable().defaultTo('[]');
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.timestamp('deletedAt', { useTz: true });
    table.unique(['slug', 'scope']);
    table.index(['scope']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mcp_server_configs');
}
