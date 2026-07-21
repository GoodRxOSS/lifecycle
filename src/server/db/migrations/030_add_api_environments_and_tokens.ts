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

const PERSONAL_POLICY_CHECK = 'api_tokens_personal_policy_check';
const KIND_CONSISTENCY_CHECK = 'api_tokens_kind_consistency_check';
const API_ENVIRONMENTS_DESCRIPTION =
  'API-created environments: master switch for POST /api/v2/environments plus default/max lease lifetimes in hours.';
const API_KEYS_DESCRIPTION =
  'API keys: issuance and per-kind authentication switches, key-request rate limit, and per-user active personal key cap.';

const PERSONAL_GRANTABLE_SCOPES = '["env:read", "env:write", "sites:read", "sites:write", "repos:read", "repos:write"]';

const BUILDS_INDEXES = [
  { name: 'builds_createdbytokenid_index', definition: 'on builds ("createdByTokenId")' },
  { name: 'builds_createdbyuserid_index', definition: 'on builds ("createdByUserId")' },
  { name: 'builds_triggertype_index', definition: 'on builds ("triggerType")' },
  {
    name: 'builds_api_expiry_sweep',
    definition: `on builds ("expiresAt") where "triggerType" = 'api' and "expiresAt" is not null`,
  },
  {
    name: 'builds_api_auto_track',
    definition: `on builds ("githubRepositoryId", "branchName") where "triggerType" = 'api' and "autoTrack" = true`,
  },
] as const;

// Both allowlists null means an all-repository grant; otherwise both must be non-empty.
const ACTIVE_PERSONAL_AUTHORITY_CHECK = `
  "ownerUserId" IS NULL OR
  "revokedAt" IS NOT NULL OR (
    CASE WHEN jsonb_typeof("scopes") = 'array'
      THEN jsonb_array_length("scopes") > 0 AND "scopes" <@ '${PERSONAL_GRANTABLE_SCOPES}'::jsonb
      ELSE false
    END AND (
      ("repositoryAllowlist" IS NULL AND "repositoryAllowlistRepoIds" IS NULL) OR (
        CASE WHEN jsonb_typeof("repositoryAllowlist") = 'array'
          THEN jsonb_array_length("repositoryAllowlist") > 0
          ELSE false
        END AND
        CASE WHEN jsonb_typeof("repositoryAllowlistRepoIds") = 'array'
          THEN jsonb_array_length("repositoryAllowlistRepoIds") > 0
          ELSE false
        END
      )
    )
  )
`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_tokens', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.string('tokenHash', 64).notNullable().unique();
    table.string('tokenPrefix', 16).notNullable();
    table.string('kind', 16).notNullable();
    table.jsonb('scopes').notNullable().defaultTo('[]');
    table.jsonb('repositoryAllowlist').nullable();
    table.string('createdBy').notNullable();
    table.timestamp('lastUsedAt').nullable();
    table.timestamp('expiresAt').nullable();
    table.timestamp('revokedAt').nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());

    /* Identity binding for personal tokens; all null for admin-minted service tokens. */
    table.string('ownerUserId').nullable().index();
    table.string('ownerGithubUsername').nullable();
    table.string('ownerEmail').nullable().index();
    table.string('ownerPreferredUsername').nullable().index();
    table.string('ownerDisplayName').nullable();
    table.string('ownerRoleAtIssue').nullable();
    /* Allowlist bound to repo identity (githubRepositoryId), not the mutable fullName. */
    table.jsonb('repositoryAllowlistRepoIds').nullable();
    table.string('revokedBy').nullable();
    table.string('revokeReason', 32).nullable();
  });

  await knex.raw(`ALTER TABLE api_tokens ADD CONSTRAINT ?? CHECK (${ACTIVE_PERSONAL_AUTHORITY_CHECK})`, [
    PERSONAL_POLICY_CHECK,
  ]);
  await knex.raw(
    `ALTER TABLE api_tokens ADD CONSTRAINT ?? CHECK (
      "kind" IN ('personal', 'service') AND (("kind" = 'personal') = ("ownerUserId" IS NOT NULL))
    )`,
    [KIND_CONSISTENCY_CHECK]
  );

  await knex.schema.createTable('auth_audit_events', (table) => {
    table.increments('id').primary();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now()).index();
    table.string('event').notNullable();
    table.string('principalKind', 32).notNullable();
    table.string('principalId').nullable();
    /* Acting identity (admin sub, owner sub, or system marker) — distinct from the credential's principal. */
    table.string('actorId').nullable().index();
    table.integer('tokenId').nullable().index();
    table.string('requestId').nullable();
    table.string('route').nullable();
    table.string('outcome', 32).notNullable();
    table.jsonb('meta').nullable();
  });

  const duplicateUuids = await knex('builds')
    .select('uuid')
    .whereNull('deletedAt')
    .whereNotNull('uuid')
    .groupBy('uuid')
    .havingRaw('count(*) > 1');
  if (duplicateUuids.length > 0) {
    throw new Error(
      `builds.uuid has duplicate live values (${duplicateUuids
        .map((r: { uuid: string }) => r.uuid)
        .join(', ')}); resolve them before adding the unique index`
    );
  }

  await knex.schema.alterTable('builds', (table) => {
    table.string('triggerType', 16).notNullable().defaultTo('github_pr');
    table.bigInteger('githubRepositoryId').nullable();
    table.string('branchName').nullable();
    table.string('configSha').nullable();
    table.boolean('deployEnabled').nullable();
    table.timestamp('expiresAt').nullable();
    table.string('idempotencyKey').nullable();
    table.string('idempotencyRequestDigest', 64).nullable();
    table.integer('createdByTokenId').nullable();
    table.boolean('autoTrack').notNullable().defaultTo(false);
    table.string('createdByUserId').nullable();
    table.string('createdByGithubLogin').nullable();
  });

  await knex.raw(`
    create unique index builds_uuid_live_unique
    on builds ("uuid")
    where "deletedAt" is null
  `);
  await knex.raw(`
    create unique index builds_idempotency_key_live_unique
    on builds ("idempotencyKey")
    where "idempotencyKey" is not null and "deletedAt" is null
  `);
  for (const { name, definition } of BUILDS_INDEXES) {
    await knex.raw(`create index if not exists ?? ${definition}`, [name]);
  }

  const existing = await knex('global_config').where('key', 'api_environments').first();
  if (!existing) {
    await knex('global_config').insert({
      key: 'api_environments',
      config: { enabled: false, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 },
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: API_ENVIRONMENTS_DESCRIPTION,
    });
  }

  const apiKeysExisting = await knex('global_config').where('key', 'api_keys').first();
  if (!apiKeysExisting) {
    const apiEnvironmentsEnabled = existing?.config?.enabled === true;
    await knex('global_config').insert({
      key: 'api_keys',
      config: {
        issuanceEnabled: apiEnvironmentsEnabled,
        personalAuthEnabled: apiEnvironmentsEnabled,
        serviceAuthEnabled: apiEnvironmentsEnabled,
        rateLimitPerMinute: 600,
        maxActivePersonalKeysPerUser: 10,
      },
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: API_KEYS_DESCRIPTION,
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const { name } of BUILDS_INDEXES) {
    await knex.raw(`drop index if exists ??`, [name]);
  }
  await knex.raw('drop index if exists builds_idempotency_key_live_unique');
  await knex.raw('drop index if exists builds_uuid_live_unique');

  const hasBuildsTable = await knex.schema.hasTable('builds');
  if (hasBuildsTable) {
    await knex.schema.alterTable('builds', (table) => {
      table.dropColumn('triggerType');
      table.dropColumn('githubRepositoryId');
      table.dropColumn('branchName');
      table.dropColumn('configSha');
      table.dropColumn('deployEnabled');
      table.dropColumn('expiresAt');
      table.dropColumn('idempotencyKey');
      table.dropColumn('idempotencyRequestDigest');
      table.dropColumn('createdByTokenId');
      table.dropColumn('autoTrack');
      table.dropColumn('createdByUserId');
      table.dropColumn('createdByGithubLogin');
    });
  }

  await knex.schema.dropTableIfExists('auth_audit_events');
  await knex.schema.dropTableIfExists('api_tokens');

  await knex('global_config').where({ key: 'api_keys', description: API_KEYS_DESCRIPTION }).delete();
  await knex('global_config').where({ key: 'api_environments', description: API_ENVIRONMENTS_DESCRIPTION }).delete();
}
