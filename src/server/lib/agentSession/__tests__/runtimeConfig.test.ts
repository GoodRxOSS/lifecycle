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

const getAllConfigs = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs,
    })),
  },
}));

import {
  AgentSessionWorkspaceStorageConfigError,
  AgentSessionRuntimeConfigError,
  DEFAULT_AGENT_SESSION_ACTIVE_IDLE_SUSPEND_MS,
  DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS,
  DEFAULT_AGENT_SESSION_DISPATCH_RECOVERY_LIMIT,
  DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS,
  DEFAULT_AGENT_SESSION_HIBERNATED_RETENTION_MS,
  DEFAULT_AGENT_SESSION_KEEP_ATTACHED_SERVICES_ON_SESSION_NODE,
  DEFAULT_AGENT_SESSION_MAX_ITERATIONS,
  DEFAULT_AGENT_SESSION_MAX_DURABLE_PAYLOAD_BYTES,
  DEFAULT_AGENT_SESSION_PAYLOAD_PREVIEW_BYTES,
  DEFAULT_AGENT_SESSION_QUEUED_RUN_DISPATCH_STALE_MS,
  DEFAULT_AGENT_SESSION_REDIS_TTL_SECONDS,
  DEFAULT_AGENT_SESSION_RUN_EXECUTION_LEASE_MS,
  DEFAULT_AGENT_SESSION_STARTING_TIMEOUT_MS,
  DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE,
  DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE,
  DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_DISCOVERY_TIMEOUT_MS,
  DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_EXECUTION_TIMEOUT_MS,
  mergeAgentSessionReadiness,
  mergeAgentSessionReadinessForServices,
  mergeAgentSessionResources,
  resolveAgentSessionControlPlaneConfig,
  resolveAgentSessionControlPlaneConfigFromDefaults,
  resolveAgentSessionDurabilityFromDefaults,
  resolveAgentSessionCleanupFromDefaults,
  resolveAgentSessionReadinessFromDefaults,
  resolveAgentSessionResourcesFromDefaults,
  resolveAgentSessionRuntimeConfig,
  resolveAgentSessionWorkspaceStorageFromDefaults,
  resolveAgentSessionWorkspaceStorageIntent,
} from '../runtimeConfig';

const DEFAULT_READINESS = {
  timeoutMs: 60000,
  pollMs: 1000,
};

const DEFAULT_RESOURCES = {
  workspace: {
    requests: {
      cpu: '500m',
      memory: '1Gi',
    },
    limits: {
      cpu: '2',
      memory: '4Gi',
    },
  },
  editor: {
    requests: {
      cpu: '250m',
      memory: '512Mi',
    },
    limits: {
      cpu: '1',
      memory: '1Gi',
    },
  },
  workspaceGateway: {
    requests: {
      cpu: '100m',
      memory: '256Mi',
    },
    limits: {
      cpu: '500m',
      memory: '512Mi',
    },
  },
};

const DEFAULT_WORKSPACE_STORAGE = {
  defaultSize: DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE,
  allowedSizes: [DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE],
  allowClientOverride: false,
  accessMode: DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE,
};

const DEFAULT_CLEANUP = {
  activeIdleSuspendMs: DEFAULT_AGENT_SESSION_ACTIVE_IDLE_SUSPEND_MS,
  startingTimeoutMs: DEFAULT_AGENT_SESSION_STARTING_TIMEOUT_MS,
  hibernatedRetentionMs: DEFAULT_AGENT_SESSION_HIBERNATED_RETENTION_MS,
  intervalMs: DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS,
  redisTtlSeconds: DEFAULT_AGENT_SESSION_REDIS_TTL_SECONDS,
};

const DEFAULT_DURABILITY = {
  runExecutionLeaseMs: DEFAULT_AGENT_SESSION_RUN_EXECUTION_LEASE_MS,
  queuedRunDispatchStaleMs: DEFAULT_AGENT_SESSION_QUEUED_RUN_DISPATCH_STALE_MS,
  dispatchRecoveryLimit: DEFAULT_AGENT_SESSION_DISPATCH_RECOVERY_LIMIT,
  maxDurablePayloadBytes: DEFAULT_AGENT_SESSION_MAX_DURABLE_PAYLOAD_BYTES,
  payloadPreviewBytes: DEFAULT_AGENT_SESSION_PAYLOAD_PREVIEW_BYTES,
  fileChangePreviewChars: DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS,
};

function buildExpectedRuntimeConfig(overrides?: {
  nodeSelector?: Record<string, string>;
  keepAttachedServicesOnSessionNode?: boolean;
  readiness?: typeof DEFAULT_READINESS;
  resources?: typeof DEFAULT_RESOURCES;
  workspaceStorage?: typeof DEFAULT_WORKSPACE_STORAGE;
  cleanup?: typeof DEFAULT_CLEANUP;
  durability?: typeof DEFAULT_DURABILITY;
}) {
  return {
    workspaceImage: 'lifecycle-workspace:sha-123',
    workspaceEditorImage: 'codercom/code-server:4.98.2',
    workspaceGatewayImage: 'lifecycle-workspace:sha-123',
    nodeSelector: undefined,
    keepAttachedServicesOnSessionNode: DEFAULT_AGENT_SESSION_KEEP_ATTACHED_SERVICES_ON_SESSION_NODE,
    readiness: DEFAULT_READINESS,
    resources: DEFAULT_RESOURCES,
    workspaceStorage: DEFAULT_WORKSPACE_STORAGE,
    cleanup: DEFAULT_CLEANUP,
    durability: DEFAULT_DURABILITY,
    ...overrides,
  };
}

describe('runtimeConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the configured agent and editor images', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'lifecycle-workspace:sha-123',
        workspaceEditorImage: 'codercom/code-server:4.98.2',
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual(buildExpectedRuntimeConfig());
  });

  it('returns the configured agent scheduling when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'lifecycle-workspace:sha-123',
        workspaceEditorImage: 'codercom/code-server:4.98.2',
        scheduling: {
          keepAttachedServicesOnSessionNode: false,
          nodeSelector: {
            'app-long': 'deployments-m7i',
            pool: 'agents',
          },
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual(
      buildExpectedRuntimeConfig({
        nodeSelector: {
          'app-long': 'deployments-m7i',
          pool: 'agents',
        },
        keepAttachedServicesOnSessionNode: false,
      })
    );
  });

  it('returns configured agent and editor resources when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'lifecycle-workspace:sha-123',
        workspaceEditorImage: 'codercom/code-server:4.98.2',
        resources: {
          workspace: {
            requests: {
              cpu: '900m',
            },
            limits: {
              memory: '6Gi',
            },
          },
          editor: {
            requests: {
              memory: '768Mi',
            },
            limits: {
              cpu: '1500m',
            },
          },
          workspaceGateway: {
            requests: {
              cpu: '200m',
            },
            limits: {
              memory: '768Mi',
            },
          },
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual(
      buildExpectedRuntimeConfig({
        resources: {
          workspace: {
            requests: {
              cpu: '900m',
              memory: '1Gi',
            },
            limits: {
              cpu: '2',
              memory: '6Gi',
            },
          },
          editor: {
            requests: {
              cpu: '250m',
              memory: '768Mi',
            },
            limits: {
              cpu: '1500m',
              memory: '1Gi',
            },
          },
          workspaceGateway: {
            requests: {
              cpu: '200m',
              memory: '256Mi',
            },
            limits: {
              cpu: '500m',
              memory: '768Mi',
            },
          },
        },
      })
    );
  });

  it('returns configured readiness settings when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'lifecycle-workspace:sha-123',
        workspaceEditorImage: 'codercom/code-server:4.98.2',
        readiness: {
          timeoutMs: 120000,
          pollMs: 500,
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual(
      buildExpectedRuntimeConfig({
        readiness: {
          timeoutMs: 120000,
          pollMs: 500,
        },
      })
    );
  });

  it('returns configured workspace storage, cleanup, and durability settings when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'lifecycle-workspace:sha-123',
        workspaceEditorImage: 'codercom/code-server:4.98.2',
        workspaceStorage: {
          defaultSize: '20Gi',
          allowedSizes: ['10Gi', '20Gi'],
          allowClientOverride: true,
          accessMode: 'ReadWriteMany',
        },
        cleanup: {
          activeIdleSuspendMs: 60_000,
          startingTimeoutMs: 120_000,
          hibernatedRetentionMs: 180_000,
          intervalMs: 30_000,
          redisTtlSeconds: 900,
        },
        durability: {
          runExecutionLeaseMs: 45_000,
          queuedRunDispatchStaleMs: 5_000,
          dispatchRecoveryLimit: 12,
          maxDurablePayloadBytes: 4096,
          payloadPreviewBytes: 512,
          fileChangePreviewChars: 600,
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual(
      buildExpectedRuntimeConfig({
        workspaceStorage: {
          defaultSize: '20Gi',
          allowedSizes: ['10Gi', '20Gi'],
          allowClientOverride: true,
          accessMode: 'ReadWriteMany',
        },
        cleanup: {
          activeIdleSuspendMs: 60_000,
          startingTimeoutMs: 120_000,
          hibernatedRetentionMs: 180_000,
          intervalMs: 30_000,
          redisTtlSeconds: 900,
        },
        durability: {
          runExecutionLeaseMs: 45_000,
          queuedRunDispatchStaleMs: 5_000,
          dispatchRecoveryLimit: 12,
          maxDurablePayloadBytes: 4096,
          payloadPreviewBytes: 512,
          fileChangePreviewChars: 600,
        },
      })
    );
  });

  it('resolves client workspace storage intent only when overrides are enabled and allowed', () => {
    const storage = resolveAgentSessionWorkspaceStorageFromDefaults({
      defaultSize: '10Gi',
      allowedSizes: ['10Gi', '20Gi'],
      allowClientOverride: true,
      accessMode: 'ReadWriteOnce',
    });

    expect(resolveAgentSessionWorkspaceStorageIntent({ requestedSize: '20Gi', storage })).toEqual({
      requestedSize: '20Gi',
      storageSize: '20Gi',
      accessMode: 'ReadWriteOnce',
    });
    expect(() =>
      resolveAgentSessionWorkspaceStorageIntent({
        requestedSize: '30Gi',
        storage,
      })
    ).toThrow(AgentSessionWorkspaceStorageConfigError);
  });

  it('resolves cleanup and durability defaults independently', () => {
    expect(resolveAgentSessionCleanupFromDefaults()).toEqual(DEFAULT_CLEANUP);
    expect(resolveAgentSessionDurabilityFromDefaults()).toEqual(DEFAULT_DURABILITY);
  });

  it('returns the configured control-plane append prompt from the neutral path', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        controlPlane: {
          systemPrompt: 'You are Lifecycle Agent Session.',
          appendSystemPrompt: 'Use concise responses.',
          maxIterations: 14,
          workspaceToolDiscoveryTimeoutMs: 4500,
          workspaceToolExecutionTimeoutMs: 22000,
        },
      },
    });

    await expect(resolveAgentSessionControlPlaneConfig()).resolves.toEqual({
      systemPrompt: 'You are Lifecycle Agent Session.',
      appendSystemPrompt: 'Use concise responses.',
      maxIterations: 14,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });
  });

  it('falls back to the default control-plane system prompt when unset', () => {
    expect(resolveAgentSessionControlPlaneConfigFromDefaults({})).toEqual({
      systemPrompt:
        'You are Lifecycle Agent Session, a coding agent operating on a real workspace through tool calls.\n' +
        'Use the available tools directly when you need to inspect files, search the workspace, run commands, or modify code.\n' +
        'Do not emit pseudo-tool markup or pretend execution happened. Never write things like <read_file>, <write_file>, <attempt_completion>, <result>, or shell commands as if they were already executed.\n' +
        'Do not claim that a file was read, a command was run, or a change was made unless that happened through an actual tool call in this conversation.\n' +
        'If a tool call fails or a capability is unavailable, say that plainly and explain what failed.',
      appendSystemPrompt:
        'When a tool execution is not approved, do not retry the denied action. Use the denial reason as updated guidance and continue from there.\n' +
        'When showing multi-line exact text such as file contents, command output, diffs, or JSON, use a fenced code block instead of inline code.',
      maxIterations: DEFAULT_AGENT_SESSION_MAX_ITERATIONS,
      workspaceToolDiscoveryTimeoutMs: DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_DISCOVERY_TIMEOUT_MS,
      workspaceToolExecutionTimeoutMs: DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_EXECUTION_TIMEOUT_MS,
    });
  });

  it('merges lifecycle resource overrides over runtime defaults', () => {
    expect(
      mergeAgentSessionResources(resolveAgentSessionResourcesFromDefaults(), {
        workspace: {
          requests: {
            cpu: '1200m',
          },
        },
        editor: {
          limits: {
            memory: '2Gi',
          },
        },
      })
    ).toEqual({
      workspace: {
        requests: {
          cpu: '1200m',
          memory: '1Gi',
        },
        limits: {
          cpu: '2',
          memory: '4Gi',
        },
      },
      editor: {
        requests: {
          cpu: '250m',
          memory: '512Mi',
        },
        limits: {
          cpu: '1',
          memory: '2Gi',
        },
      },
      workspaceGateway: {
        requests: {
          cpu: '100m',
          memory: '256Mi',
        },
        limits: {
          cpu: '500m',
          memory: '512Mi',
        },
      },
    });
  });

  it('merges direct readiness overrides over runtime defaults', () => {
    expect(
      mergeAgentSessionReadiness(resolveAgentSessionReadinessFromDefaults({ timeoutMs: 60000, pollMs: 1000 }), {
        timeoutMs: 120000,
      })
    ).toEqual({
      timeoutMs: 120000,
      pollMs: 1000,
    });
  });

  it('merges service readiness overrides over runtime defaults', () => {
    expect(
      mergeAgentSessionReadinessForServices(
        resolveAgentSessionReadinessFromDefaults({ timeoutMs: 60000, pollMs: 1000 }),
        [{ timeoutMs: 120000 }, { timeoutMs: 90000, pollMs: 500 }, undefined, { pollMs: 1000 }]
      )
    ).toEqual({
      timeoutMs: 120000,
      pollMs: 500,
    });
  });

  it('throws when the workspace image is missing', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: null,
        workspaceEditorImage: 'codercom/code-server:4.98.2',
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).rejects.toEqual(
      expect.objectContaining<Partial<AgentSessionRuntimeConfigError>>({
        name: 'AgentSessionRuntimeConfigError',
        missingFields: ['workspaceImage'],
      })
    );
  });

  it('throws when the workspace editor image is missing', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'lifecycle-workspace:sha-123',
        workspaceEditorImage: '  ',
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).rejects.toEqual(
      expect.objectContaining<Partial<AgentSessionRuntimeConfigError>>({
        name: 'AgentSessionRuntimeConfigError',
        missingFields: ['workspaceEditorImage'],
      })
    );
  });

  it('throws when both runtime images are missing', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {},
    });

    await expect(resolveAgentSessionRuntimeConfig()).rejects.toEqual(
      expect.objectContaining<Partial<AgentSessionRuntimeConfigError>>({
        name: 'AgentSessionRuntimeConfigError',
        missingFields: ['workspaceImage', 'workspaceEditorImage'],
      })
    );
  });
});
