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
  const existingConfig = await knex('global_config').where('key', 'aiDebug').first();

  if (!existingConfig) {
    await knex('global_config').insert({
      key: 'aiDebug',
      config: {
        enabled: false,
        provider: 'gemini',
        maxMessagesPerSession: 50,
        sessionTTL: 3600,
      },
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description:
        'AI-powered debugging configuration. Set enabled to true and configure ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.',
    });
  }
}

export async function down(knex: Knex): Promise<any> {
  await knex('global_config').where('key', 'aiDebug').delete();
}
