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

export const aiAgentConfigSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    providers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          apiKeyEnvVar: { type: 'string' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                displayName: { type: 'string' },
                enabled: { type: 'boolean' },
                default: { type: 'boolean' },
                maxTokens: { type: 'integer', minimum: 1 },
                inputCostPerMillion: { type: 'number', minimum: 0 },
                outputCostPerMillion: { type: 'number', minimum: 0 },
              },
              required: ['id', 'displayName', 'enabled', 'default', 'maxTokens'],
            },
          },
        },
        required: ['name', 'enabled', 'apiKeyEnvVar', 'models'],
      },
    },
    maxMessagesPerSession: { type: 'integer', minimum: 1 },
    sessionTTL: { type: 'integer', minimum: 1 },
    additiveRules: { type: 'array', items: { type: 'string' } },
    systemPromptOverride: { type: 'string', maxLength: 50000 },
    excludedTools: { type: 'array', items: { type: 'string' } },
    excludedFilePatterns: { type: 'array', items: { type: 'string' } },
  },
  required: ['enabled', 'providers', 'maxMessagesPerSession', 'sessionTTL'],
  additionalProperties: false,
};

export const aiAgentRepoOverrideSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    maxMessagesPerSession: { type: 'integer', minimum: 1 },
    sessionTTL: { type: 'integer', minimum: 1 },
    additiveRules: { type: 'array', items: { type: 'string' } },
    systemPromptOverride: { type: 'string', maxLength: 50000 },
    excludedTools: { type: 'array', items: { type: 'string' } },
    excludedFilePatterns: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};
