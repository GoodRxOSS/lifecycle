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

const EMPTY_OBJECT = '{}';
const EMPTY_ARRAY = '[]';
const AGENT_MESSAGES_CLIENT_MESSAGE_ID_INDEX_NAME = 'agent_messages_thread_client_message_id_unique';
const AGENT_SESSION_DEFAULTS_KEY = 'agentSessionDefaults';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPvcAccessMode(): 'ReadWriteOnce' | 'ReadWriteMany' {
  return process.env.AGENT_SESSION_PVC_ACCESS_MODE === 'ReadWriteMany' ? 'ReadWriteMany' : 'ReadWriteOnce';
}

function mergeAgentSessionDefaults(currentConfig: JsonObject): JsonObject {
  const currentWorkspaceStorage = isObject(currentConfig.workspaceStorage) ? currentConfig.workspaceStorage : {};
  const currentCleanup = isObject(currentConfig.cleanup) ? currentConfig.cleanup : {};
  const currentDurability = isObject(currentConfig.durability) ? currentConfig.durability : {};

  return {
    ...currentConfig,
    workspaceStorage: {
      defaultSize: '10Gi',
      allowedSizes: ['10Gi'],
      allowClientOverride: false,
      accessMode: getPvcAccessMode(),
      ...currentWorkspaceStorage,
    },
    cleanup: {
      activeIdleSuspendMs: 30 * 60 * 1000,
      startingTimeoutMs: 15 * 60 * 1000,
      hibernatedRetentionMs: 24 * 60 * 60 * 1000,
      intervalMs: 5 * 60 * 1000,
      redisTtlSeconds: 7200,
      ...currentCleanup,
    },
    durability: {
      runExecutionLeaseMs: 30 * 60 * 1000,
      queuedRunDispatchStaleMs: 30 * 1000,
      dispatchRecoveryLimit: 50,
      maxDurablePayloadBytes: 64 * 1024,
      payloadPreviewBytes: 16 * 1024,
      fileChangePreviewChars: 4000,
      ...currentDurability,
    },
  };
}

async function upsertAgentSessionDefaults(knex: Knex): Promise<void> {
  const row = await knex('global_config').where('key', AGENT_SESSION_DEFAULTS_KEY).first();
  const currentConfig = isObject(row?.config) ? row.config : {};
  const nextConfig = mergeAgentSessionDefaults(currentConfig);

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

async function removeAgentSessionOperationalDefaults(knex: Knex): Promise<void> {
  const row = await knex('global_config').where('key', AGENT_SESSION_DEFAULTS_KEY).first();
  if (!row || !isObject(row.config)) {
    return;
  }

  const { workspaceStorage: _workspaceStorage, cleanup: _cleanup, durability: _durability, ...nextConfig } = row.config;
  await knex('global_config').where('key', AGENT_SESSION_DEFAULTS_KEY).update({
    config: nextConfig,
    updatedAt: knex.fn.now(),
  });
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_sessions', (table) => {
    table.string('sessionKind').notNullable().defaultTo('environment');
    table.string('chatStatus').notNullable().defaultTo('ready');
    table.string('workspaceStatus').notNullable().defaultTo('ready');
    table.string('defaultModel').nullable();
    table.string('defaultHarness').nullable();
    table.integer('defaultThreadId').nullable();
  });

  await knex('agent_sessions').update({
    sessionKind: knex.raw(`case when "buildKind" = 'sandbox' then 'sandbox' else 'environment' end`),
    chatStatus: knex.raw(
      `case
         when "status" = 'ended' then 'ended'
         when "status" = 'error' then 'error'
         else 'ready'
       end`
    ),
    workspaceStatus: knex.raw(
      `case
         when "status" = 'starting' then 'provisioning'
         when "status" = 'active' then 'ready'
         when "status" = 'error' then 'failed'
         when "status" = 'ended' then 'ended'
         else 'ready'
       end`
    ),
    defaultModel: knex.raw('coalesce("defaultModel", "model")'),
    defaultHarness: knex.raw(`coalesce("defaultHarness", 'lifecycle_ai_sdk')`),
  });

  await knex.schema.alterTable('agent_sessions', (table) => {
    table.string('buildKind').nullable().alter();
    table.string('podName').nullable().alter();
    table.string('namespace').nullable().alter();
    table.string('pvcName').nullable().alter();
    table.string('defaultModel').notNullable().alter();
    table.foreign(['defaultThreadId']).references(['id']).inTable('agent_threads').onDelete('SET NULL');
    table.index(['defaultThreadId']);
  });

  await knex.raw(`
    update agent_sessions as session
    set "defaultThreadId" = thread.id
    from agent_threads as thread
    where thread."sessionId" = session.id
      and thread."isDefault" = true
      and thread."archivedAt" is null
      and session."defaultThreadId" is null
  `);

  await knex.schema.createTable('agent_sources', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('sessionId').notNullable().references('id').inTable('agent_sessions').onDelete('CASCADE');
    table.string('adapter').notNullable();
    table.string('status').notNullable().defaultTo('requested');
    table.jsonb('input').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('preparedSource').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('sandboxRequirements').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('error').nullable();
    table.timestamp('preparedAt').nullable();
    table.timestamp('cleanedUpAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.unique(['sessionId']);
    table.index(['status', 'createdAt']);
  });

  await knex.schema.createTable('agent_sandboxes', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('sessionId').notNullable().references('id').inTable('agent_sessions').onDelete('CASCADE');
    table.integer('generation').notNullable();
    table.string('provider').notNullable();
    table.string('status').notNullable().defaultTo('provisioning');
    table.jsonb('capabilitySnapshot').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('providerState').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('metadata').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('error').nullable();
    table.timestamp('suspendedAt').nullable();
    table.timestamp('endedAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.unique(['sessionId', 'generation']);
    table.index(['sessionId', 'createdAt']);
    table.index(['status', 'createdAt']);
  });

  await knex.schema.createTable('agent_sandbox_exposures', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('sandboxId').notNullable().references('id').inTable('agent_sandboxes').onDelete('CASCADE');
    table.string('kind').notNullable();
    table.string('status').notNullable().defaultTo('ready');
    table.integer('targetPort').nullable();
    table.text('url').nullable();
    table.jsonb('metadata').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('providerState').notNullable().defaultTo(EMPTY_OBJECT);
    table.timestamp('lastVerifiedAt').nullable();
    table.timestamp('endedAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.index(['sandboxId', 'kind']);
    table.index(['status', 'createdAt']);
  });

  await knex.schema.createTable('agent_run_events', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('runId').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
    table.integer('sequence').notNullable();
    table.string('eventType').notNullable();
    table.jsonb('payload').notNullable().defaultTo(EMPTY_OBJECT);
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.unique(['runId', 'sequence']);
    table.index(['runId', 'sequence']);
    table.index(['eventType', 'createdAt']);
  });

  await knex.schema.alterTable('agent_runs', (table) => {
    table.string('requestedHarness').nullable();
    table.string('resolvedHarness').nullable();
    table.string('requestedProvider').nullable();
    table.string('requestedModel').nullable();
    table.string('resolvedProvider').nullable();
    table.string('resolvedModel').nullable();
    table.jsonb('sandboxRequirement').notNullable().defaultTo(EMPTY_OBJECT);
    table.integer('sandboxGeneration').nullable();
    table.string('executionOwner').nullable();
    table.timestamp('leaseExpiresAt').nullable();
    table.timestamp('heartbeatAt').nullable();
    table.dropColumn('streamState');
    table.index(['status', 'leaseExpiresAt']);
  });

  await knex('agent_runs').update({
    requestedHarness: knex.raw(`coalesce("requestedHarness", 'lifecycle_ai_sdk')`),
    resolvedHarness: knex.raw(`coalesce("resolvedHarness", 'lifecycle_ai_sdk')`),
    requestedProvider: knex.raw('coalesce("requestedProvider", "provider")'),
    requestedModel: knex.raw('coalesce("requestedModel", "model")'),
    resolvedProvider: knex.raw('coalesce("resolvedProvider", "provider")'),
    resolvedModel: knex.raw('coalesce("resolvedModel", "model")'),
  });

  await knex.schema.alterTable('agent_messages', (table) => {
    table.uuid('uuid').nullable();
    table.string('clientMessageId').nullable();
    table.jsonb('parts').notNullable().defaultTo(EMPTY_ARRAY);
    table.jsonb('uiMessage').nullable().alter();
  });

  await knex('agent_messages').update({
    uuid: knex.raw('gen_random_uuid()'),
  });

  await knex.schema.alterTable('agent_messages', (table) => {
    table.uuid('uuid').notNullable().alter();
    table.unique(['uuid']);
  });

  await knex.raw(`
    with ranked as (
      select
        id,
        nullif(btrim(metadata->>'clientMessageId'), '') as "clientMessageId",
        row_number() over (
          partition by "threadId", nullif(btrim(metadata->>'clientMessageId'), '')
          order by id
        ) as rank
      from agent_messages
      where nullif(btrim(metadata->>'clientMessageId'), '') is not null
    )
    update agent_messages as message
    set "clientMessageId" = ranked."clientMessageId"
    from ranked
    where message.id = ranked.id
      and ranked.rank = 1
  `);

  await knex.raw(`
    create unique index ${AGENT_MESSAGES_CLIENT_MESSAGE_ID_INDEX_NAME}
    on agent_messages ("threadId", "clientMessageId")
    where "clientMessageId" is not null
  `);

  await knex.raw(`
    insert into agent_sources (
      "sessionId",
      "adapter",
      "status",
      "input",
      "preparedSource",
      "sandboxRequirements",
      "error",
      "preparedAt",
      "cleanedUpAt",
      "createdAt",
      "updatedAt"
    )
    select
      session.id,
      case
        when session."sessionKind" = 'chat' then 'blank_workspace'
        when session."buildKind" = 'sandbox' then 'lifecycle_fork'
        else 'lifecycle_environment'
      end,
      case
        when session.status = 'error' or session."workspaceStatus" = 'failed' then 'failed'
        when session.status = 'ended' then 'cleaned_up'
        else 'ready'
      end,
      jsonb_strip_nulls(
        jsonb_build_object(
          'buildUuid', session."buildUuid",
          'buildKind', session."buildKind",
          'sessionKind', session."sessionKind",
          'ownerGithubUsername', session."ownerGithubUsername"
        )
      ),
      jsonb_build_object(
        'kind', 'workspace_snapshot',
        'metadata',
        jsonb_strip_nulls(
          jsonb_build_object(
            'buildUuid', session."buildUuid",
            'buildKind', session."buildKind",
            'sessionKind', session."sessionKind"
          )
        )
      ),
      case
        when session."sessionKind" = 'chat' then '{"filesystem":"persistent","suspendMode":"filesystem","editorAccess":true,"previewPorts":true}'::jsonb
        else '{"filesystem":"persistent","suspendMode":"none","editorAccess":true,"previewPorts":true}'::jsonb
      end,
      case
        when session.status = 'error' or session."workspaceStatus" = 'failed' then jsonb_build_object('message', 'Source is not ready')
        else null
      end,
      case
        when session.status = 'ended' then null
        else session."updatedAt"
      end,
      case
        when session.status = 'ended' then coalesce(session."endedAt", session."updatedAt")
        else null
      end,
      session."createdAt",
      session."updatedAt"
    from agent_sessions as session
    where not exists (
      select 1
      from agent_sources as source
      where source."sessionId" = session.id
    )
  `);

  await knex.raw(`
    insert into agent_sandboxes (
      "sessionId",
      "generation",
      "provider",
      "status",
      "capabilitySnapshot",
      "providerState",
      "metadata",
      "error",
      "suspendedAt",
      "endedAt",
      "createdAt",
      "updatedAt"
    )
    select
      session.id,
      1,
      'lifecycle_kubernetes',
      case
        when session."workspaceStatus" = 'provisioning' then 'provisioning'
        when session."workspaceStatus" = 'hibernated' then 'suspended'
        when session.status = 'ended' or session."workspaceStatus" = 'ended' then 'ended'
        when session.status = 'error' or session."workspaceStatus" = 'failed' then 'failed'
        else 'ready'
      end,
      jsonb_build_object(
        'toolTransport', 'mcp',
        'persistentFilesystem', coalesce(session."pvcName", '') <> '',
        'portExposure', true,
        'editorAccess', true
      ),
      jsonb_strip_nulls(
        jsonb_build_object(
          'namespace', session.namespace,
          'podName', session."podName",
          'pvcName', session."pvcName"
        )
      ),
      jsonb_strip_nulls(
        jsonb_build_object(
          'sessionKind', session."sessionKind",
          'buildUuid', session."buildUuid",
          'buildKind', session."buildKind"
        )
      ),
      case
        when session.status = 'error' or session."workspaceStatus" = 'failed' then jsonb_build_object('message', 'Sandbox is not available')
        else null
      end,
      case
        when session."workspaceStatus" = 'hibernated' then session."updatedAt"
        else null
      end,
      case
        when session.status = 'ended' or session."workspaceStatus" = 'ended' then coalesce(session."endedAt", session."updatedAt")
        else null
      end,
      session."createdAt",
      session."updatedAt"
    from agent_sessions as session
    where (coalesce(session.namespace, '') <> '' or coalesce(session."podName", '') <> '' or coalesce(session."pvcName", '') <> '')
      and not exists (
        select 1
        from agent_sandboxes as sandbox
        where sandbox."sessionId" = session.id
          and sandbox.generation = 1
      )
  `);

  await knex.raw(`
    insert into agent_sandbox_exposures (
      "sandboxId",
      "kind",
      "status",
      "targetPort",
      "url",
      "metadata",
      "providerState",
      "lastVerifiedAt",
      "endedAt",
      "createdAt",
      "updatedAt"
    )
    select
      sandbox.id,
      'editor',
      case
        when sandbox.status = 'ended' then 'ended'
        when sandbox.status = 'failed' then 'failed'
        when sandbox.status = 'provisioning' then 'provisioning'
        else 'ready'
      end,
      null,
      '/api/agent-session/workspace-editor/' || session.uuid || '/',
      '{"attachmentKind":"mcp_gateway"}'::jsonb,
      '{}'::jsonb,
      case
        when sandbox.status = 'ready' then sandbox."updatedAt"
        else null
      end,
      sandbox."endedAt",
      sandbox."createdAt",
      sandbox."updatedAt"
    from agent_sandboxes as sandbox
    join agent_sessions as session
      on session.id = sandbox."sessionId"
    where not exists (
      select 1
      from agent_sandbox_exposures as exposure
      where exposure."sandboxId" = sandbox.id
        and exposure.kind = 'editor'
        and exposure."endedAt" is null
    )
  `);

  await upsertAgentSessionDefaults(knex);
}

export async function down(knex: Knex): Promise<void> {
  const chatSession = await knex('agent_sessions').where('sessionKind', 'chat').first();
  if (chatSession) {
    throw new Error('Cannot roll back agent session control-plane contract while chat sessions exist');
  }

  await knex.schema.dropTableIfExists('agent_run_events');
  await knex.schema.dropTableIfExists('agent_sandbox_exposures');
  await knex.schema.dropTableIfExists('agent_sandboxes');
  await knex.schema.dropTableIfExists('agent_sources');
  await removeAgentSessionOperationalDefaults(knex);
  await knex.raw(`drop index if exists ${AGENT_MESSAGES_CLIENT_MESSAGE_ID_INDEX_NAME}`);

  await knex('agent_messages')
    .whereNull('uiMessage')
    .update({
      uiMessage: knex.raw(`
        jsonb_build_object(
          'id', "uuid",
          'role', "role",
          'parts', "parts",
          'metadata', "metadata"
        )
      `),
    });

  await knex.schema.alterTable('agent_messages', (table) => {
    table.jsonb('uiMessage').notNullable().alter();
  });

  await knex.schema.alterTable('agent_messages', (table) => {
    table.dropUnique(['uuid']);
    table.dropColumn('clientMessageId');
    table.dropColumn('parts');
    table.dropColumn('uuid');
  });

  await knex.schema.alterTable('agent_runs', (table) => {
    table.dropColumn('sandboxGeneration');
    table.dropColumn('sandboxRequirement');
    table.dropColumn('resolvedModel');
    table.dropColumn('resolvedProvider');
    table.dropColumn('requestedModel');
    table.dropColumn('requestedProvider');
    table.dropColumn('resolvedHarness');
    table.dropColumn('requestedHarness');
    table.dropColumn('heartbeatAt');
    table.dropColumn('leaseExpiresAt');
    table.dropColumn('executionOwner');
    table.jsonb('streamState').notNullable().defaultTo(EMPTY_OBJECT);
  });

  await knex.schema.alterTable('agent_sessions', (table) => {
    table.dropForeign(['defaultThreadId']);
    table.dropColumn('defaultThreadId');
    table.dropColumn('defaultHarness');
    table.dropColumn('defaultModel');
  });

  await knex('agent_sessions').update({
    buildKind: knex.raw(`coalesce("buildKind", 'environment')`),
    podName: knex.raw(`coalesce("podName", '')`),
    namespace: knex.raw(`coalesce("namespace", '')`),
    pvcName: knex.raw(`coalesce("pvcName", '')`),
  });

  await knex.schema.alterTable('agent_sessions', (table) => {
    table.string('buildKind').notNullable().defaultTo('environment').alter();
    table.string('podName').notNullable().alter();
    table.string('namespace').notNullable().alter();
    table.string('pvcName').notNullable().alter();
    table.dropColumn('workspaceStatus');
    table.dropColumn('chatStatus');
    table.dropColumn('sessionKind');
  });
}
