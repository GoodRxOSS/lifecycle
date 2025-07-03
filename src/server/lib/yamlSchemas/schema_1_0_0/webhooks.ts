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

const dockerWebhookConfig = {
  type: 'object',
  additionalProperties: false,
  properties: {
    image: { type: 'string' },
    command: {
      type: 'array',
      items: { type: 'string' },
    },
    args: {
      type: 'array',
      items: { type: 'string' },
    },
    timeout: { type: 'number' },
  },
  required: ['image'],
};

const commandWebhookConfig = {
  type: 'object',
  additionalProperties: false,
  properties: {
    image: { type: 'string' },
    script: { type: 'string' },
    timeout: { type: 'number' },
  },
  required: ['image', 'script'],
};

const webhooks = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      state: { type: 'string', format: 'webhookState' },
      type: { type: 'string', format: 'webhookType' },

      // Codefresh-specific fields (optional for new types)
      pipelineId: { type: 'string' },
      trigger: { type: 'string' },

      // Docker webhook configuration
      docker: dockerWebhookConfig,

      // Command webhook configuration
      command: commandWebhookConfig,

      // Environment variables (required for all types)
      env: { type: 'object' },
    },
    required: ['state', 'type', 'env'],
  },
};

export { webhooks };
