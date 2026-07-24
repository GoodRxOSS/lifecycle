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

const TELEMETRY_EVENTS_TABLE = 'telemetry_events';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(TELEMETRY_EVENTS_TABLE, (table) => {
    table.increments('id').primary();
    table.text('source').notNullable().checkIn(['cli', 'ui'], 'telemetry_events_source_check');
    table.uuid('clientId').notNullable();
    table.text('event').notNullable();
    table.jsonb('attributes').notNullable().defaultTo('{}');
    table.integer('durationMs').nullable();
    table.text('status').notNullable().checkIn(['success', 'error'], 'telemetry_events_status_check');
    table.integer('exitCode').nullable();
    table.text('errorClass').nullable();
    table.integer('errorHttpStatus').nullable();
    table.text('errorCode').nullable();
    table.text('clientVersion').notNullable();
    table.text('runtimeVersion').nullable();
    table.text('platform').nullable();
    table.text('arch').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.index(['createdAt']);
    table.index(['source', 'createdAt']);
    table.index(['event']);
    table.index(['clientId']);
    table.index(['clientVersion']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TELEMETRY_EVENTS_TABLE);
}
