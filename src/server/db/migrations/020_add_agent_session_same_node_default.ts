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

const AGENT_SESSION_DEFAULTS_KEY = 'agentSessionDefaults';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function up(knex: Knex): Promise<void> {
  const hasPolicyColumn = await knex.schema.hasColumn('agent_sessions', 'keepAttachedServicesOnSessionNode');
  if (!hasPolicyColumn) {
    await knex.schema.alterTable('agent_sessions', (table) => {
      table.boolean('keepAttachedServicesOnSessionNode').nullable();
    });
  }

  const row = await knex('global_config').where('key', AGENT_SESSION_DEFAULTS_KEY).first();
  const currentConfig = isObject(row?.config) ? row.config : {};
  const currentScheduling = isObject(currentConfig.scheduling) ? currentConfig.scheduling : {};

  if (typeof currentScheduling.keepAttachedServicesOnSessionNode === 'boolean') {
    return;
  }

  const nextConfig = {
    ...currentConfig,
    scheduling: {
      ...currentScheduling,
      keepAttachedServicesOnSessionNode: true,
    },
  };

  if (!row) {
    await knex('global_config').insert({
      key: AGENT_SESSION_DEFAULTS_KEY,
      config: nextConfig,
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: 'Default configuration for agent session workspace runtime.',
    });
    return;
  }

  await knex('global_config').where('key', AGENT_SESSION_DEFAULTS_KEY).update({
    config: nextConfig,
    updatedAt: knex.fn.now(),
  });
}

export async function down(knex: Knex): Promise<void> {
  const row = await knex('global_config').where('key', AGENT_SESSION_DEFAULTS_KEY).first();
  const currentConfig = isObject(row?.config) ? row.config : {};
  const currentScheduling = isObject(currentConfig.scheduling) ? currentConfig.scheduling : null;

  if (currentScheduling && 'keepAttachedServicesOnSessionNode' in currentScheduling) {
    const { keepAttachedServicesOnSessionNode: _ignored, ...restScheduling } = currentScheduling;
    const { scheduling: _removedScheduling, ...restConfig } = currentConfig;

    await knex('global_config')
      .where('key', AGENT_SESSION_DEFAULTS_KEY)
      .update({
        config: {
          ...restConfig,
          ...(Object.keys(restScheduling).length > 0 ? { scheduling: restScheduling } : {}),
        },
        updatedAt: knex.fn.now(),
      });
  }

  const hasPolicyColumn = await knex.schema.hasColumn('agent_sessions', 'keepAttachedServicesOnSessionNode');
  if (hasPolicyColumn) {
    await knex.schema.alterTable('agent_sessions', (table) => {
      table.dropColumn('keepAttachedServicesOnSessionNode');
    });
  }
}
