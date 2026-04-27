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

async function dropColumnIfExists(knex: Knex, tableName: string, columnName: string): Promise<void> {
  const exists = await knex.schema.hasColumn(tableName, columnName);

  if (!exists) {
    return;
  }

  await knex.schema.alterTable(tableName, (table) => {
    table.dropColumn(columnName);
  });
}

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

export async function up(knex: Knex): Promise<void> {
  await dropColumnIfExists(knex, 'services', 'scaleToZero');
  await dropColumnIfExists(knex, 'services', 'scaleToZeroMetricsCheckInterval');
  await dropColumnIfExists(knex, 'deployables', 'scaleToZero');
  await dropColumnIfExists(knex, 'deployables', 'scaleToZeroMetricsCheckInterval');
  await dropColumnIfExists(knex, 'deployables', 'kedaScaleToZero');
  await dropColumnIfExists(knex, 'deploys', 'kedaScaleToZero');

  await knex.raw(`
    DELETE FROM global_config
    WHERE key = 'kedaScaleToZero';
  `);

  await knex.raw(`
    UPDATE global_config
    SET config = (config::jsonb - 'scaleToZero' - 'scaleToZeroMetricsCheckInterval')::json,
        "updatedAt" = now()
    WHERE key = 'serviceDefaults';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await addColumnIfMissing(knex, 'services', 'scaleToZero', (table) => {
    table.boolean('scaleToZero').defaultTo(false);
  });
  await addColumnIfMissing(knex, 'services', 'scaleToZeroMetricsCheckInterval', (table) => {
    table.integer('scaleToZeroMetricsCheckInterval').defaultTo(1800);
  });
  await addColumnIfMissing(knex, 'deployables', 'scaleToZero', (table) => {
    table.boolean('scaleToZero').defaultTo(false);
  });
  await addColumnIfMissing(knex, 'deployables', 'scaleToZeroMetricsCheckInterval', (table) => {
    table.integer('scaleToZeroMetricsCheckInterval').defaultTo(1800);
  });
  await addColumnIfMissing(knex, 'deployables', 'kedaScaleToZero', (table) => {
    table.json('kedaScaleToZero').defaultTo('{}');
  });
  await addColumnIfMissing(knex, 'deploys', 'kedaScaleToZero', (table) => {
    table.json('kedaScaleToZero').defaultTo('{}');
  });

  await knex.raw(`
    INSERT INTO global_config (key, config, "createdAt", "updatedAt", "deletedAt", description)
    VALUES (
      'kedaScaleToZero',
      '{"enabled":false,"type":"http","replicas":{"min":1,"max":3},"scaledownPeriod":10800,"maxRetries":10,"scalingMetric":{"requestRate":{"granularity":"1m","targetValue":30,"window":"1m"},"concurrency":{"targetValue":100}}}',
      now(),
      now(),
      null,
      'This is the default configuration for Keda Scale To Zero'
    )
    ON CONFLICT (key) DO UPDATE
    SET config = EXCLUDED.config,
        "updatedAt" = now(),
        "deletedAt" = null,
        description = EXCLUDED.description;
  `);

  await knex.raw(`
    UPDATE global_config
    SET config = (
      config::jsonb ||
      '{"scaleToZero":false,"scaleToZeroMetricsCheckInterval":1800}'::jsonb
    )::json,
        "updatedAt" = now()
    WHERE key = 'serviceDefaults';
  `);
}
