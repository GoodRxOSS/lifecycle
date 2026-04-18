/**
 * Copyright 2026 GoodRx, Inc.
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

const toolRuleSchema = {
  type: 'object',
  properties: {
    toolKey: { type: 'string', minLength: 1, maxLength: 255 },
    mode: { type: 'string', enum: ['allow', 'require_approval', 'deny'] },
  },
  required: ['toolKey', 'mode'],
  additionalProperties: false,
};

const positiveIntegerSchema = {
  type: 'integer',
  minimum: 1,
};

const nonNegativeIntegerSchema = {
  type: 'integer',
  minimum: 0,
};

const stringRecordSchema = {
  type: 'object',
  propertyNames: {
    minLength: 1,
  },
  additionalProperties: {
    type: 'string',
    minLength: 1,
  },
};

const resourceRequirementsSchema = {
  type: 'object',
  properties: {
    requests: stringRecordSchema,
    limits: stringRecordSchema,
  },
  additionalProperties: false,
};

export const agentSessionControlPlaneConfigSchema = {
  type: 'object',
  properties: {
    systemPrompt: { type: 'string', maxLength: 50000 },
    appendSystemPrompt: { type: 'string', maxLength: 50000 },
    maxIterations: positiveIntegerSchema,
    workspaceToolDiscoveryTimeoutMs: positiveIntegerSchema,
    workspaceToolExecutionTimeoutMs: positiveIntegerSchema,
    toolRules: {
      type: 'array',
      items: toolRuleSchema,
    },
  },
  additionalProperties: false,
};

export const agentSessionRuntimeSettingsSchema = {
  type: 'object',
  properties: {
    workspaceImage: { type: 'string', minLength: 1, maxLength: 2048 },
    workspaceEditorImage: { type: 'string', minLength: 1, maxLength: 2048 },
    workspaceGatewayImage: { type: 'string', minLength: 1, maxLength: 2048 },
    scheduling: {
      type: 'object',
      properties: {
        nodeSelector: stringRecordSchema,
        keepAttachedServicesOnSessionNode: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    readiness: {
      type: 'object',
      properties: {
        timeoutMs: nonNegativeIntegerSchema,
        pollMs: nonNegativeIntegerSchema,
      },
      additionalProperties: false,
    },
    resources: {
      type: 'object',
      properties: {
        workspace: resourceRequirementsSchema,
        editor: resourceRequirementsSchema,
        workspaceGateway: resourceRequirementsSchema,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
