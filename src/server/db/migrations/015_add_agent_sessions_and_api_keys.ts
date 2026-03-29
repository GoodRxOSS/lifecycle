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
  const existingAgentSessionDefaults = await knex('global_config').where('key', 'agentSessionDefaults').first();
  const defaultAgentSessionDefaults = {
    image: process.env.AGENT_IMAGE || null,
    editorImage: process.env.AGENT_EDITOR_IMAGE || null,
    readiness: {
      timeoutMs: parseInt(process.env.AGENT_POD_READY_TIMEOUT_MS || '60000', 10),
      pollMs: parseInt(process.env.AGENT_POD_READY_POLL_MS || '2000', 10),
    },
    resources: {
      agent: {
        requests: {
          cpu: process.env.AGENT_POD_CPU_REQUEST || '500m',
          memory: process.env.AGENT_POD_MEMORY_REQUEST || '1Gi',
        },
        limits: {
          cpu: process.env.AGENT_POD_CPU_LIMIT || '2',
          memory: process.env.AGENT_POD_MEMORY_LIMIT || '4Gi',
        },
      },
      editor: {
        requests: {
          cpu: process.env.AGENT_EDITOR_CPU_REQUEST || '250m',
          memory: process.env.AGENT_EDITOR_MEMORY_REQUEST || '512Mi',
        },
        limits: {
          cpu: process.env.AGENT_EDITOR_CPU_LIMIT || '1',
          memory: process.env.AGENT_EDITOR_MEMORY_LIMIT || '1Gi',
        },
      },
    },
    claude: {
      permissions: {
        allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
        deny: [],
      },
      attribution: {
        commitTemplate: 'Generated with ({appName})',
        prTemplate: 'Generated with ({appName})',
      },
    },
  };

  await knex.schema.createTable('agent_sessions', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('buildUuid').nullable().index();
    table.string('buildKind').notNullable().defaultTo('environment').index();
    table.string('userId').notNullable().index();
    table.string('ownerGithubUsername').nullable().index();
    table.string('podName').notNullable();
    table.string('namespace').notNullable();
    table.string('pvcName').notNullable();
    table.string('model').notNullable();
    table.string('status').notNullable().defaultTo('starting');
    table.timestamp('lastActivity').notNullable().defaultTo(knex.fn.now());
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('endedAt').nullable();
    table.jsonb('devModeSnapshots').notNullable().defaultTo('{}');
    table.jsonb('forwardedAgentSecretProviders').notNullable().defaultTo('[]');
  });
  await knex.raw(`
    create unique index agent_sessions_active_environment_build_unique
    on agent_sessions ("buildUuid")
    where "buildUuid" is not null
      and "buildKind" = 'environment'
      and "status" in ('starting', 'active')
  `);

  await knex.schema.createTable('user_api_keys', (table) => {
    table.increments('id').primary();
    table.string('userId').notNullable().index();
    table.string('ownerGithubUsername').notNullable().index();
    table.string('provider').notNullable().defaultTo('anthropic');
    table.text('encryptedKey').notNullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());
    table.unique(['ownerGithubUsername', 'provider']);
  });

  await knex.schema.alterTable('deploys', (table) => {
    table.boolean('devMode').notNullable().defaultTo(false);
    table.integer('devModeSessionId').nullable().references('id').inTable('agent_sessions');
  });

  await knex.schema.alterTable('builds', (table) => {
    table.string('kind').notNullable().defaultTo('environment');
    table.integer('baseBuildId').nullable().references('id').inTable('builds').onUpdate('CASCADE').onDelete('SET NULL');
    table.index(['kind']);
    table.index(['baseBuildId']);
  });

  if (!existingAgentSessionDefaults) {
    await knex('global_config').insert({
      key: 'agentSessionDefaults',
      config: defaultAgentSessionDefaults,
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: 'Default configuration for agent session runtime images and Claude Code bootstrap behavior.',
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasDeploysTable = await knex.schema.hasTable('deploys');
  if (hasDeploysTable) {
    const hasDevModeSessionId = await knex.schema.hasColumn('deploys', 'devModeSessionId');
    const hasDevMode = await knex.schema.hasColumn('deploys', 'devMode');
    if (hasDevModeSessionId || hasDevMode) {
      await knex.schema.alterTable('deploys', (table) => {
        if (hasDevModeSessionId) {
          table.dropColumn('devModeSessionId');
        }
        if (hasDevMode) {
          table.dropColumn('devMode');
        }
      });
    }
  }

  await knex.raw('drop index if exists agent_sessions_active_environment_build_unique');

  const hasBuildsTable = await knex.schema.hasTable('builds');
  if (hasBuildsTable) {
    const hasBaseBuildId = await knex.schema.hasColumn('builds', 'baseBuildId');
    const hasKind = await knex.schema.hasColumn('builds', 'kind');
    if (hasBaseBuildId || hasKind) {
      await knex.schema.alterTable('builds', (table) => {
        if (hasBaseBuildId) {
          table.dropIndex(['baseBuildId']);
          table.dropColumn('baseBuildId');
        }
        if (hasKind) {
          table.dropIndex(['kind']);
          table.dropColumn('kind');
        }
      });
    }
  }

  await knex.schema.dropTableIfExists('user_api_keys');
  await knex.schema.dropTableIfExists('agent_sessions');
  await knex('global_config').where('key', 'agentSessionDefaults').delete();
}
