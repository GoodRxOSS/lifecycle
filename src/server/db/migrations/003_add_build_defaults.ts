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

export async function up(knex: Knex): Promise<any> {
  const IS_DEV = process.env.APP_ENV === 'dev';
  const cacheRegistry = IS_DEV ? '10.96.188.230:5000' : 'distribution.0env.com';

  const existingConfig = await knex('global_config').where('key', 'buildDefaults').first();

  if (!existingConfig) {
    // Create new buildDefaults with cacheRegistry
    await knex('global_config').insert({
      key: 'buildDefaults',
      config: JSON.stringify({
        cacheRegistry,
      }),
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: 'Default configuration for native builds including cache registry.',
    });
  } else {
    // Update existing buildDefaults to add cacheRegistry if not present
    const config = JSON.parse(existingConfig.config);

    if (!config.cacheRegistry) {
      config.cacheRegistry = cacheRegistry;

      await knex('global_config')
        .where('key', 'buildDefaults')
        .update({
          config: JSON.stringify(config),
          updatedAt: knex.fn.now(),
        });
    }
  }
}

export async function down(knex: Knex): Promise<any> {
  const existingConfig = await knex('global_config').where('key', 'buildDefaults').first();

  if (existingConfig) {
    const config = JSON.parse(existingConfig.config);

    // If buildDefaults only has cacheRegistry, delete the entire record
    if (Object.keys(config).length === 1 && config.cacheRegistry) {
      await knex('global_config').where('key', 'buildDefaults').delete();
    } else if (config.cacheRegistry) {
      // Otherwise just remove the cacheRegistry field
      delete config.cacheRegistry;

      await knex('global_config')
        .where('key', 'buildDefaults')
        .update({
          config: JSON.stringify(config),
          updatedAt: knex.fn.now(),
        });
    }
  }
}
