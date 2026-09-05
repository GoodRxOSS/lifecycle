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

export const config = { transaction: true };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX agent_sessions_review_updated_created_id_idx
      ON agent_sessions ("updatedAt" DESC, "createdAt" DESC, id DESC);
  `);

  await knex.schema.alterTable('agent_messages', (table) => {
    table.unique(['id', 'threadId'], 'agent_messages_id_thread_feedback_unique');
  });

  await knex.schema.createTable('agent_feedback', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('threadId').notNullable().references('id').inTable('agent_threads').onDelete('CASCADE');
    table.integer('messageId').nullable();
    table.string('userId', 255).notNullable();
    table.string('rating', 4).notNullable();
    table.text('text').nullable();
    table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.jsonb('reasons').notNullable().defaultTo('[]');
    table
      .foreign(['messageId', 'threadId'])
      .references(['id', 'threadId'])
      .inTable('agent_messages')
      .onDelete('CASCADE');
    table.unique(['messageId', 'userId'], 'agent_feedback_message_user_unique');
    table.index(['updatedAt', 'id']);
    table.index(['rating', 'updatedAt', 'id']);
    table.index(['threadId', 'userId']);
  });

  await knex.raw(`
    CREATE UNIQUE INDEX agent_feedback_thread_user_unique
      ON agent_feedback ("threadId", "userId") WHERE "messageId" IS NULL;
    ALTER TABLE agent_feedback
      ADD CONSTRAINT agent_feedback_rating_check CHECK (rating IN ('up', 'down')),
      ADD CONSTRAINT agent_feedback_text_length_check CHECK (text IS NULL OR char_length(text) <= 10000),
      ADD CONSTRAINT agent_feedback_reasons_check CHECK (
        jsonb_typeof(reasons) = 'array'
        AND jsonb_array_length(reasons) <= 7
        AND CASE rating
          WHEN 'up' THEN reasons <@ '["solved_task","other","clear_explanation","evidence_backed","actionable_steps"]'::jsonb
          WHEN 'down' THEN reasons <@ '["incorrect_or_incomplete","did_not_follow_instructions","other","missing_evidence","unhelpful_steps","wrong_context","too_slow"]'::jsonb
          ELSE false
        END
      );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('agent_feedback');
  await knex.schema.alterTable('agent_messages', (table) => {
    table.dropUnique(['id', 'threadId'], 'agent_messages_id_thread_feedback_unique');
  });
  await knex.raw('DROP INDEX agent_sessions_review_updated_created_id_idx');
}
