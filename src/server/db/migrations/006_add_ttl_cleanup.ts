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
  const existingLabels = await knex('global_config').where('key', 'labels').first();

  const defaultLabelsConfig = {
    deploy: ['lifecycle-deploy!'],
    disabled: ['lifecycle-disabled!'],
    keep: ['lifecycle-keep!'],
    statusComments: ['lifecycle-status-comments!'],
    defaultStatusComments: true,
    defaultControlComments: true,
  };

  if (existingLabels) {
    const mergedConfig = { ...defaultLabelsConfig, ...existingLabels.config };

    await knex('global_config').where('key', 'labels').update({
      config: mergedConfig,
      updatedAt: knex.fn.now(),
    });
  } else {
    await knex('global_config').insert({
      key: 'labels',
      config: defaultLabelsConfig,
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: 'Configurable PR labels for deploy, disabled, keep, and status comments',
    });
  }

  await knex('global_config').insert({
    key: 'ttl_cleanup',
    config: {
      enabled: false,
      dryRun: true,
      inactivityDays: 14,
      checkIntervalMinutes: 240,
      commentTemplate:
        'This environment has been inactive for {inactivityDays} days and will be automatically cleaned up. Add the {keepLabel} label to prevent cleanup.',
      excludedRepositories: [],
    },
    createdAt: knex.fn.now(),
    updatedAt: knex.fn.now(),
    deletedAt: null,
    description:
      'TTL-based automatic cleanup configuration for inactive PR environments. Set enabled to true to activate cleanup (starts in dryRun mode). Environments with the keep label are excluded.',
  });
}

export async function down(knex: Knex): Promise<any> {
  const existingLabels = await knex('global_config').where('key', 'labels').first();

  if (existingLabels && existingLabels.config?.keep) {
    const { keep: _keep, ...restConfig } = existingLabels.config;

    await knex('global_config').where('key', 'labels').update({
      config: restConfig,
      updatedAt: knex.fn.now(),
    });
  }

  await knex('global_config').where('key', 'ttl_cleanup').delete();
}
