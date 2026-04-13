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
const EMPTY_SKILL_PLAN = `'{"version":1,"skills":[]}'::jsonb`;
const AUTH_CONFIG_NONE_JSON = `'{"mode":"none"}'::jsonb`;
const DEPLOYS_DEV_MODE_SESSION_FK = 'deploys_devModeSessionId_foreign';
const AGENT_SESSION_DEPLOY_CLEANUP_TRIGGER = 'agent_sessions_cleanup_dev_mode_deploys_trigger';
const AGENT_SESSION_DEPLOY_CLEANUP_FUNCTION = 'agent_sessions_cleanup_dev_mode_deploys';
const AGENT_THREADS_ID_SESSION_UNIQUE = 'agent_threads_id_session_unique';
const AGENT_RUNS_ID_THREAD_UNIQUE = 'agent_runs_id_thread_unique';
const AGENT_RUNS_THREAD_SESSION_FK = 'agent_runs_thread_session_foreign';
const AGENT_PENDING_ACTIONS_RUN_THREAD_FK = 'agent_pending_actions_run_thread_foreign';
const AGENT_TOOL_EXECUTIONS_RUN_THREAD_FK = 'agent_tool_executions_run_thread_foreign';
const AGENT_MESSAGES_VALIDATE_RUN_TRIGGER = 'agent_messages_validate_run_trigger';
const AGENT_MESSAGES_VALIDATE_RUN_FUNCTION = 'agent_messages_validate_run';
const AGENT_SESSION_DEFAULTS_KEY = 'agentSessionDefaults';
const AGENT_SESSION_DEFAULTS_DESCRIPTION =
  'Default configuration for agent session workspace runtime images, control-plane system prompts, and session workspace resources.';
const CURRENT_CONTROL_PLANE_SYSTEM_PROMPT = [
  'You are Lifecycle Agent Session, a coding agent operating on a real workspace through tool calls.',
  'Use the available tools directly when you need to inspect files, search the workspace, run commands, or modify code.',
  'Do not emit pseudo-tool markup or pretend execution happened. Never write things like <read_file>, <write_file>, <attempt_completion>, <result>, or shell commands as if they were already executed.',
  'Do not claim that a file was read, a command was run, or a change was made unless that happened through an actual tool call in this conversation.',
  'If a tool call fails or a capability is unavailable, say that plainly and explain what failed.',
].join('\n');

type JsonObject = Record<string, unknown>;

type LegacyMcpServerConfigRow = {
  slug: string;
  name: string;
  description: string | null;
  url: string;
  scope: string;
  headers: unknown;
  envVars: unknown;
  enabled: boolean;
  timeout: unknown;
  cachedTools: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  deletedAt: unknown;
};

type FinalMcpServerConfigRow = {
  slug: string;
  name: string;
  description: string | null;
  scope: string;
  preset: string | null;
  transport: unknown;
  sharedConfig: unknown;
  authConfig: unknown;
  enabled: boolean;
  timeout: unknown;
  sharedDiscoveredTools: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  deletedAt: unknown;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) {
    return {};
  }

  return Object.entries(value).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (!key.trim() || typeof entry !== 'string' || !entry.trim()) {
      return acc;
    }

    acc[key.trim()] = entry.trim();
    return acc;
  }, {});
}

function normalizeJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeFinalTimeoutMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value <= 1000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed <= 1000 ? Math.trunc(parsed * 1000) : Math.trunc(parsed);
    }
  }

  return 30000;
}

function normalizeLegacyTimeoutSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value > 1000 ? Math.max(0, Math.ceil(value / 1000)) : Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed > 1000 ? Math.max(0, Math.ceil(parsed / 1000)) : Math.trunc(parsed);
    }
  }

  return 30;
}

function readEnvInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildResourceRequirements(
  requestCpu: string,
  requestMemory: string,
  limitCpu: string,
  limitMemory: string
): JsonObject {
  return {
    requests: {
      cpu: requestCpu,
      memory: requestMemory,
    },
    limits: {
      cpu: limitCpu,
      memory: limitMemory,
    },
  };
}

function buildDefaultWorkspaceGatewayResources(): JsonObject {
  return buildResourceRequirements(
    process.env.AGENT_SESSION_WORKSPACE_GATEWAY_CPU_REQUEST || '100m',
    process.env.AGENT_SESSION_WORKSPACE_GATEWAY_MEMORY_REQUEST || '256Mi',
    process.env.AGENT_SESSION_WORKSPACE_GATEWAY_CPU_LIMIT || '500m',
    process.env.AGENT_SESSION_WORKSPACE_GATEWAY_MEMORY_LIMIT || '512Mi'
  );
}

function buildDefaultWorkspaceResources(): JsonObject {
  return buildResourceRequirements(
    process.env.AGENT_SESSION_WORKSPACE_CPU_REQUEST || '500m',
    process.env.AGENT_SESSION_WORKSPACE_MEMORY_REQUEST || '1Gi',
    process.env.AGENT_SESSION_WORKSPACE_CPU_LIMIT || '2',
    process.env.AGENT_SESSION_WORKSPACE_MEMORY_LIMIT || '4Gi'
  );
}

function buildDefaultWorkspaceEditorResources(): JsonObject {
  return buildResourceRequirements(
    process.env.AGENT_SESSION_WORKSPACE_EDITOR_CPU_REQUEST || '250m',
    process.env.AGENT_SESSION_WORKSPACE_EDITOR_MEMORY_REQUEST || '512Mi',
    process.env.AGENT_SESSION_WORKSPACE_EDITOR_CPU_LIMIT || '1',
    process.env.AGENT_SESSION_WORKSPACE_EDITOR_MEMORY_LIMIT || '1Gi'
  );
}

function buildDefaultAgentSessionDefaults(): JsonObject {
  const workspaceImage = normalizeOptionalString(process.env.AGENT_SESSION_WORKSPACE_IMAGE) ?? null;
  const workspaceEditorImage = normalizeOptionalString(process.env.AGENT_SESSION_WORKSPACE_EDITOR_IMAGE) ?? null;

  return {
    workspaceImage,
    workspaceEditorImage,
    workspaceGatewayImage: workspaceImage,
    readiness: {
      timeoutMs: readEnvInteger('AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS', 60000),
      pollMs: readEnvInteger('AGENT_SESSION_WORKSPACE_READY_POLL_MS', 2000),
    },
    resources: {
      workspace: buildDefaultWorkspaceResources(),
      editor: buildDefaultWorkspaceEditorResources(),
      workspaceGateway: buildDefaultWorkspaceGatewayResources(),
    },
    controlPlane: {
      systemPrompt: CURRENT_CONTROL_PLANE_SYSTEM_PROMPT,
    },
  };
}

async function migrateAgentSessionDefaultsUp(knex: Knex): Promise<void> {
  const row = await knex('global_config').where('key', AGENT_SESSION_DEFAULTS_KEY).first();
  if (row) {
    return;
  }

  await knex('global_config').insert({
    key: AGENT_SESSION_DEFAULTS_KEY,
    config: buildDefaultAgentSessionDefaults(),
    createdAt: knex.fn.now(),
    updatedAt: knex.fn.now(),
    deletedAt: null,
    description: AGENT_SESSION_DEFAULTS_DESCRIPTION,
  });
}

async function migrateAgentSessionDefaultsDown(knex: Knex): Promise<void> {
  return;
}

function createFinalMcpTable(knex: Knex): Promise<void> {
  return knex.schema.createTable('mcp_server_configs', (table) => {
    table.increments('id').primary();
    table.string('slug', 100).notNullable();
    table.string('name', 255).notNullable();
    table.text('description').nullable();
    table.string('scope', 255).notNullable().index();
    table.string('preset', 100).nullable();
    table.jsonb('transport').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('sharedConfig').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('authConfig').notNullable().defaultTo(knex.raw(AUTH_CONFIG_NONE_JSON));
    table.boolean('enabled').notNullable().defaultTo(true);
    table.integer('timeout').notNullable().defaultTo(30000);
    table.jsonb('sharedDiscoveredTools').notNullable().defaultTo(EMPTY_ARRAY);
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deletedAt').nullable();
    table.unique(['slug', 'scope']);
    table.index(['scope', 'enabled']);
  });
}

function createLegacyMcpTable(knex: Knex): Promise<void> {
  return knex.schema.createTable('mcp_server_configs', (table) => {
    table.increments('id').primary();
    table.string('slug', 100).notNullable();
    table.string('name', 255).notNullable();
    table.string('description', 1000).nullable();
    table.string('url', 2048).notNullable();
    table.string('scope', 255).notNullable().defaultTo('global');
    table.jsonb('headers').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('envVars').notNullable().defaultTo(EMPTY_OBJECT);
    table.boolean('enabled').notNullable().defaultTo(true);
    table.integer('timeout').notNullable().defaultTo(30);
    table.jsonb('cachedTools').notNullable().defaultTo(EMPTY_ARRAY);
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.timestamp('deletedAt', { useTz: true });
    table.unique(['slug', 'scope']);
    table.index(['scope']);
  });
}

function toFinalMcpServerConfigRow(row: LegacyMcpServerConfigRow): Record<string, unknown> {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    scope: row.scope,
    preset: null,
    transport: {
      type: 'http',
      url: row.url,
      headers: {},
    },
    sharedConfig: {
      headers: normalizeStringMap(row.headers),
      env: normalizeStringMap(row.envVars),
    },
    authConfig: {
      mode: 'none',
    },
    enabled: row.enabled !== false,
    timeout: normalizeFinalTimeoutMs(row.timeout),
    sharedDiscoveredTools: normalizeJsonArray(row.cachedTools),
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
    deletedAt: row.deletedAt ?? null,
  };
}

function toLegacyMcpServerConfigRow(row: FinalMcpServerConfigRow): Record<string, unknown> {
  const transport = isObject(row.transport) ? row.transport : null;
  const sharedConfig = isObject(row.sharedConfig) ? row.sharedConfig : {};
  const authConfig = isObject(row.authConfig) ? row.authConfig : {};
  const transportType = transport?.type;
  const url = normalizeOptionalString(transport?.url);

  if (transportType !== 'http' || !url) {
    throw new Error(`Rollback blocked by MCP transport for scope=${row.scope} slug=${row.slug}`);
  }

  if (authConfig.mode !== undefined && authConfig.mode !== 'none') {
    throw new Error(`Rollback blocked by MCP authConfig for scope=${row.scope} slug=${row.slug}`);
  }

  const query = normalizeStringMap(sharedConfig.query);
  const defaultArgs = normalizeStringMap(sharedConfig.defaultArgs);
  if (Object.keys(query).length > 0 || Object.keys(defaultArgs).length > 0) {
    throw new Error(`Rollback blocked by MCP query/defaultArgs for scope=${row.scope} slug=${row.slug}`);
  }

  const mergedHeaders = {
    ...normalizeStringMap(transport?.headers),
    ...normalizeStringMap(sharedConfig.headers),
  };

  return {
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    url,
    scope: row.scope,
    headers: mergedHeaders,
    envVars: normalizeStringMap(sharedConfig.env),
    enabled: row.enabled !== false,
    timeout: normalizeLegacyTimeoutSeconds(row.timeout),
    cachedTools: normalizeJsonArray(row.sharedDiscoveredTools),
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
    deletedAt: row.deletedAt ?? null,
  };
}

async function migrateMcpServerConfigsUp(knex: Knex): Promise<void> {
  const legacyRows = (await knex<LegacyMcpServerConfigRow>('mcp_server_configs').select('*')) || [];

  await knex.schema.dropTable('mcp_server_configs');
  await createFinalMcpTable(knex);

  if (legacyRows.length > 0) {
    await knex('mcp_server_configs').insert(legacyRows.map(toFinalMcpServerConfigRow));
  }
}

async function migrateMcpServerConfigsDown(knex: Knex): Promise<void> {
  const finalRows = (await knex<FinalMcpServerConfigRow>('mcp_server_configs').select('*')) || [];
  const legacyRows = finalRows.map(toLegacyMcpServerConfigRow);

  await knex.schema.dropTable('mcp_server_configs');
  await createLegacyMcpTable(knex);

  if (legacyRows.length > 0) {
    await knex('mcp_server_configs').insert(legacyRows);
  }
}

async function clearDisposableAgentRuntimeState(knex: Knex): Promise<void> {
  await knex('deploys').where('devMode', true).orWhereNotNull('devModeSessionId').update({
    devMode: false,
    devModeSessionId: null,
  });

  await knex('agent_prewarms').del();
  await knex('agent_sessions').del();
}

async function migrateAgentSessionDeleteRootUp(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table "deploys"
    drop constraint if exists "${DEPLOYS_DEV_MODE_SESSION_FK}"
  `);

  await knex.schema.alterTable('deploys', (table) => {
    table.foreign('devModeSessionId', DEPLOYS_DEV_MODE_SESSION_FK).references('agent_sessions.id').onDelete('SET NULL');
  });

  await knex.raw(`
    create or replace function "${AGENT_SESSION_DEPLOY_CLEANUP_FUNCTION}"()
    returns trigger
    language plpgsql
    as $$
    begin
      update "deploys"
      set "devMode" = false,
          "devModeSessionId" = null
      where "devModeSessionId" = old.id;

      return old;
    end;
    $$;
  `);

  await knex.raw(`
    drop trigger if exists "${AGENT_SESSION_DEPLOY_CLEANUP_TRIGGER}" on "agent_sessions"
  `);

  await knex.raw(`
    create trigger "${AGENT_SESSION_DEPLOY_CLEANUP_TRIGGER}"
    before delete on "agent_sessions"
    for each row
    execute function "${AGENT_SESSION_DEPLOY_CLEANUP_FUNCTION}"()
  `);
}

async function migrateAgentSessionDeleteRootDown(knex: Knex): Promise<void> {
  await knex.raw(`
    drop trigger if exists "${AGENT_SESSION_DEPLOY_CLEANUP_TRIGGER}" on "agent_sessions"
  `);

  await knex.raw(`
    drop function if exists "${AGENT_SESSION_DEPLOY_CLEANUP_FUNCTION}"()
  `);

  await knex.raw(`
    alter table "deploys"
    drop constraint if exists "${DEPLOYS_DEV_MODE_SESSION_FK}"
  `);

  await knex.schema.alterTable('deploys', (table) => {
    table.foreign('devModeSessionId', DEPLOYS_DEV_MODE_SESSION_FK).references('agent_sessions.id');
  });
}

async function migrateAgentSessionSkillPlanUp(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_sessions', (table) => {
    table.jsonb('skillPlan').notNullable().defaultTo(knex.raw(EMPTY_SKILL_PLAN));
  });
}

async function migrateAgentSessionSkillPlanDown(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_sessions', (table) => {
    table.dropColumn('skillPlan');
  });
}

async function migrateAgentMessageRunIntegrityUp(knex: Knex): Promise<void> {
  await knex.raw(`
    create or replace function "${AGENT_MESSAGES_VALIDATE_RUN_FUNCTION}"()
    returns trigger
    language plpgsql
    as $$
    begin
      if new."runId" is null then
        return new;
      end if;

      if exists (
        select 1
        from "agent_runs"
        where "id" = new."runId"
          and "threadId" = new."threadId"
      ) then
        return new;
      end if;

      raise exception 'agent_messages.runId must belong to the same thread'
        using errcode = '23514';
    end;
    $$;
  `);

  await knex.raw(`
    drop trigger if exists "${AGENT_MESSAGES_VALIDATE_RUN_TRIGGER}" on "agent_messages"
  `);

  await knex.raw(`
    create trigger "${AGENT_MESSAGES_VALIDATE_RUN_TRIGGER}"
    before insert or update of "threadId", "runId" on "agent_messages"
    for each row
    execute function "${AGENT_MESSAGES_VALIDATE_RUN_FUNCTION}"()
  `);
}

async function migrateAgentMessageRunIntegrityDown(knex: Knex): Promise<void> {
  await knex.raw(`
    drop trigger if exists "${AGENT_MESSAGES_VALIDATE_RUN_TRIGGER}" on "agent_messages"
  `);

  await knex.raw(`
    drop function if exists "${AGENT_MESSAGES_VALIDATE_RUN_FUNCTION}"()
  `);
}

async function createAgentTables(knex: Knex): Promise<void> {
  await knex.schema.createTable('agent_session_repo_config', (table) => {
    table.increments('id').primary();
    table.string('repositoryFullName', 255).notNullable().unique();
    table.jsonb('config').notNullable().defaultTo(EMPTY_OBJECT);
    table.timestamp('createdAt', { useTz: true });
    table.timestamp('updatedAt', { useTz: true });
    table.timestamp('deletedAt', { useTz: true });
    table.index(['repositoryFullName']);
  });

  await knex.schema.createTable('agent_threads', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('sessionId').notNullable().references('id').inTable('agent_sessions').onDelete('CASCADE');
    table.string('title').nullable();
    table.boolean('isDefault').notNullable().defaultTo(false);
    table.timestamp('archivedAt').nullable();
    table.timestamp('lastRunAt').nullable();
    table.jsonb('metadata').notNullable().defaultTo(EMPTY_OBJECT);
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.index(['sessionId', 'archivedAt', 'createdAt']);
    table.unique(['id', 'sessionId'], AGENT_THREADS_ID_SESSION_UNIQUE);
  });

  await knex.raw(`
    create unique index agent_threads_default_per_session_unique
    on agent_threads ("sessionId")
    where "isDefault" = true
      and "archivedAt" is null
  `);

  await knex.schema.createTable('agent_runs', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('threadId').notNullable().references('id').inTable('agent_threads').onDelete('CASCADE');
    table.integer('sessionId').notNullable().references('id').inTable('agent_sessions').onDelete('CASCADE');
    table.string('status').notNullable().defaultTo('queued');
    table.string('provider').notNullable();
    table.string('model').notNullable();
    table.timestamp('queuedAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('startedAt').nullable();
    table.timestamp('completedAt').nullable();
    table.timestamp('cancelledAt').nullable();
    table.jsonb('usageSummary').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('policySnapshot').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('streamState').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('error').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.unique(['id', 'threadId'], AGENT_RUNS_ID_THREAD_UNIQUE);
    table
      .foreign(['threadId', 'sessionId'], AGENT_RUNS_THREAD_SESSION_FK)
      .references(['id', 'sessionId'])
      .inTable('agent_threads')
      .onDelete('CASCADE');
    table.index(['threadId', 'createdAt']);
    table.index(['sessionId', 'createdAt']);
    table.index(['status', 'createdAt']);
  });

  await knex.schema.createTable('agent_messages', (table) => {
    table.increments('id').primary();
    table.integer('threadId').notNullable().references('id').inTable('agent_threads').onDelete('CASCADE');
    table.integer('runId').nullable().references('id').inTable('agent_runs').onDelete('SET NULL');
    table.string('role').notNullable();
    table.jsonb('uiMessage').notNullable();
    table.jsonb('metadata').notNullable().defaultTo(EMPTY_OBJECT);
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table.index(['threadId', 'createdAt']);
    table.index(['runId', 'createdAt']);
  });

  await knex.schema.createTable('agent_pending_actions', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('threadId').notNullable().references('id').inTable('agent_threads').onDelete('CASCADE');
    table.integer('runId').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
    table.string('kind').notNullable();
    table.string('status').notNullable().defaultTo('pending');
    table.string('capabilityKey').notNullable();
    table.text('title').notNullable();
    table.text('description').notNullable();
    table.jsonb('payload').notNullable().defaultTo(EMPTY_OBJECT);
    table.jsonb('resolution').nullable();
    table.timestamp('resolvedAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table
      .foreign(['runId', 'threadId'], AGENT_PENDING_ACTIONS_RUN_THREAD_FK)
      .references(['id', 'threadId'])
      .inTable('agent_runs')
      .onDelete('CASCADE');
    table.index(['runId', 'status']);
    table.index(['threadId', 'status']);
    table.index(['threadId', 'createdAt']);
    table.index(['runId', 'threadId']);
  });

  await knex.raw(`
    create index agent_pending_actions_approval_id_index
    on agent_pending_actions ((payload->>'approvalId'))
    where jsonb_exists(payload, 'approvalId')
  `);
  await knex.raw(`
    create index agent_pending_actions_tool_call_id_index
    on agent_pending_actions ((payload->>'toolCallId'))
    where jsonb_exists(payload, 'toolCallId')
  `);

  await knex.schema.createTable('agent_tool_executions', (table) => {
    table.increments('id').primary();
    table.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('threadId').notNullable().references('id').inTable('agent_threads').onDelete('CASCADE');
    table.integer('runId').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
    table.integer('pendingActionId').nullable().references('id').inTable('agent_pending_actions').onDelete('SET NULL');
    table.string('source').notNullable();
    table.string('serverSlug').nullable();
    table.string('toolName').notNullable();
    table.string('toolCallId').nullable();
    table.jsonb('args').notNullable();
    table.jsonb('result').nullable();
    table.string('status').notNullable().defaultTo('queued');
    table.string('safetyLevel').nullable();
    table.boolean('approved').nullable();
    table.timestamp('startedAt').nullable();
    table.timestamp('completedAt').nullable();
    table.integer('durationMs').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    table
      .foreign(['runId', 'threadId'], AGENT_TOOL_EXECUTIONS_RUN_THREAD_FK)
      .references(['id', 'threadId'])
      .inTable('agent_runs')
      .onDelete('CASCADE');
    table.index(['threadId', 'createdAt']);
    table.index(['runId', 'createdAt']);
    table.index(['runId', 'toolCallId', 'createdAt']);
    table.index(['runId', 'toolName', 'createdAt']);
    table.index(['source', 'serverSlug']);
  });

  await knex.schema.createTable('user_mcp_connections', (table) => {
    table.increments('id').primary();
    table.string('userId').notNullable().index();
    table.string('ownerGithubUsername').notNullable().index();
    table.string('scope', 255).notNullable();
    table.string('slug', 100).notNullable();
    table.text('encryptedState').notNullable();
    table.string('definitionFingerprint', 128).notNullable();
    table.jsonb('discoveredTools').notNullable().defaultTo(EMPTY_ARRAY);
    table.text('validationError').nullable();
    table.timestamp('validatedAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());
    table.unique(['ownerGithubUsername', 'scope', 'slug']);
    table.index(['scope', 'slug']);
  });
}

async function dropAgentTables(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('agent_tool_executions');
  await knex.schema.dropTableIfExists('agent_pending_actions');
  await knex.schema.dropTableIfExists('agent_messages');
  await knex.schema.dropTableIfExists('agent_runs');
  await knex.schema.dropTableIfExists('agent_threads');
  await knex.schema.dropTableIfExists('user_mcp_connections');
  await knex.schema.dropTableIfExists('agent_session_repo_config');
}

export async function up(knex: Knex): Promise<void> {
  await migrateAgentSessionDeleteRootUp(knex);
  await clearDisposableAgentRuntimeState(knex);
  await migrateAgentSessionSkillPlanUp(knex);
  await createAgentTables(knex);
  await migrateAgentMessageRunIntegrityUp(knex);
  await migrateMcpServerConfigsUp(knex);
  await migrateAgentSessionDefaultsUp(knex);
}

export async function down(knex: Knex): Promise<void> {
  await clearDisposableAgentRuntimeState(knex);
  await migrateMcpServerConfigsDown(knex);
  await migrateAgentMessageRunIntegrityDown(knex);
  await dropAgentTables(knex);
  await migrateAgentSessionSkillPlanDown(knex);
  await migrateAgentSessionDeleteRootDown(knex);
  await migrateAgentSessionDefaultsDown(knex);
}
