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

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agent_prewarms', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('buildUuid').notNullable().index();
    table.string('namespace').notNullable();
    table.string('repo').nullable();
    table.string('branch').nullable();
    table.string('revision').nullable().index();
    table.string('pvcName').notNullable();
    table.string('jobName').notNullable();
    table.string('status').notNullable().defaultTo('queued').index();
    table.jsonb('services').notNullable().defaultTo('[]');
    table.text('errorMessage').nullable();
    table.timestamp('completedAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());
    table.unique(['buildUuid', 'revision', 'pvcName']);
    table.index(['buildUuid', 'status', 'updatedAt']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('agent_prewarms');
}
