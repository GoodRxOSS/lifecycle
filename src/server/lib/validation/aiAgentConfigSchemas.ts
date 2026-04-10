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

const approvalModeSchema = { type: 'string', enum: ['allow', 'require_approval', 'deny'] };

const approvalPolicyRulesSchema = {
  type: 'object',
  properties: {
    read: approvalModeSchema,
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

export const aiAgentConfigSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    approvalPolicy: approvalPolicySchema,
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
    additiveRules: { type: 'array', items: { type: 'string' } },
    systemPromptOverride: { type: 'string', maxLength: 50000 },
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

export const aiAgentRepoOverrideSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    maxMessagesPerSession: { type: 'integer', minimum: 1 },
    sessionTTL: { type: 'integer', minimum: 1 },
    approvalPolicy: approvalPolicySchema,
    additiveRules: { type: 'array', items: { type: 'string' } },
    systemPromptOverride: { type: 'string', maxLength: 50000 },
    excludedTools: { type: 'array', items: { type: 'string' } },
    excludedFilePatterns: { type: 'array', items: { type: 'string' } },
    allowedWritePatterns: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const aiAgentAdditiveRulesUpdateSchema = {
  type: 'object',
  properties: {
    additiveRules: { type: 'array', items: { type: 'string' } },
  },
  required: ['additiveRules'],
  additionalProperties: false,
};

export const aiAgentApprovalPolicyUpdateSchema = {
  type: 'object',
  properties: {
    approvalPolicy: approvalPolicySchema,
  },
  required: ['approvalPolicy'],
  additionalProperties: false,
};

export const aiAgentConfigPatchSchema = {
  type: 'object',
  properties: {
    additiveRules: { type: 'array', items: { type: 'string' } },
    approvalPolicy: approvalPolicySchema,
  },
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
};
