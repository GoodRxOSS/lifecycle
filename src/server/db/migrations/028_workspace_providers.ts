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

// A remote-stamped sandbox row whose providerState never recorded that backend's handle markers
// (the same fields each provider's hasPersistedHandle requires) describes a K8s workspace left by a
// failed remote attempt; suspend/teardown would no-op remotely and orphan the namespace/pod/PVC.
const REMOTE_HANDLE_MARKERS: Record<string, string[]> = {
  opensandbox: ['sandboxId', 'lifecycleBaseUrl'],
  modal: ['appName'],
  e2b: ['sandboxId', 'domain'],
  daytona: ['sandboxId', 'apiUrl'],
};

const SYSTEM_MESSAGE_METADATA_KINDS = [
  'agent_switch',
  'environment_update',
  'environment_state',
  'runtime_controls_update',
];

const PROJECTION_PREFIX = '[Conversation event] ';

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

  // SECURITY: legacy exposure rows (preview and editor) persisted plaintext auth headers; both proxies
  // now resolve auth fresh from the sandbox row per request, so the at-rest copies are pure liability.
  await knex('agent_sandbox_exposures')
    .whereRaw(`jsonb_exists("providerState", 'headers')`)
    .update({ providerState: knex.raw(`"providerState" - 'headers'`) });

  for (const [provider, markers] of Object.entries(REMOTE_HANDLE_MARKERS)) {
    const missingMarker = markers.map((marker) => `NOT jsonb_exists("providerState", '${marker}')`).join(' OR ');
    const restamped = await knex('agent_sandboxes')
      .where({ provider })
      .whereRaw(`(${missingMarker})`)
      .whereRaw(
        `(jsonb_exists("providerState", 'podName') OR EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = agent_sandboxes."sessionId" AND s.namespace IS NOT NULL))`
      )
      .update({ provider: 'lifecycle_kubernetes' })
      .returning('id');
    if (restamped.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `028: restamped ${restamped.length} ${provider} sandbox row(s) to lifecycle_kubernetes ids=${restamped
          .map((row) => (typeof row === 'object' ? row.id : row))
          .join(',')}`
      );
    }
  }

  // End-of-run message sync used to overwrite durable system event rows with their model-input
  // projection (role flipped to user, first text prefixed "[Conversation event] "). That broke the
  // state-event delta lookup (filters on role='system') and the transcript chip rendering. The
  // write path is fixed; this restores rows corrupted before the fix.
  const corruptedSystemEventRows = await knex('agent_messages')
    .select('id', 'parts')
    .where('role', 'user')
    .whereRaw(`metadata->>'kind' = ANY(?)`, [SYSTEM_MESSAGE_METADATA_KINDS]);

  for (const row of corruptedSystemEventRows) {
    const parts = Array.isArray(row.parts) ? row.parts : [];
    const repairedParts = parts.map((part: { type?: string; text?: string }) =>
      part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(PROJECTION_PREFIX)
        ? { ...part, text: part.text.slice(PROJECTION_PREFIX.length) }
        : part
    );

    await knex('agent_messages')
      .where('id', row.id)
      .update({ role: 'system', parts: JSON.stringify(repairedParts) });
  }
}

// Only the lifecycle schema changes are reversible: stripped auth headers are not recoverable and
// must not be restored, and the pre-restamp provider stamps were wrong.
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
