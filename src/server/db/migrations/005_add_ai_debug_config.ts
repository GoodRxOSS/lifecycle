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
  const existingConfig = await knex('global_config').where('key', 'aiAgent').first();

  if (!existingConfig) {
    await knex('global_config').insert({
      key: 'aiAgent',
      config: {
        enabled: false,
        providers: [
          {
            name: 'gemini',
            enabled: true,
            apiKeyEnvVar: 'GEMINI_API_KEY',
            models: [
              {
                id: 'gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                enabled: true,
                default: false,
                maxTokens: 1000000,
              },
              {
                id: 'gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                enabled: true,
                default: true,
                maxTokens: 1000000,
              },
              {
                id: 'gemini-2.5-flash-lite',
                displayName: 'Gemini 2.5 Flash Lite',
                enabled: true,
                default: false,
                maxTokens: 1000000,
              },
            ],
          },
          {
            name: 'anthropic',
            enabled: false,
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
            models: [
              {
                id: 'claude-sonnet-4-5-20250929',
                displayName: 'Claude Sonnet 4.5',
                enabled: true,
                default: true,
                maxTokens: 200000,
              },
            ],
          },
          {
            name: 'openai',
            enabled: false,
            apiKeyEnvVar: 'OPENAI_API_KEY',
            models: [
              {
                id: 'gpt-4o',
                displayName: 'GPT-4o',
                enabled: true,
                default: true,
                maxTokens: 128000,
              },
            ],
          },
        ],
        maxMessagesPerSession: 50,
        sessionTTL: 3600,
      },
      createdAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
      deletedAt: null,
      description:
        'AI-powered agent configuration with multi-model support. Set enabled to true and configure the appropriate API key environment variable for each provider (GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY).',
    });
  }
}

export async function down(knex: Knex): Promise<any> {
  await knex('global_config').where('key', 'aiAgent').delete();
}
