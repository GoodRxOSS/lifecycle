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

const openSandboxBackendSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string', minLength: 1, maxLength: 2048 },
    protocol: { type: 'string', enum: ['http', 'https'] },
    apiKey: { type: 'string', minLength: 1, maxLength: 4096 },
    // Read-side presence flag echoed back by clients; ignored on write.
    apiKeyConfigured: { type: 'boolean' },
    image: { type: 'string', minLength: 1, maxLength: 2048 },
    poolRef: { type: 'string', minLength: 1, maxLength: 253 },
    timeoutSeconds: {
      anyOf: [positiveIntegerSchema, { type: 'null' }],
    },
    useServerProxy: { type: 'boolean' },
    secureAccess: { type: 'boolean' },
    resourceLimits: stringRecordSchema,
    execdPort: positiveIntegerSchema,
    gatewayPort: positiveIntegerSchema,
    editorPort: positiveIntegerSchema,
  },
  additionalProperties: false,
};

const e2bBackendSchema = {
  type: 'object',
  properties: {
    apiKey: { type: 'string', minLength: 1, maxLength: 4096 },
    // Read-side presence flag echoed back by clients; ignored on write.
    apiKeyConfigured: { type: 'boolean' },
    templateId: { type: 'string', minLength: 1, maxLength: 253 },
    domain: { type: 'string', minLength: 1, maxLength: 2048 },
    timeoutSeconds: {
      anyOf: [positiveIntegerSchema, { type: 'null' }],
    },
    autoPause: { type: 'boolean' },
  },
  additionalProperties: false,
};

const daytonaBackendSchema = {
  type: 'object',
  properties: {
    apiKey: { type: 'string', minLength: 1, maxLength: 4096 },
    // Read-side presence flag echoed back by clients; ignored on write.
    apiKeyConfigured: { type: 'boolean' },
    snapshot: { type: 'string', minLength: 1, maxLength: 253 },
    apiUrl: { type: 'string', minLength: 1, maxLength: 2048 },
    target: { type: 'string', minLength: 1, maxLength: 253 },
    autoArchiveInterval: nonNegativeIntegerSchema,
  },
  additionalProperties: false,
};

const modalBackendSchema = {
  type: 'object',
  properties: {
    tokenId: { type: 'string', minLength: 1, maxLength: 4096 },
    // Read-side presence flags echoed back by clients; ignored on write.
    tokenIdConfigured: { type: 'boolean' },
    tokenSecret: { type: 'string', minLength: 1, maxLength: 4096 },
    tokenSecretConfigured: { type: 'boolean' },
    environment: { type: 'string', minLength: 1, maxLength: 253 },
    appName: { type: 'string', minLength: 1, maxLength: 253 },
    image: { type: 'string', minLength: 1, maxLength: 2048 },
    imageRegistrySecret: { type: 'string', minLength: 1, maxLength: 253 },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
    cpu: { type: 'number', exclusiveMinimum: 0 },
    memoryMiB: { type: 'integer', minimum: 1 },
    inboundCidrAllowlist: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 64 },
      uniqueItems: true,
    },
  },
  additionalProperties: false,
};

const workspaceStorageSizeSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
};

export const agentSessionControlPlaneConfigSchema = {
  type: 'object',
  properties: {
    systemPrompt: { type: 'string', maxLength: 50000 },
    appendSystemPrompt: { type: 'string', maxLength: 50000 },
    maxIterations: positiveIntegerSchema,
    maxRunInputTokens: positiveIntegerSchema,
    workspaceToolDiscoveryTimeoutMs: positiveIntegerSchema,
    workspaceToolExecutionTimeoutMs: positiveIntegerSchema,
    autoProvisionWorkspace: { type: 'boolean' },
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
    workspaceStorage: {
      type: 'object',
      properties: {
        defaultSize: workspaceStorageSizeSchema,
        allowedSizes: {
          type: 'array',
          items: workspaceStorageSizeSchema,
          uniqueItems: true,
        },
        allowClientOverride: { type: 'boolean' },
        accessMode: { type: 'string', enum: ['ReadWriteOnce', 'ReadWriteMany'] },
      },
      additionalProperties: false,
    },
    workspaceBackend: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['lifecycle_kubernetes', 'opensandbox', 'e2b', 'daytona', 'modal'] },
        // null is the explicit remove-stored-block sentinel; omitted blocks are preserved.
        opensandbox: { anyOf: [openSandboxBackendSchema, { type: 'null' }] },
        e2b: { anyOf: [e2bBackendSchema, { type: 'null' }] },
        daytona: { anyOf: [daytonaBackendSchema, { type: 'null' }] },
        modal: { anyOf: [modalBackendSchema, { type: 'null' }] },
      },
      additionalProperties: false,
    },
    cleanup: {
      type: 'object',
      properties: {
        activeIdleSuspendMs: positiveIntegerSchema,
        startingTimeoutMs: positiveIntegerSchema,
        hibernatedRetentionMs: positiveIntegerSchema,
        idleArchiveMs: positiveIntegerSchema,
        intervalMs: positiveIntegerSchema,
        redisTtlSeconds: positiveIntegerSchema,
      },
      additionalProperties: false,
    },
    durability: {
      type: 'object',
      properties: {
        runExecutionLeaseMs: positiveIntegerSchema,
        queuedRunDispatchStaleMs: positiveIntegerSchema,
        dispatchRecoveryLimit: positiveIntegerSchema,
        maxDurablePayloadBytes: positiveIntegerSchema,
        payloadPreviewBytes: positiveIntegerSchema,
        fileChangePreviewChars: positiveIntegerSchema,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
