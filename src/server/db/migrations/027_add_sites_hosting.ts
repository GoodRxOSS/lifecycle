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

const SITES_TABLE = 'sites';
const SITE_VERSIONS_TABLE = 'site_versions';
const SITES_CONFIG_KEY = 'sites';

const DEFAULT_SITES_CONFIG = {
  enabled: false,
  domain: 'localhost',
  port: null,
  hostPrefix: 'site',
  ttl: {
    enabled: true,
    defaultDays: 7,
    extensionDays: 7,
  },
  upload: {
    maxUploadBytes: 10 * 1024 * 1024,
    maxExtractedBytes: 10 * 1024 * 1024,
    maxFiles: 500,
    allowedExtensions: [
      'html',
      'zip',
      'json',
      'md',
      'markdown',
      'txt',
      'css',
      'js',
      'mjs',
      'map',
      'csv',
      'xml',
      'svg',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'avif',
      'ico',
      'webmanifest',
      'wasm',
      'woff',
      'woff2',
      'ttf',
      'otf',
      'pdf',
    ],
  },
  storage: {
    backend: 'minio',
    bucket: 'lifecycle-sites',
    prefix: 'sites',
    region: 'us-west-2',
    endpoint: null,
    forcePathStyle: true,
  },
  cleanup: {
    enabled: true,
    intervalMinutes: 15,
  },
};

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(SITES_TABLE, (table) => {
    table.increments('id').primary();
    table.string('siteId', 32).notNullable();
    table.string('name', 255).notNullable();
    table.string('status', 32).notNullable().defaultTo('active');
    table.string('activeVersionId', 32).nullable();
    table.integer('fileCount').notNullable().defaultTo(0);
    table.bigInteger('sizeBytes').notNullable().defaultTo(0);
    table.timestamp('expiresAt').nullable();
    table.string('createdBy', 255).nullable();
    table.string('updatedBy', 255).nullable();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deletedAt').nullable();

    table.unique(['siteId']);
    table.index(['status', 'expiresAt']);
    table.index(['deletedAt']);
  });

  await knex.schema.createTable(SITE_VERSIONS_TABLE, (table) => {
    table.increments('id').primary();
    table.string('siteId', 32).notNullable();
    table.string('versionId', 32).notNullable();
    table.string('storagePrefix', 512).notNullable();
    table.string('entrypoint', 255).notNullable().defaultTo('index.html');
    table.integer('fileCount').notNullable();
    table.bigInteger('sizeBytes').notNullable();
    table.jsonb('manifest').notNullable().defaultTo('[]');
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deletedAt').nullable();

    table.unique(['siteId', 'versionId']);
    table.index(['siteId']);
    table.foreign('siteId').references('siteId').inTable(SITES_TABLE).onDelete('CASCADE');
  });

  const existingConfig = await knex('global_config').where('key', SITES_CONFIG_KEY).first();
  if (!existingConfig) {
    await knex('global_config').insert({
      key: SITES_CONFIG_KEY,
      config: DEFAULT_SITES_CONFIG,
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: 'Sites hosting configuration for uploaded static files and ZIP sites.',
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('global_config').where('key', SITES_CONFIG_KEY).delete();
  await knex.schema.dropTableIfExists(SITE_VERSIONS_TABLE);
  await knex.schema.dropTableIfExists(SITES_TABLE);
}
