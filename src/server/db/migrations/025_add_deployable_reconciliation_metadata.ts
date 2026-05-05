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

async function addColumnIfMissing(
  knex: Knex,
  tableName: string,
  columnName: string,
  addColumn: (table: Knex.AlterTableBuilder) => void
): Promise<void> {
  const exists = await knex.schema.hasColumn(tableName, columnName);

  if (exists) {
    return;
  }

  await knex.schema.alterTable(tableName, addColumn);
}

async function dropColumnIfExists(knex: Knex, tableName: string, columnName: string): Promise<void> {
  const exists = await knex.schema.hasColumn(tableName, columnName);

  if (!exists) {
    return;
  }

  await knex.schema.alterTable(tableName, (table) => {
    table.dropColumn(columnName);
  });
}

export async function up(knex: Knex): Promise<void> {
  await addColumnIfMissing(knex, 'deployables', 'source', (table) => {
    table.string('source').defaultTo('db');
  });
  await addColumnIfMissing(knex, 'deployables', 'reconcileEligible', (table) => {
    table.boolean('reconcileEligible').defaultTo(false);
  });
  await addColumnIfMissing(knex, 'deployables', 'resolvedFromRepositoryId', (table) => {
    table.integer('resolvedFromRepositoryId').nullable();
  });

  await knex.raw(`
    UPDATE deployables
    SET
      source = CASE
        WHEN "serviceId" IS NULL THEN 'yaml'
        ELSE COALESCE(source, 'db')
      END,
      "reconcileEligible" = CASE
        WHEN "serviceId" IS NULL AND type <> 'configuration' THEN true
        ELSE false
      END,
      "resolvedFromRepositoryId" = CASE
        WHEN "repositoryId" ~ '^[0-9]+$' THEN "repositoryId"::integer
        ELSE NULL
      END
    WHERE source IS NULL
       OR "reconcileEligible" IS NULL
       OR "resolvedFromRepositoryId" IS NULL;
  `);

  await knex.raw(`
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description)
    VALUES (
      'features',
      '{"reconcileDeletedServices":false}',
      now(),
      now(),
      null,
      'Configuration for feature flags controlled from database'
    )
    ON CONFLICT (key) DO UPDATE
    SET config = (
          COALESCE(global_config.config, '{}'::json)::jsonb ||
          CASE
            WHEN jsonb_exists(global_config.config::jsonb, 'reconcileDeletedServices') THEN '{}'::jsonb
            ELSE '{"reconcileDeletedServices":false}'::jsonb
          END
        )::json,
        "updatedAt" = now(),
        "deletedAt" = null;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE global_config
    SET config = (config::jsonb - 'reconcileDeletedServices')::json,
        "updatedAt" = now()
    WHERE key = 'features';
  `);

  await dropColumnIfExists(knex, 'deployables', 'resolvedFromRepositoryId');
  await dropColumnIfExists(knex, 'deployables', 'reconcileEligible');
  await dropColumnIfExists(knex, 'deployables', 'source');
}
