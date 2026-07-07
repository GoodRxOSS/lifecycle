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

import { AGENT_CAPABILITY_AVAILABILITIES, AGENT_CAPABILITY_CATALOG_IDS } from 'server/services/agent/capabilityCatalog';

const approvalModeSchema = { type: 'string', enum: ['allow', 'require_approval', 'deny'] };
const customAgentCreationModeSchema = { type: 'string', enum: ['enabled', 'disabled', 'admins_only', 'allowlist'] };
const creatorCapabilityAvailabilitySchema = { type: 'string', enum: ['available', 'reserved'] };

export const capabilityPolicySchema = {
  type: 'object',
  properties: {
    availability: {
      type: 'object',
      properties: Object.fromEntries(
        AGENT_CAPABILITY_CATALOG_IDS.map((capabilityId) => [
          capabilityId,
          {
            type: 'string',
            enum: [...AGENT_CAPABILITY_AVAILABILITIES],
          },
        ])
      ),
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const customAgentCreationPolicySchema = {
  type: 'object',
  properties: {
    mode: customAgentCreationModeSchema,
    allowedUserIds: {
      type: 'array',
      items: { type: 'string' },
    },
    allowedGithubUsernames: {
      type: 'array',
      items: { type: 'string' },
    },
    capabilityAvailability: {
      type: 'object',
      properties: Object.fromEntries(
        AGENT_CAPABILITY_CATALOG_IDS.map((capabilityId) => [capabilityId, creatorCapabilityAvailabilitySchema])
      ),
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const approvalPolicyRulesSchema = {
  type: 'object',
  properties: {
    read: approvalModeSchema,
    external_mcp_read: approvalModeSchema,
    workspace_write: approvalModeSchema,
    shell_exec: approvalModeSchema,
    git_write: approvalModeSchema,
    network_access: approvalModeSchema,
    deploy_k8s_mutation: approvalModeSchema,
    external_mcp_write: approvalModeSchema,
  },
  additionalProperties: false,
};

const approvalPolicySchema = {
  type: 'object',
  properties: {
    defaultMode: approvalModeSchema,
    rules: approvalPolicyRulesSchema,
  },
  additionalProperties: false,
};

export const agentRuntimeConfigSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    approvalPolicy: approvalPolicySchema,
    capabilityPolicy: capabilityPolicySchema,
    customAgentCreationPolicy: customAgentCreationPolicySchema,
    providers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          apiKeyEnvVar: { type: 'string', minLength: 1, pattern: '^[A-Z_][A-Z0-9_]*$' },
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
    excludedTools: { type: 'array', items: { type: 'string' } },
    excludedFilePatterns: { type: 'array', items: { type: 'string' } },
    allowedWritePatterns: { type: 'array', items: { type: 'string' } },
    maxIterations: { type: 'integer', minimum: 1 },
    maxToolCalls: { type: 'integer', minimum: 1 },
    maxRepeatedCalls: { type: 'integer', minimum: 1 },
    compressionThreshold: { type: 'integer', minimum: 1 },
    observationMaskingRecencyWindow: { type: 'integer', minimum: 1 },
    observationMaskingTokenThreshold: { type: 'integer', minimum: 1 },
    toolExecutionTimeout: { type: 'integer', minimum: 1000 },
    toolOutputMaxChars: { type: 'integer', minimum: 1000 },
    retryBudget: { type: 'integer', minimum: 1 },
  },
  required: ['enabled', 'providers', 'maxMessagesPerSession', 'sessionTTL'],
  additionalProperties: false,
};

export const agentRuntimeRepoOverrideSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    maxMessagesPerSession: { type: 'integer', minimum: 1 },
    sessionTTL: { type: 'integer', minimum: 1 },
    approvalPolicy: approvalPolicySchema,
    capabilityPolicy: capabilityPolicySchema,
    excludedTools: { type: 'array', items: { type: 'string' } },
    excludedFilePatterns: { type: 'array', items: { type: 'string' } },
    allowedWritePatterns: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const agentRuntimeApprovalPolicyUpdateSchema = {
  type: 'object',
  properties: {
    approvalPolicy: approvalPolicySchema,
  },
  required: ['approvalPolicy'],
  additionalProperties: false,
};

export const agentRuntimeConfigPatchSchema = {
  type: 'object',
  properties: {
    approvalPolicy: approvalPolicySchema,
  },
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
};
