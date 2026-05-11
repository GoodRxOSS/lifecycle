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

const TABLE_NAME = 'agent_instruction_templates';
const REF_UNIQUE_INDEX_NAME = 'agent_instruction_templates_ref_unique';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(TABLE_NAME, (table) => {
    table.increments('id').primary();
    table.string('ref', 255).notNullable();
    table.string('name', 255).notNullable();
    table.text('description').nullable();
    table.text('defaultContent').notNullable();
    table.integer('defaultVersion').notNullable();
    table.string('defaultHash', 64).notNullable();
    table.text('overrideContent').nullable();
    table.integer('overrideVersion').nullable();
    table.string('overrideHash', 64).nullable();
    table.integer('overrideBaseDefaultVersion').nullable();
    table.string('overrideBaseDefaultHash', 64).nullable();
    table.string('overrideUpdatedBy', 255).nullable();
    table.timestamp('overrideUpdatedAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.unique(['ref'], REF_UNIQUE_INDEX_NAME);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE_NAME);
}
