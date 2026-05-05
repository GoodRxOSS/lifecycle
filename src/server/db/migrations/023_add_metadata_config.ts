/**
 * Copyright 2026 Lifecycle contributors
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

const DEFAULT_METADATA = {
  links: [
    {
      id: 'example-container-metrics',
      text: 'Container metrics',
      icon: 'Container',
      link: 'https://example.com/metrics/containers?build={{{buildUUID}}}',
      position: 0,
    },
    {
      id: 'example-application-traces',
      text: 'Application traces',
      icon: 'Route',
      link: 'https://example.com/traces?namespace={{namespace}}',
      position: 1,
    },
    {
      id: 'example-environment-logs',
      text: 'Environment logs',
      icon: 'FileCog',
      link: 'https://example.com/logs?build={{{buildUUID}}}',
      position: 2,
    },
  ],
};

export async function up(knex: Knex): Promise<void> {
  await knex('global_config')
    .insert({
      key: 'metadata',
      config: DEFAULT_METADATA,
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description: 'Build metadata configuration.',
    })
    .onConflict('key')
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('global_config').where({ key: 'metadata' }).delete();
}
