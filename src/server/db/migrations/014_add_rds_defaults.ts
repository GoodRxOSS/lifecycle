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

const defaultConfig = {
  aurora: {
    image: 'lifecycleoss/rds:latest',
    vpcId: '',
    accountId: '',
    region: 'us-west-2',
    securityGroupIds: [],
    subnetGroupName: '',
    engine: 'aurora-mysql',
    engineVersion: '8.0.mysql_aurora.3.06.0',
    sourceTag: {
      key: 'restore-for',
    },
    additionalTags: {},
    instanceSize: 'db.t3.medium',
    restoreSize: 'db.t3.small',
    jobTimeout: 5400,
  },
  rds: {
    image: 'lifecycleoss/rds:latest',
    vpcId: '',
    accountId: '',
    region: 'us-west-2',
    securityGroupIds: [],
    subnetGroupName: '',
    engine: 'mysql',
    engineVersion: '8.0.33',
    sourceTag: {
      key: 'restore-for',
    },
    additionalTags: {},
    instanceSize: 'db.t3.small',
    restoreSize: 'db.t3.small',
    jobTimeout: 5400,
  },
};

export async function up(knex: Knex): Promise<void> {
  const existingConfig = await knex('global_config').where('key', 'rdsDefaults').first();
  if (!existingConfig) {
    await knex('global_config').insert({
      key: 'rdsDefaults',
      config: defaultConfig,
      description: 'Default configuration for build-stage RDS restore jobs.',
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('global_config').where('key', 'rdsDefaults').del();
}
