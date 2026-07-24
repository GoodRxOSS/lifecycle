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
  await knex.schema.createTable('ai_agent_repo_config', (table) => {
    table.increments('id').primary();
    table.string('repositoryFullName', 255).notNullable().unique();
    table.jsonb('config').notNullable().defaultTo('{}');
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.timestamp('deletedAt', { useTz: true });
    table.index(['repositoryFullName']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ai_agent_repo_config');
}
