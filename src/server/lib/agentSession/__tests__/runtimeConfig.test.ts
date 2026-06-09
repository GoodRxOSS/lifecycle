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
  mergeAgentSessionReadinessForServices,
  mergeAgentSessionResources,
  resolveAgentSessionControlPlaneConfig,
  resolveAgentSessionControlPlaneConfigFromDefaults,
  resolveAgentSessionDurabilityFromDefaults,
  resolveAgentSessionCleanupFromDefaults,
  resolveAgentSessionReadinessFromDefaults,
  resolveAgentSessionResourcesFromDefaults,
  resolveAgentSessionRuntimeConfig,
  resolveAgentSessionWorkspaceBackendFromDefaults,
  resolveAgentSessionWorkspaceStorageFromDefaults,
  resolveAgentSessionWorkspaceStorageIntent,
} from '../runtimeConfig';
import { encryptConfigSecret } from 'server/lib/encryption';

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

const DEFAULT_E2B_BACKEND = {
  domain: 'e2b.app',
  timeoutSeconds: 3600,
  autoPause: true,
  gatewayPort: 13338,
  editorPort: 13337,
};

const DEFAULT_DAYTONA_BACKEND = {
  apiUrl: 'https://app.daytona.io/api',
  autoArchiveInterval: 0,
  gatewayPort: 13338,
  editorPort: 13337,
};

const DEFAULT_MODAL_BACKEND = {
  appName: 'lifecycle-workspaces',
  image: 'lifecycleoss/workspace:latest',
  timeoutSeconds: 14400,
  gatewayPort: 13338,
};

const DEFAULT_WORKSPACE_BACKEND: {
  provider: 'lifecycle_kubernetes' | 'opensandbox' | 'e2b' | 'daytona';
  opensandbox: {
    domain: string;
    protocol: 'http' | 'https';
    apiKey?: string;
    image?: string;
    poolRef?: string;
    timeoutSeconds: number | null;
    useServerProxy: boolean;
    secureAccess: boolean;
    resourceLimits: Record<string, string>;
    execdPort: number;
    gatewayPort: number;
    editorPort: number;
  };
  e2b: Record<string, unknown>;
  daytona: Record<string, unknown>;
  modal: Record<string, unknown>;
} = {
  provider: 'lifecycle_kubernetes',
  opensandbox: {
    domain: 'localhost:8080',
    protocol: 'http',
    image: 'lifecycle-workspace:sha-123',
    timeoutSeconds: 3600,
    useServerProxy: true,
    secureAccess: true,
    resourceLimits: {
      cpu: '2',
      memory: '4Gi',
    },
    execdPort: 44772,
    gatewayPort: 13338,
    editorPort: 13337,
  },
  e2b: DEFAULT_E2B_BACKEND,
  daytona: DEFAULT_DAYTONA_BACKEND,
  modal: DEFAULT_MODAL_BACKEND,
};

function buildExpectedRuntimeConfig(overrides?: {
  nodeSelector?: Record<string, string>;
  keepAttachedServicesOnSessionNode?: boolean;
  readiness?: typeof DEFAULT_READINESS;
  resources?: typeof DEFAULT_RESOURCES;
  workspaceStorage?: typeof DEFAULT_WORKSPACE_STORAGE;
  workspaceBackend?: typeof DEFAULT_WORKSPACE_BACKEND;
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
    workspaceBackend: DEFAULT_WORKSPACE_BACKEND,
    cleanup: DEFAULT_CLEANUP,
    durability: DEFAULT_DURABILITY,
    ...overrides,
  };
}

const RUNTIME_ENV_KEYS = [
  'AGENT_SESSION_WORKSPACE_BACKEND',
  'E2B_API_KEY',
  'DAYTONA_API_KEY',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'OPEN_SANDBOX_DOMAIN',
  'OPEN_SANDBOX_PROTOCOL',
  'OPEN_SANDBOX_API_KEY',
  'OPEN_SANDBOX_IMAGE',
  'OPEN_SANDBOX_POOL_REF',
  'OPEN_SANDBOX_USE_SERVER_PROXY',
  'OPEN_SANDBOX_SECURE_ACCESS',
  'OPEN_SANDBOX_EXECD_PORT',
  'OPEN_SANDBOX_TIMEOUT_SECONDS',
  'AGENT_SESSION_WORKSPACE_GATEWAY_PORT',
  'AGENT_SESSION_WORKSPACE_EDITOR_PORT',
  'AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS',
  'AGENT_SESSION_WORKSPACE_READY_POLL_MS',
  'AGENT_SESSION_PVC_ACCESS_MODE',
];

describe('runtimeConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = process.env;
    process.env = { ...originalEnv };
    for (const key of RUNTIME_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
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

  it('returns configured OpenSandbox workspace backend settings when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'lifecycle-workspace:sha-123',
        workspaceEditorImage: 'codercom/code-server:4.98.2',
        workspaceBackend: {
          provider: 'opensandbox',
          opensandbox: {
            domain: 'sandbox.local',
            protocol: 'https',
            apiKey: 'test-api-key',
            image: 'custom-opensandbox-image:latest',
            poolRef: 'lifecycle-workspace-pool',
            timeoutSeconds: null,
            useServerProxy: false,
            secureAccess: true,
            resourceLimits: {
              cpu: '8',
              memory: '16Gi',
            },
            execdPort: 44773,
            gatewayPort: 15555,
            editorPort: 15556,
          },
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual(
      buildExpectedRuntimeConfig({
        workspaceBackend: {
          ...DEFAULT_WORKSPACE_BACKEND,
          provider: 'opensandbox',
          opensandbox: {
            domain: 'sandbox.local',
            protocol: 'https',
            apiKey: 'test-api-key',
            image: 'custom-opensandbox-image:latest',
            poolRef: 'lifecycle-workspace-pool',
            timeoutSeconds: null,
            useServerProxy: false,
            secureAccess: true,
            resourceLimits: {
              cpu: '8',
              memory: '16Gi',
            },
            execdPort: 44773,
            gatewayPort: 15555,
            editorPort: 15556,
          },
        },
      })
    );
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

  it('preserves configured control-plane max iteration defaults without a code ceiling', () => {
    expect(
      resolveAgentSessionControlPlaneConfigFromDefaults({
        controlPlane: {
          maxIterations: 9911250,
        },
      })
    ).toEqual(
      expect.objectContaining({
        maxIterations: 9911250,
      })
    );
  });

  it('falls back to the default control-plane system prompt when unset', () => {
    expect(resolveAgentSessionControlPlaneConfigFromDefaults({})).toEqual({
      systemPrompt:
        'You are a Lifecycle agent operating through tool calls. Your identity, surface, and capabilities are defined by the agent instructions that follow — only the tools actually registered in this conversation exist.\n' +
        'Do not emit pseudo-tool markup or pretend execution happened. Never write things like <read_file>, <write_file>, <attempt_completion>, <result>, or shell commands as if they were already executed.\n' +
        'Do not claim that a file was read, a command was run, or a change was made unless that happened through an actual tool call in this conversation.\n' +
        'A local git commit is not a remote branch update. Only say a PR branch, GitHub commit URL, webhook rebuild, or Lifecycle build changed after a successful push, GitHub API call, or observed Lifecycle state confirms it.\n' +
        'If a tool call fails or a capability is unavailable, say that plainly and explain what failed.\n' +
        'Never offer to perform an action you have no registered tool for; point to the visible UI action instead.',
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

  describe('OPEN_SANDBOX environment configuration', () => {
    it('flows env-only OpenSandbox settings through the runtime config', async () => {
      process.env.AGENT_SESSION_WORKSPACE_BACKEND = 'opensandbox';
      process.env.OPEN_SANDBOX_DOMAIN = 'sandbox.example.com:9000';
      process.env.OPEN_SANDBOX_PROTOCOL = 'https';
      process.env.OPEN_SANDBOX_API_KEY = 'env-api-key';
      process.env.OPEN_SANDBOX_POOL_REF = 'env-pool';
      process.env.OPEN_SANDBOX_USE_SERVER_PROXY = 'false';
      process.env.OPEN_SANDBOX_SECURE_ACCESS = 'true';
      process.env.OPEN_SANDBOX_EXECD_PORT = '45000';
      process.env.OPEN_SANDBOX_TIMEOUT_SECONDS = '7200';

      getAllConfigs.mockResolvedValue({
        agentSessionDefaults: {
          workspaceImage: 'lifecycle-workspace:sha-123',
          workspaceEditorImage: 'codercom/code-server:4.98.2',
        },
      });

      await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual(
        buildExpectedRuntimeConfig({
          workspaceBackend: {
            ...DEFAULT_WORKSPACE_BACKEND,
            provider: 'opensandbox',
            opensandbox: {
              domain: 'sandbox.example.com:9000',
              protocol: 'https',
              apiKey: 'env-api-key',
              image: 'lifecycle-workspace:sha-123',
              poolRef: 'env-pool',
              timeoutSeconds: 7200,
              useServerProxy: false,
              secureAccess: true,
              resourceLimits: {
                cpu: '2',
                memory: '4Gi',
              },
              execdPort: 45000,
              gatewayPort: 13338,
              editorPort: 13337,
            },
          },
        })
      );
    });

    it('prefers DB defaults over env for domain, protocol, poolRef, and ports', () => {
      process.env.AGENT_SESSION_WORKSPACE_BACKEND = 'lifecycle_kubernetes';
      process.env.OPEN_SANDBOX_DOMAIN = 'env.example.com';
      process.env.OPEN_SANDBOX_PROTOCOL = 'http';
      process.env.OPEN_SANDBOX_POOL_REF = 'env-pool';
      process.env.OPEN_SANDBOX_EXECD_PORT = '40000';
      process.env.AGENT_SESSION_WORKSPACE_GATEWAY_PORT = '40001';
      process.env.AGENT_SESSION_WORKSPACE_EDITOR_PORT = '40002';

      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults({
        provider: 'opensandbox',
        opensandbox: {
          domain: 'db.example.com',
          protocol: 'https',
          poolRef: 'db-pool',
          execdPort: 50000,
          gatewayPort: 50001,
          editorPort: 50002,
        },
      });

      expect(resolved.provider).toBe('opensandbox');
      expect(resolved.opensandbox).toMatchObject({
        domain: 'db.example.com',
        protocol: 'https',
        poolRef: 'db-pool',
        execdPort: 50000,
        gatewayPort: 50001,
        editorPort: 50002,
      });
    });

    it('defaults secureAccess to true and lets env/config opt out', () => {
      expect(resolveAgentSessionWorkspaceBackendFromDefaults().opensandbox.secureAccess).toBe(true);

      process.env.OPEN_SANDBOX_SECURE_ACCESS = 'false';
      expect(resolveAgentSessionWorkspaceBackendFromDefaults().opensandbox.secureAccess).toBe(false);
      expect(
        resolveAgentSessionWorkspaceBackendFromDefaults({ opensandbox: { secureAccess: true } }).opensandbox
          .secureAccess
      ).toBe(true);
    });

    it("yields timeoutSeconds null when OPEN_SANDBOX_TIMEOUT_SECONDS is 'null'", () => {
      process.env.OPEN_SANDBOX_TIMEOUT_SECONDS = 'null';

      expect(resolveAgentSessionWorkspaceBackendFromDefaults().opensandbox.timeoutSeconds).toBeNull();
      // env 'null' wins even over a numeric DB default
      expect(
        resolveAgentSessionWorkspaceBackendFromDefaults({ opensandbox: { timeoutSeconds: 7200 } }).opensandbox
          .timeoutSeconds
      ).toBeNull();
    });

    it('falls back for image: explicit config, then OPEN_SANDBOX_IMAGE, then workspaceImage', () => {
      process.env.OPEN_SANDBOX_IMAGE = 'env-image:1';

      expect(
        resolveAgentSessionWorkspaceBackendFromDefaults({ opensandbox: { image: 'db-image:1' } }, 'workspace-image:1')
          .opensandbox.image
      ).toBe('db-image:1');
      expect(resolveAgentSessionWorkspaceBackendFromDefaults({}, 'workspace-image:1').opensandbox.image).toBe(
        'env-image:1'
      );

      delete process.env.OPEN_SANDBOX_IMAGE;
      expect(resolveAgentSessionWorkspaceBackendFromDefaults({}, 'workspace-image:1').opensandbox.image).toBe(
        'workspace-image:1'
      );
      expect(resolveAgentSessionWorkspaceBackendFromDefaults().opensandbox.image).toBeUndefined();
    });
  });

  describe('E2B and Daytona configuration', () => {
    it('resolves documented defaults when nothing is configured', () => {
      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults();

      expect(resolved.e2b).toEqual({
        domain: 'e2b.app',
        timeoutSeconds: 3600,
        autoPause: true,
        gatewayPort: 13338,
        editorPort: 13337,
      });
      expect(resolved.daytona).toEqual({
        apiUrl: 'https://app.daytona.io/api',
        autoArchiveInterval: 0,
        gatewayPort: 13338,
        editorPort: 13337,
      });
    });

    it('forces autoPause on when e2b timeoutSeconds is null (no infinite TTL → dead-man pause required)', () => {
      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults({
        provider: 'e2b',
        e2b: { timeoutSeconds: null, autoPause: false },
      });

      expect(resolved.e2b.timeoutSeconds).toBeNull();
      expect(resolved.e2b.autoPause).toBe(true);
    });

    it('falls back to E2B_API_KEY / DAYTONA_API_KEY env keys, with DB values winning', () => {
      process.env.E2B_API_KEY = 'env-e2b-key';
      process.env.DAYTONA_API_KEY = 'env-daytona-key';

      const envResolved = resolveAgentSessionWorkspaceBackendFromDefaults();
      expect(envResolved.e2b.apiKey).toBe('env-e2b-key');
      expect(envResolved.daytona.apiKey).toBe('env-daytona-key');

      const dbResolved = resolveAgentSessionWorkspaceBackendFromDefaults({
        e2b: { apiKey: 'db-e2b-key' },
        daytona: { apiKey: 'db-daytona-key' },
      });
      expect(dbResolved.e2b.apiKey).toBe('db-e2b-key');
      expect(dbResolved.daytona.apiKey).toBe('db-daytona-key');
    });

    it('resolves modal defaults, env token fallbacks, and the 24h timeout clamp', () => {
      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults();
      expect(resolved.modal).toEqual({
        appName: 'lifecycle-workspaces',
        image: 'lifecycleoss/workspace:latest',
        timeoutSeconds: 14400,
        gatewayPort: 13338,
      });

      process.env.MODAL_TOKEN_ID = 'ak-env';
      process.env.MODAL_TOKEN_SECRET = 'as-env';
      const envResolved = resolveAgentSessionWorkspaceBackendFromDefaults();
      expect(envResolved.modal).toMatchObject({ tokenId: 'ak-env', tokenSecret: 'as-env' });

      const dbResolved = resolveAgentSessionWorkspaceBackendFromDefaults({
        provider: 'modal',
        modal: {
          tokenId: 'ak-db',
          tokenSecret: 'as-db',
          environment: 'prod',
          appName: 'custom-app',
          image: 'lifecycleoss/workspace:1.2.3',
          imageRegistrySecret: 'lifecycle-registry',
          timeoutSeconds: 100 * 60 * 60,
          cpu: '2.5',
          memoryMiB: '4096',
          inboundCidrAllowlist: ['10.0.0.0/8'],
        },
      });
      expect(dbResolved.provider).toBe('modal');
      expect(dbResolved.modal).toMatchObject({
        tokenId: 'ak-db',
        tokenSecret: 'as-db',
        environment: 'prod',
        appName: 'custom-app',
        image: 'lifecycleoss/workspace:1.2.3',
        imageRegistrySecret: 'lifecycle-registry',
        // Modal hard-caps sandbox lifetime at 24h.
        timeoutSeconds: 86400,
        cpu: 2.5,
        memoryMiB: 4096,
        inboundCidrAllowlist: ['10.0.0.0/8'],
      });
    });

    it('accepts e2b and daytona as workspace backend providers (DB and env)', () => {
      expect(resolveAgentSessionWorkspaceBackendFromDefaults({ provider: 'e2b' }).provider).toBe('e2b');
      expect(resolveAgentSessionWorkspaceBackendFromDefaults({ provider: 'daytona' }).provider).toBe('daytona');

      process.env.AGENT_SESSION_WORKSPACE_BACKEND = 'daytona';
      expect(resolveAgentSessionWorkspaceBackendFromDefaults().provider).toBe('daytona');
    });

    it('normalizes configured e2b and daytona blocks', () => {
      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults({
        e2b: {
          apiKey: 'e2b_live',
          templateId: 'lifecycle-workspace',
          domain: 'eu.e2b.app',
          timeoutSeconds: '7200',
          autoPause: false,
        },
        daytona: {
          apiKey: 'dtn_live',
          snapshot: 'lifecycle-workspace-1.2.3',
          apiUrl: 'https://daytona.internal/api',
          target: 'us',
          autoArchiveInterval: '10080',
        },
      });

      expect(resolved.e2b).toMatchObject({
        apiKey: 'e2b_live',
        templateId: 'lifecycle-workspace',
        domain: 'eu.e2b.app',
        timeoutSeconds: 7200,
        autoPause: false,
      });
      expect(resolved.daytona).toMatchObject({
        apiKey: 'dtn_live',
        snapshot: 'lifecycle-workspace-1.2.3',
        apiUrl: 'https://daytona.internal/api',
        target: 'us',
        autoArchiveInterval: 10080,
      });
    });
  });

  describe('encrypted secret resolution', () => {
    const originalEncryptionKey = process.env.ENCRYPTION_KEY;

    beforeEach(() => {
      process.env.ENCRYPTION_KEY = 'a01b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b';
    });

    afterEach(() => {
      if (originalEncryptionKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = originalEncryptionKey;
      }
    });

    it('decrypts stored ciphertext secrets per call across all backends', () => {
      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults({
        opensandbox: { apiKey: encryptConfigSecret('osb-plain') },
        e2b: { apiKey: encryptConfigSecret('e2b-plain') },
        daytona: { apiKey: encryptConfigSecret('daytona-plain') },
        modal: { tokenId: encryptConfigSecret('ak-plain'), tokenSecret: encryptConfigSecret('as-plain') },
      });

      expect(resolved.opensandbox.apiKey).toBe('osb-plain');
      expect(resolved.e2b.apiKey).toBe('e2b-plain');
      expect(resolved.daytona.apiKey).toBe('daytona-plain');
      expect(resolved.modal).toMatchObject({ tokenId: 'ak-plain', tokenSecret: 'as-plain' });
    });

    it('passes ciphertext through untouched on presence-only resolution (decryptSecrets: false)', () => {
      const ciphertext = encryptConfigSecret('e2b-plain');
      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults({ e2b: { apiKey: ciphertext } }, null, {
        decryptSecrets: false,
      });

      expect(resolved.e2b.apiKey).toBe(ciphertext);
    });

    it('uses legacy plaintext secrets as-is (migrate-on-write keeps them working)', () => {
      const resolved = resolveAgentSessionWorkspaceBackendFromDefaults({ e2b: { apiKey: 'legacy-plaintext-key' } });
      expect(resolved.e2b.apiKey).toBe('legacy-plaintext-key');
    });

    it('raises a clear error for ciphertext that no longer decrypts instead of using it as a credential', () => {
      const ciphertext = encryptConfigSecret('e2b-plain');
      process.env.ENCRYPTION_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

      expect(() => resolveAgentSessionWorkspaceBackendFromDefaults({ e2b: { apiKey: ciphertext } })).toThrow(
        'verify ENCRYPTION_KEY'
      );
      // Presence-only resolution stays usable so admins can still read/fix the config.
      expect(() =>
        resolveAgentSessionWorkspaceBackendFromDefaults({ e2b: { apiKey: ciphertext } }, null, {
          decryptSecrets: false,
        })
      ).not.toThrow();
    });
  });
});
