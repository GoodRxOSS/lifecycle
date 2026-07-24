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

const MAX_FEEDBACK_TEXT_LENGTH = 10_000;

const MESSAGE_RATING_CHECK = 'message_feedback_rating_check';
const CONVERSATION_RATING_CHECK = 'conversation_feedback_rating_check';
const MESSAGE_TEXT_LENGTH_CHECK = 'message_feedback_text_length_check';
const CONVERSATION_TEXT_LENGTH_CHECK = 'conversation_feedback_text_length_check';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversations', (table) => {
    table.string('buildUuid', 255).primary();
    table.string('repo', 500).notNullable();
    table.string('model', 255).nullable();
    table.integer('messageCount').notNullable().defaultTo(0);
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.index(['repo']);
    table.index(['createdAt']);
  });

  await knex.schema.createTable('conversation_messages', (table) => {
    table.increments('id').primary();
    table.string('buildUuid', 255).notNullable().references('buildUuid').inTable('conversations').onDelete('CASCADE');
    table.string('role', 20).notNullable();
    table.text('content').notNullable();
    table.bigInteger('timestamp').notNullable();
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.index(['buildUuid']);
    table.index(['buildUuid', 'timestamp']);
  });

  await knex.schema.createTable('message_feedback', (table) => {
    table.increments('id').primary();
    table.string('buildUuid', 255).notNullable().references('buildUuid').inTable('conversations').onDelete('CASCADE');
    table
      .integer('messageId')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('conversation_messages')
      .onDelete('CASCADE');
    table.string('rating', 10).notNullable();
    table.text('text').nullable();
    table.string('userIdentifier', 255).nullable();
    table.string('repo', 500).notNullable();
    table.integer('prNumber').nullable();
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.index(['buildUuid']);
    table.index(['messageId']);
    table.index(['repo']);
    table.index(['rating']);
    table.index(['createdAt']);
    table.unique(['buildUuid', 'messageId'], 'message_feedback_build_uuid_message_id_unique');
  });

  await knex.schema.createTable('conversation_feedback', (table) => {
    table.increments('id').primary();
    table.string('buildUuid', 255).notNullable().references('buildUuid').inTable('conversations').onDelete('CASCADE');
    table.string('rating', 10).notNullable();
    table.text('text').nullable();
    table.string('userIdentifier', 255).nullable();
    table.string('repo', 500).notNullable();
    table.integer('prNumber').nullable();
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.index(['buildUuid']);
    table.index(['repo']);
    table.index(['rating']);
    table.index(['createdAt']);
    table.unique(['buildUuid'], 'conversation_feedback_build_uuid_unique');
  });

  await knex.raw(`
    ALTER TABLE message_feedback
    ADD CONSTRAINT ${MESSAGE_RATING_CHECK}
      CHECK (rating IN ('up', 'down')),
    ADD CONSTRAINT ${MESSAGE_TEXT_LENGTH_CHECK}
      CHECK (text IS NULL OR char_length(text) <= ${MAX_FEEDBACK_TEXT_LENGTH});
  `);

  await knex.raw(`
    ALTER TABLE conversation_feedback
    ADD CONSTRAINT ${CONVERSATION_RATING_CHECK}
      CHECK (rating IN ('up', 'down')),
    ADD CONSTRAINT ${CONVERSATION_TEXT_LENGTH_CHECK}
      CHECK (text IS NULL OR char_length(text) <= ${MAX_FEEDBACK_TEXT_LENGTH});
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('message_feedback');
  await knex.schema.dropTableIfExists('conversation_feedback');
  await knex.schema.dropTableIfExists('conversation_messages');
  await knex.schema.dropTableIfExists('conversations');
}
