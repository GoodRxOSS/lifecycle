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

import type {
  AgentSessionControlPlaneConfigValue,
  AgentSessionRuntimeSettingsValue,
} from 'server/services/types/agentSessionConfig';
import {
  AgentSessionConfigValidationError,
  validateAgentSessionControlPlaneConfig,
  validateAgentSessionRuntimeSettings,
} from '../agentSessionConfigValidator';

function controlPlaneValidator(config: unknown): () => void {
  return () => validateAgentSessionControlPlaneConfig(config as Partial<AgentSessionControlPlaneConfigValue>);
}

function runtimeValidator(config: unknown): () => void {
  return () => validateAgentSessionRuntimeSettings(config as AgentSessionRuntimeSettingsValue);
}

function expectValidationError(validate: () => void, message: string): void {
  let caught: unknown;
  try {
    validate();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AgentSessionConfigValidationError);
  expect(caught).toMatchObject({ message });
}

describe('validateAgentSessionControlPlaneConfig', () => {
  it('accepts omitted fields and documented boundary values', () => {
    const config: AgentSessionControlPlaneConfigValue = {
      systemPrompt: 'x'.repeat(50_000),
      appendSystemPrompt: '',
      maxIterations: 1,
      maxRunInputTokens: Number.MAX_SAFE_INTEGER,
      workspaceToolDiscoveryTimeoutMs: 1,
      workspaceToolExecutionTimeoutMs: 1,
      autoProvisionWorkspace: false,
      toolRules: [
        { toolKey: 'a'.repeat(255), mode: 'allow' },
        { toolKey: 'workspace.exec', mode: 'require_approval' },
        { toolKey: 'git.commit', mode: 'deny' },
      ],
    };

    expect(() => validateAgentSessionControlPlaneConfig({})).not.toThrow();
    expect(() => validateAgentSessionControlPlaneConfig({ toolRules: [] })).not.toThrow();
    expect(() => validateAgentSessionControlPlaneConfig(config)).not.toThrow();
  });

  const scalarCases: Array<[string, unknown, string]> = [
    ['non-string prompt', { systemPrompt: 42 }, 'systemPrompt must be a string.'],
    [
      'oversized appended prompt',
      { appendSystemPrompt: 'x'.repeat(50_001) },
      'appendSystemPrompt exceeds maximum length of 50000 characters.',
    ],
    ['string integer', { maxIterations: '1' }, 'maxIterations must be a positive integer.'],
    ['fractional integer', { maxIterations: 1.5 }, 'maxIterations must be a positive integer.'],
    ['zero integer', { maxIterations: 0 }, 'maxIterations must be a positive integer.'],
    ['negative integer', { maxIterations: -1 }, 'maxIterations must be a positive integer.'],
    ['non-finite integer', { maxIterations: Number.POSITIVE_INFINITY }, 'maxIterations must be a positive integer.'],
    ['run token budget', { maxRunInputTokens: 0 }, 'maxRunInputTokens must be a positive integer.'],
    [
      'discovery timeout',
      { workspaceToolDiscoveryTimeoutMs: 0 },
      'workspaceToolDiscoveryTimeoutMs must be a positive integer.',
    ],
    [
      'execution timeout',
      { workspaceToolExecutionTimeoutMs: 0 },
      'workspaceToolExecutionTimeoutMs must be a positive integer.',
    ],
  ];

  it.each(scalarCases)('rejects %s with a field-specific diagnostic', (_label, config, message) => {
    expectValidationError(controlPlaneValidator(config), message);
  });

  const toolRuleCases: Array<[string, unknown, string]> = [
    ['a null entry', { toolRules: [null] }, 'toolRules entries must include a non-empty toolKey.'],
    [
      'an empty key',
      { toolRules: [{ toolKey: '', mode: 'allow' }] },
      'toolRules entries must include a non-empty toolKey.',
    ],
    [
      'a non-string key',
      { toolRules: [{ toolKey: 42, mode: 'allow' }] },
      'toolRules entries must include a non-empty toolKey.',
    ],
    [
      'an oversized key',
      { toolRules: [{ toolKey: 'x'.repeat(256), mode: 'allow' }] },
      `toolRules entry "${'x'.repeat(256)}" exceeds maximum toolKey length.`,
    ],
    [
      'an unsupported mode',
      { toolRules: [{ toolKey: 'workspace.exec', mode: 'sometimes' }] },
      'toolRules entry "workspace.exec" has unsupported mode "sometimes".',
    ],
    [
      'an exact duplicate',
      {
        toolRules: [
          { toolKey: 'workspace.exec', mode: 'allow' },
          { toolKey: 'workspace.exec', mode: 'deny' },
        ],
      },
      'Duplicate tool rule "workspace.exec" is not allowed.',
    ],
  ];

  it.each(toolRuleCases)('rejects tool rules containing %s', (_label, config, message) => {
    expectValidationError(controlPlaneValidator(config), message);
  });
});

describe('validateAgentSessionRuntimeSettings', () => {
  const completeConfig: AgentSessionRuntimeSettingsValue = {
    workspaceImage: 'lifecycle/workspace:test',
    workspaceEditorImage: 'lifecycle/editor:test',
    workspaceGatewayImage: 'lifecycle/gateway:test',
    scheduling: {
      nodeSelector: { 'kubernetes.io/os': 'linux' },
      keepAttachedServicesOnSessionNode: false,
    },
    readiness: { timeoutMs: 0, pollMs: 0 },
    resources: {
      workspace: { requests: { cpu: '100m' }, limits: { memory: '2Gi' } },
      editor: { requests: { cpu: '50m' }, limits: { memory: '1Gi' } },
      workspaceGateway: { requests: { cpu: '25m' }, limits: { memory: '512Mi' } },
    },
    workspaceStorage: {
      defaultSize: 'x'.repeat(64),
      allowedSizes: ['10Gi', 'x'.repeat(64)],
      allowClientOverride: true,
      accessMode: 'ReadWriteMany',
    },
    workspaceBackend: {
      provider: 'modal',
      opensandbox: {
        domain: 'sandbox.example.test',
        protocol: 'https',
        apiKey: 'a'.repeat(4096),
        image: 'lifecycle/workspace:test',
        poolRef: 'p'.repeat(253),
        timeoutSeconds: null,
        useServerProxy: true,
        secureAccess: false,
        resourceLimits: { cpu: '2' },
        execdPort: 1,
        gatewayPort: 1,
        editorPort: 1,
      },
      e2b: {
        apiKey: 'e'.repeat(4096),
        templateId: 't'.repeat(253),
        domain: 'e2b.example.test',
        timeoutSeconds: 1,
        autoPause: false,
      },
      daytona: {
        apiKey: 'd'.repeat(4096),
        snapshot: 's'.repeat(253),
        apiUrl: 'https://daytona.example.test/api',
        target: 'target',
        autoArchiveInterval: 0,
      },
      modal: {
        tokenId: 'i'.repeat(4096),
        tokenSecret: 's'.repeat(4096),
        environment: 'e'.repeat(253),
        appName: 'a'.repeat(253),
        image: 'lifecycle/workspace:test',
        imageRegistrySecret: 'r'.repeat(253),
        timeoutSeconds: 1,
        cpu: 0.25,
        memoryMiB: 1,
        inboundCidrAllowlist: ['10.0.0.0/8', '192.168.0.0/16'],
      },
    },
    cleanup: {
      activeIdleSuspendMs: 1,
      startingTimeoutMs: 1,
      hibernatedRetentionMs: 1,
      intervalMs: 1,
      redisTtlSeconds: 1,
    },
    durability: {
      runExecutionLeaseMs: 1,
      queuedRunDispatchStaleMs: 1,
      dispatchRecoveryLimit: 1,
      maxDurablePayloadBytes: 1,
      payloadPreviewBytes: 1,
      fileChangePreviewChars: 1,
    },
  };

  it('accepts an empty partial config and a complete config at documented boundaries', () => {
    expect(() => validateAgentSessionRuntimeSettings({})).not.toThrow();
    expect(() => validateAgentSessionRuntimeSettings(completeConfig)).not.toThrow();
  });

  it.each(['lifecycle_kubernetes', 'opensandbox', 'e2b', 'daytona', 'modal'] as const)(
    'accepts the %s workspace backend provider',
    (provider) => {
      expect(() => validateAgentSessionRuntimeSettings({ workspaceBackend: { provider } })).not.toThrow();
    }
  );

  it.each(['ReadWriteOnce', 'ReadWriteMany'] as const)('accepts the %s storage access mode', (accessMode) => {
    expect(() => validateAgentSessionRuntimeSettings({ workspaceStorage: { accessMode } })).not.toThrow();
  });

  it.each(['http', 'https'] as const)('accepts the %s OpenSandbox protocol', (protocol) => {
    expect(() =>
      validateAgentSessionRuntimeSettings({ workspaceBackend: { opensandbox: { protocol } } })
    ).not.toThrow();
  });

  const malformedCases: Array<[string, unknown, string]> = [
    ['a non-string workspace image', { workspaceImage: false }, 'workspaceImage must be a string.'],
    [
      'an oversized gateway image',
      { workspaceGatewayImage: 'x'.repeat(50_001) },
      'workspaceGatewayImage exceeds maximum length of 50000 characters.',
    ],
    [
      'a string readiness timeout',
      { readiness: { timeoutMs: '1000' } },
      'readiness.timeoutMs must be a non-negative integer.',
    ],
    [
      'a fractional readiness timeout',
      { readiness: { timeoutMs: 1.5 } },
      'readiness.timeoutMs must be a non-negative integer.',
    ],
    [
      'a negative readiness timeout',
      { readiness: { timeoutMs: -1 } },
      'readiness.timeoutMs must be a non-negative integer.',
    ],
    ['a null node selector', { scheduling: { nodeSelector: null } }, 'scheduling.nodeSelector must be an object.'],
    ['a scalar node selector', { scheduling: { nodeSelector: 'linux' } }, 'scheduling.nodeSelector must be an object.'],
    ['an array node selector', { scheduling: { nodeSelector: [] } }, 'scheduling.nodeSelector must be an object.'],
    [
      'a blank record key',
      { resources: { workspace: { requests: { '  ': '100m' } } } },
      'resources.workspace.requests contains an empty key.',
    ],
    [
      'a non-string record value',
      { resources: { editor: { limits: { memory: 1024 } } } },
      'resources.editor.limits.memory must be a non-empty string.',
    ],
    [
      'a blank record value',
      { workspaceBackend: { opensandbox: { resourceLimits: { cpu: '  ' } } } },
      'workspaceBackend.opensandbox.resourceLimits.cpu must be a non-empty string.',
    ],
    [
      'a non-boolean scheduling flag',
      { scheduling: { keepAttachedServicesOnSessionNode: 'yes' } },
      'scheduling.keepAttachedServicesOnSessionNode must be a boolean.',
    ],
    [
      'a blank storage size',
      { workspaceStorage: { defaultSize: '  ' } },
      'workspaceStorage.defaultSize must be a non-empty string.',
    ],
    [
      'an oversized storage size',
      { workspaceStorage: { defaultSize: 'x'.repeat(65) } },
      'workspaceStorage.defaultSize exceeds maximum length of 64 characters.',
    ],
    [
      'a non-array allowed-size list',
      { workspaceStorage: { allowedSizes: '10Gi' } },
      'workspaceStorage.allowedSizes must be an array.',
    ],
    [
      'a non-string allowed-size entry',
      { workspaceStorage: { allowedSizes: [10] } },
      'workspaceStorage.allowedSizes entry must be a non-empty string.',
    ],
    [
      'a blank allowed-size entry',
      { workspaceStorage: { allowedSizes: ['  '] } },
      'workspaceStorage.allowedSizes entry must be a non-empty string.',
    ],
    [
      'an oversized allowed-size entry',
      { workspaceStorage: { allowedSizes: ['x'.repeat(65)] } },
      'workspaceStorage.allowedSizes entry exceeds maximum length of 64 characters.',
    ],
    [
      'duplicate normalized allowed sizes',
      { workspaceStorage: { allowedSizes: ['10Gi', ' 10Gi '] } },
      'workspaceStorage.allowedSizes contains duplicate value "10Gi".',
    ],
    [
      'an unsupported access mode',
      { workspaceStorage: { accessMode: 'ReadOnlyMany' } },
      'workspaceStorage.accessMode must be ReadWriteOnce or ReadWriteMany.',
    ],
    [
      'an unsupported backend provider',
      { workspaceBackend: { provider: 'other' } },
      'workspaceBackend.provider must be lifecycle_kubernetes, opensandbox, e2b, daytona, or modal.',
    ],
    [
      'an unsupported OpenSandbox protocol',
      { workspaceBackend: { opensandbox: { protocol: 'ftp' } } },
      'workspaceBackend.opensandbox.protocol must be http or https.',
    ],
    [
      'an oversized OpenSandbox API key',
      { workspaceBackend: { opensandbox: { apiKey: 'x'.repeat(4097) } } },
      'workspaceBackend.opensandbox.apiKey exceeds maximum length of 4096 characters.',
    ],
    [
      'an oversized OpenSandbox pool reference',
      { workspaceBackend: { opensandbox: { poolRef: 'x'.repeat(254) } } },
      'workspaceBackend.opensandbox.poolRef exceeds maximum length of 253 characters.',
    ],
    [
      'a zero nullable timeout',
      { workspaceBackend: { opensandbox: { timeoutSeconds: 0 } } },
      'workspaceBackend.opensandbox.timeoutSeconds must be a positive integer.',
    ],
    [
      'a zero OpenSandbox port',
      { workspaceBackend: { opensandbox: { gatewayPort: 0 } } },
      'workspaceBackend.opensandbox.gatewayPort must be a positive integer.',
    ],
    [
      'a negative Daytona archive interval',
      { workspaceBackend: { daytona: { autoArchiveInterval: -1 } } },
      'workspaceBackend.daytona.autoArchiveInterval must be a non-negative integer.',
    ],
    [
      'a string Modal CPU',
      { workspaceBackend: { modal: { cpu: '1' } } },
      'workspaceBackend.modal.cpu must be a positive number.',
    ],
    [
      'a non-finite Modal CPU',
      { workspaceBackend: { modal: { cpu: Number.POSITIVE_INFINITY } } },
      'workspaceBackend.modal.cpu must be a positive number.',
    ],
    [
      'a zero Modal CPU',
      { workspaceBackend: { modal: { cpu: 0 } } },
      'workspaceBackend.modal.cpu must be a positive number.',
    ],
    [
      'a zero Modal memory limit',
      { workspaceBackend: { modal: { memoryMiB: 0 } } },
      'workspaceBackend.modal.memoryMiB must be a positive integer.',
    ],
    ['a zero cleanup interval', { cleanup: { intervalMs: 0 } }, 'cleanup.intervalMs must be a positive integer.'],
    [
      'a zero durability payload limit',
      { durability: { maxDurablePayloadBytes: 0 } },
      'durability.maxDurablePayloadBytes must be a positive integer.',
    ],
  ];

  it.each(malformedCases)('rejects %s with a stable path-specific diagnostic', (_label, config, message) => {
    expectValidationError(runtimeValidator(config), message);
  });
});
