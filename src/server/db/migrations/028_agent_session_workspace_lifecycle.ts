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

// Sessions no longer "end": the conversation is durable and only the workspace is reclaimed.
// 'ended' becomes the reversible 'archived'; chat/workspace 'ended' collapse into ready/none so
// unarchived sessions are immediately usable (a fresh workspace provisions on the next message).
// keepWorkspace is a user pin: kept workspaces are never reclaimed by the cleanup job.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_runs', (table) => {
    table.jsonb('transition').nullable();
  });
  await knex.schema.alterTable('agent_sessions', (table) => {
    table.renameColumn('endedAt', 'archivedAt');
    table.boolean('keepWorkspace').notNullable().defaultTo(false);
  });
  await knex('agent_sessions').where({ status: 'ended' }).update({ status: 'archived' });
  await knex('agent_sessions').where({ chatStatus: 'ended' }).update({ chatStatus: 'ready' });
  await knex('agent_sessions').where({ workspaceStatus: 'ended' }).update({ workspaceStatus: 'none' });
  await knex('agent_sessions').whereNot({ status: 'archived' }).whereNotNull('archivedAt').update({ archivedAt: null });
  // Sources are input specs, not infrastructure: revive them so archived chats stay usable.
  await knex('agent_sources').where({ status: 'cleaned_up' }).update({ status: 'ready', cleanedUpAt: null });
}

export async function down(knex: Knex): Promise<void> {
  await knex('agent_sessions')
    .where({ status: 'archived' })
    .update({ status: 'ended', chatStatus: 'ended', workspaceStatus: 'ended' });
  await knex.schema.alterTable('agent_sessions', (table) => {
    table.renameColumn('archivedAt', 'endedAt');
    table.dropColumn('keepWorkspace');
  });
  await knex.schema.alterTable('agent_runs', (table) => {
    table.dropColumn('transition');
  });
}
