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

jest.mock('server/services/agentRuntime/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    listEffectiveDefinitions: jest.fn().mockResolvedValue([]),
  })),
}));

const mockGlobalConfigGetConfig = jest.fn();
const mockGlobalConfigSetConfig = jest.fn();
const mockAgentRuntimeGetGlobalConfig = jest.fn();
const mockAgentRuntimeGetRepoConfig = jest.fn();
const mockAgentRuntimeGetEffectiveConfig = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGlobalConfigGetConfig(...args),
      setConfig: (...args: unknown[]) => mockGlobalConfigSetConfig(...args),
    })),
  },
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getGlobalConfig: (...args: unknown[]) => mockAgentRuntimeGetGlobalConfig(...args),
      getRepoConfig: (...args: unknown[]) => mockAgentRuntimeGetRepoConfig(...args),
      getEffectiveConfig: (...args: unknown[]) => mockAgentRuntimeGetEffectiveConfig(...args),
    })),
  },
}));

const mockSandboxResultSize = jest.fn();

jest.mock('server/models/AgentSandbox', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => {
      const builder: Record<string, unknown> = {
        resultSize: (...args: unknown[]) => mockSandboxResultSize(...args),
      };
      builder.where = jest.fn(() => builder);
      builder.whereNot = jest.fn(() => builder);
      return builder;
    }),
  },
}));

import AgentSessionConfigService from 'server/services/agentSessionConfig';
import AgentPolicyService from 'server/services/agent/PolicyService';
import { DEFAULT_AGENT_APPROVAL_POLICY } from 'server/services/agent/types';
import { decryptConfigSecret, encryptConfigSecret, isEncryptedConfigSecret } from 'server/lib/encryption';

function makeService() {
  const knex = Object.assign(jest.fn(), {
    fn: {
      now: jest.fn(() => 'now'),
    },
  });

  return new AgentSessionConfigService({ knex } as any, {} as any, {} as any, {} as any);
}

describe('AgentSessionConfigService', () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a01b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b';
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGlobalConfigGetConfig.mockResolvedValue(undefined);
    mockGlobalConfigSetConfig.mockResolvedValue(undefined);
    mockAgentRuntimeGetGlobalConfig.mockResolvedValue({});
    mockAgentRuntimeGetRepoConfig.mockResolvedValue({});
    mockAgentRuntimeGetEffectiveConfig.mockResolvedValue({});
    mockSandboxResultSize.mockResolvedValue(0);
  });

  it('lists admin-visible built-in tools in tool inventory', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({});
    jest.spyOn(service, 'getEffectiveConfig').mockResolvedValue({
      systemPrompt: 'base',
      appendSystemPrompt: 'append',
      maxIterations: 8,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      autoProvisionWorkspace: true,
      toolRules: [],
    });
    jest.spyOn(AgentPolicyService, 'getEffectivePolicy').mockResolvedValue(DEFAULT_AGENT_APPROVAL_POLICY);

    const entries = await service.listToolInventory('global');

    expect(entries.map((entry) => entry.toolName)).toEqual([
      'exec',
      'operation_status',
      'operation_logs',
      'operation_cancel',
      'start_service',
      'service_status',
      'read_file',
      'list_files',
      'glob',
      'grep',
      'apply_patch',
      'edit_file',
      'write_file',
      'publish_http',
      'git_status',
      'git_diff',
      // Debug diagnostic/repair tools: admin per-tool rules must be able to target them.
      'get_build_logs',
      'get_codefresh_logs',
      'get_environment_status',
      'get_file',
      'get_issue_comment',
      'get_k8s_resources',
      'get_lifecycle_logs',
      'get_pod_logs',
      'list_directory',
      'patch_k8s_resource',
      'query_database',
      'trigger_redeploy',
      'update_file',
      'update_pr_labels',
      'validate_lifecycle_config',
    ]);
    expect(entries.find((entry) => entry.toolName === 'get_file')).toEqual(
      expect.objectContaining({
        toolKey: 'mcp__lifecycle__get_file',
        capabilityKey: 'read',
      })
    );
    expect(entries.find((entry) => entry.toolName === 'update_file')).toEqual(
      expect.objectContaining({
        toolKey: 'mcp__lifecycle__update_file',
        capabilityKey: 'git_write',
      })
    );
    expect(entries.find((entry) => entry.toolName === 'skills.list')).toBeUndefined();
    expect(entries.find((entry) => entry.toolName === 'session.get_workspace_state')).toBeUndefined();
    expect(entries.find((entry) => entry.toolName === 'operation_cancel')).toEqual(
      expect.objectContaining({
        toolKey: 'mcp__workspace_core__operation_cancel',
        capabilityKey: 'shell_exec',
        approvalMode: 'require_approval',
        availability: 'available',
      })
    );
    expect(entries.find((entry) => entry.toolName === 'publish_http')).toEqual(
      expect.objectContaining({
        toolKey: 'mcp__workspace_core__publish_http',
        description: 'Publish and verify a workspace HTTP port.',
        serverSlug: 'workspace_core',
        serverName: 'Workspace Core',
        sourceType: 'builtin',
        sourceScope: 'session',
        capabilityKey: 'deploy_k8s_mutation',
        approvalMode: 'require_approval',
        scopeRuleMode: 'inherit',
        effectiveRuleMode: 'inherit',
        availability: 'available',
      })
    );
  });

  it('lists global capability inventory with grouped tools and policy availability', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({});
    jest.spyOn(service, 'getEffectiveConfig').mockResolvedValue({
      systemPrompt: 'base',
      appendSystemPrompt: 'append',
      maxIterations: 8,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      autoProvisionWorkspace: true,
      toolRules: [],
    });
    jest.spyOn(AgentPolicyService, 'getEffectivePolicy').mockResolvedValue(DEFAULT_AGENT_APPROVAL_POLICY);
    mockAgentRuntimeGetGlobalConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          workspace_shell: 'admin_only',
        },
      },
    });
    mockAgentRuntimeGetEffectiveConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          workspace_shell: 'admin_only',
        },
      },
    });

    const entries = await service.listCapabilityInventory('global');
    const shell = entries.find((entry) => entry.capabilityId === 'workspace_shell');
    const githubRead = entries.find((entry) => entry.capabilityId === 'github_read');

    expect(shell).toEqual(
      expect.objectContaining({
        capabilityId: 'workspace_shell',
        configuredAvailability: 'admin_only',
        effectiveAvailability: 'admin_only',
        blockedReason: 'admin_only',
        runtimeCapabilityKey: 'shell_exec',
        resourceGrants: ['workspace_shell'],
      })
    );
    expect(shell?.tools.map((tool) => tool.toolName)).toEqual(expect.arrayContaining(['exec', 'operation_cancel']));
    expect(githubRead).toEqual(
      expect.objectContaining({
        capabilityId: 'github_read',
        toolCount: 3,
        tools: [
          expect.objectContaining({
            toolName: 'github.get_file',
            sourceScope: 'catalog',
          }),
          expect.objectContaining({
            toolName: 'github.list_directory',
            sourceScope: 'catalog',
          }),
          expect.objectContaining({
            toolName: 'github.get_issue_comment',
            sourceScope: 'catalog',
          }),
        ],
      })
    );
  });

  it('lists repo capability inventory with inherited and repo-specific availability', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({});
    jest.spyOn(service, 'getRepoConfig').mockResolvedValue({});
    jest.spyOn(service, 'getEffectiveConfig').mockResolvedValue({
      systemPrompt: 'base',
      appendSystemPrompt: 'append',
      maxIterations: 8,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      autoProvisionWorkspace: true,
      toolRules: [],
    });
    jest.spyOn(AgentPolicyService, 'getEffectivePolicy').mockResolvedValue(DEFAULT_AGENT_APPROVAL_POLICY);
    mockAgentRuntimeGetGlobalConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          external_mcp_write: 'admin_only',
          workspace_shell: 'disabled',
        },
      },
    });
    mockAgentRuntimeGetRepoConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          workspace_shell: 'all_users',
        },
      },
    });
    mockAgentRuntimeGetEffectiveConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          external_mcp_write: 'admin_only',
          workspace_shell: 'all_users',
        },
      },
    });

    const entries = await service.listCapabilityInventory('Example-Org/Example-Repo');
    const shell = entries.find((entry) => entry.capabilityId === 'workspace_shell');
    const externalWrite = entries.find((entry) => entry.capabilityId === 'external_mcp_write');

    expect(shell).toEqual(
      expect.objectContaining({
        configuredAvailability: 'all_users',
        inheritedAvailability: 'disabled',
        effectiveAvailability: 'all_users',
      })
    );
    expect(externalWrite).toEqual(
      expect.objectContaining({
        inheritedAvailability: 'admin_only',
        effectiveAvailability: 'admin_only',
        resourceGrants: ['mcp_write'],
      })
    );
  });

  it('merges repo control-plane numeric overrides over global defaults', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({
      systemPrompt: 'global prompt',
      appendSystemPrompt: 'global append',
      maxIterations: 8,
      maxRunInputTokens: 600_000,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      autoProvisionWorkspace: true,
      toolRules: [],
    });
    jest.spyOn(service, 'getRepoConfig').mockResolvedValue({
      maxIterations: 12,
      maxRunInputTokens: 900_000,
      workspaceToolExecutionTimeoutMs: 45000,
    });

    await expect(service.getEffectiveConfig('example-org/example-repo')).resolves.toEqual({
      systemPrompt: 'global prompt',
      appendSystemPrompt: 'global append',
      maxIterations: 12,
      maxRunInputTokens: 900_000,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 45000,
      autoProvisionWorkspace: true,
      toolRules: [],
    });
  });

  it('preserves persisted max iteration config without a code ceiling', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({
      maxIterations: 9911250,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      toolRules: [],
    });
    jest.spyOn(service, 'getRepoConfig').mockResolvedValue(null);

    await expect(service.getEffectiveConfig('example-org/example-repo')).resolves.toEqual(
      expect.objectContaining({
        maxIterations: 9911250,
      })
    );
  });

  it('accepts high max iteration config when saving control-plane settings', async () => {
    const service = makeService();

    await expect(service.setGlobalConfig({ maxIterations: 101 })).resolves.toEqual(
      expect.objectContaining({
        maxIterations: 101,
      })
    );
    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith(
      'agentSessionDefaults',
      expect.objectContaining({
        controlPlane: expect.objectContaining({
          maxIterations: 101,
        }),
      })
    );
  });

  it('persists require-approval tool overrides in control-plane config', async () => {
    const service = makeService();

    await expect(
      service.setGlobalConfig({
        toolRules: [
          {
            toolKey: 'mcp__workspace_core__read_file',
            mode: 'require_approval',
          },
        ],
      })
    ).resolves.toEqual({
      toolRules: [
        {
          toolKey: 'mcp__workspace_core__read_file',
          mode: 'require_approval',
        },
      ],
    });

    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith('agentSessionDefaults', {
      controlPlane: {
        toolRules: [
          {
            toolKey: 'mcp__workspace_core__read_file',
            mode: 'require_approval',
          },
        ],
      },
    });
  });

  it('returns the effective workspace backend with the api key redacted to a presence flag', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'lifecycle-workspace-pool',
          apiKey: 'super-secret',
        },
      },
    });

    await expect(service.getGlobalRuntimeConfig()).resolves.toEqual({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'lifecycle-workspace-pool',
          apiKeyConfigured: true,
          // opensandbox resolves its image from the workspaceImage fallback like the provisioning paths.
          image: 'workspace-image:v1',
          domain: 'localhost:8080',
          protocol: 'http',
          timeoutSeconds: 3600,
          useServerProxy: true,
          secureAccess: true,
          resourceLimits: { cpu: '2', memory: '4Gi' },
          execdPort: 44772,
          gatewayPort: 13338,
          editorPort: 13337,
        },
        // e2b/daytona/modal ports are env-resolved (not in the PUT schema), so GET omits them.
        e2b: {
          apiKeyConfigured: false,
          domain: 'e2b.app',
          timeoutSeconds: 3600,
          autoPause: true,
        },
        daytona: {
          apiKeyConfigured: false,
          apiUrl: 'https://app.daytona.io/api',
          autoArchiveInterval: 0,
        },
        modal: {
          tokenIdConfigured: false,
          tokenSecretConfigured: false,
          appName: 'lifecycle-workspaces',
          image: 'lifecycleoss/workspace:latest',
          timeoutSeconds: 14400,
        },
      },
    });
  });

  it('redacts the two modal token fields to independent presence flags', async () => {
    const service = makeService();

    // Modal tokens are resolved as a coherent pair: a half-configured DB pair (only tokenId, no env
    // to complete it) is unusable, so both presence flags read false rather than misleadingly showing
    // tokenId as "Configured".
    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'modal',
        modal: { tokenId: 'ak-super-secret' },
      },
    });

    const result = await service.getGlobalRuntimeConfig();

    expect(result.workspaceBackend?.modal).toMatchObject({
      tokenIdConfigured: false,
      tokenSecretConfigured: false,
    });
    expect(JSON.stringify(result)).not.toContain('ak-super-secret');
  });

  it('preserves each stored modal token independently when an update omits it', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'modal',
        modal: { tokenId: 'ak-stored', tokenSecret: 'as-stored', appName: 'custom-app' },
      },
    });

    // Replace only the token secret; the omitted token id must survive (re-encrypted at rest).
    const result = await service.setGlobalRuntimeConfig({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'modal',
        modal: { tokenSecret: 'as-replaced', appName: 'custom-app' },
      },
    });

    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith(
      'agentSessionDefaults',
      expect.objectContaining({
        workspaceBackend: {
          provider: 'modal',
          modal: {
            tokenId: expect.stringMatching(/^lc-enc:v1:/),
            tokenSecret: expect.stringMatching(/^lc-enc:v1:/),
            appName: 'custom-app',
          },
        },
      })
    );
    const persistedModal = mockGlobalConfigSetConfig.mock.calls[0][1].workspaceBackend.modal;
    expect(decryptConfigSecret(persistedModal.tokenId)).toBe('ak-stored');
    expect(decryptConfigSecret(persistedModal.tokenSecret)).toBe('as-replaced');
    expect(result.workspaceBackend?.modal).toEqual({
      appName: 'custom-app',
      tokenIdConfigured: true,
      tokenSecretConfigured: true,
    });
    expect(JSON.stringify(result)).not.toContain('ak-stored');
    expect(JSON.stringify(result)).not.toContain('as-replaced');
  });

  it('redacts e2b and daytona api keys to presence flags in the effective backend', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'e2b',
        e2b: { apiKey: 'e2b-super-secret', templateId: 'lifecycle-workspace' },
        daytona: { apiKey: 'daytona-super-secret', snapshot: 'lifecycle-workspace-1.0' },
      },
    });

    const result = await service.getGlobalRuntimeConfig();

    expect(result.workspaceBackend?.e2b).toMatchObject({ apiKeyConfigured: true, templateId: 'lifecycle-workspace' });
    expect(result.workspaceBackend?.daytona).toMatchObject({
      apiKeyConfigured: true,
      snapshot: 'lifecycle-workspace-1.0',
    });
    expect(JSON.stringify(result)).not.toContain('e2b-super-secret');
    expect(JSON.stringify(result)).not.toContain('daytona-super-secret');
  });

  it('preserves stored e2b and daytona api keys when an update omits them', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'e2b',
        e2b: { apiKey: 'stored-e2b-key', templateId: 'lifecycle-workspace' },
        daytona: { apiKey: 'stored-daytona-key', snapshot: 'lifecycle-workspace-1.0' },
      },
    });

    const result = await service.setGlobalRuntimeConfig({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'daytona',
        e2b: { templateId: 'lifecycle-workspace-v2' },
        daytona: { snapshot: 'lifecycle-workspace-2.0' },
      },
    });

    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith(
      'agentSessionDefaults',
      expect.objectContaining({
        workspaceBackend: {
          provider: 'daytona',
          e2b: { apiKey: expect.stringMatching(/^lc-enc:v1:/), templateId: 'lifecycle-workspace-v2' },
          daytona: { apiKey: expect.stringMatching(/^lc-enc:v1:/), snapshot: 'lifecycle-workspace-2.0' },
        },
      })
    );
    const persistedBackend = mockGlobalConfigSetConfig.mock.calls[0][1].workspaceBackend;
    expect(decryptConfigSecret(persistedBackend.e2b.apiKey)).toBe('stored-e2b-key');
    expect(decryptConfigSecret(persistedBackend.daytona.apiKey)).toBe('stored-daytona-key');
    // The PUT response redacts the preserved keys back to presence flags.
    expect(result.workspaceBackend?.e2b).toEqual({ templateId: 'lifecycle-workspace-v2', apiKeyConfigured: true });
    expect(result.workspaceBackend?.daytona).toEqual({ snapshot: 'lifecycle-workspace-2.0', apiKeyConfigured: true });
    expect(JSON.stringify(result)).not.toContain('stored-e2b-key');
    expect(JSON.stringify(result)).not.toContain('stored-daytona-key');
  });

  it('treats explicit tool rules as effective overrides in the inventory', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({
      toolRules: [
        {
          toolKey: 'mcp__workspace_core__read_file',
          mode: 'allow',
        },
      ],
    });
    jest.spyOn(service, 'getEffectiveConfig').mockResolvedValue({
      systemPrompt: 'base',
      appendSystemPrompt: 'append',
      maxIterations: 8,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      autoProvisionWorkspace: true,
      toolRules: [
        {
          toolKey: 'mcp__workspace_core__read_file',
          mode: 'allow',
        },
      ],
    });
    jest.spyOn(AgentPolicyService, 'getEffectivePolicy').mockResolvedValue({
      ...DEFAULT_AGENT_APPROVAL_POLICY,
      rules: {
        ...DEFAULT_AGENT_APPROVAL_POLICY.rules,
        read: 'deny',
      },
    });

    const entries = await service.listToolInventory('global');
    const readFileEntry = entries.find((entry) => entry.toolName === 'read_file');

    expect(readFileEntry).toEqual(
      expect.objectContaining({
        approvalMode: 'deny',
        scopeRuleMode: 'allow',
        effectiveRuleMode: 'allow',
        availability: 'available',
      })
    );
  });

  it('updates runtime settings without overwriting control-plane settings', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      controlPlane: {
        systemPrompt: 'global prompt',
      },
      workspaceImage: 'old-workspace-image',
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'old-pool',
        },
      },
    });

    await expect(
      service.setGlobalRuntimeConfig({
        workspaceImage: 'workspace-image:v2',
        workspaceEditorImage: 'editor-image:v2',
        workspaceGatewayImage: 'gateway-image:v2',
        scheduling: {
          keepAttachedServicesOnSessionNode: false,
          nodeSelector: {
            pool: 'agents',
          },
        },
        readiness: {
          timeoutMs: 90000,
          pollMs: 1500,
        },
        resources: {
          workspace: {
            requests: {
              cpu: '1',
            },
          },
        },
        workspaceStorage: {
          defaultSize: '20Gi',
          allowedSizes: ['10Gi', '20Gi'],
          allowClientOverride: true,
          accessMode: 'ReadWriteMany',
        },
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
              cpu: '4',
              memory: '8Gi',
            },
            execdPort: 44773,
            gatewayPort: 15555,
            editorPort: 15556,
          },
        },
        cleanup: {
          activeIdleSuspendMs: 60000,
          startingTimeoutMs: 120000,
          hibernatedRetentionMs: 180000,
          intervalMs: 30000,
          redisTtlSeconds: 900,
        },
        durability: {
          runExecutionLeaseMs: 45000,
          queuedRunDispatchStaleMs: 5000,
          dispatchRecoveryLimit: 12,
          maxDurablePayloadBytes: 4096,
          payloadPreviewBytes: 512,
          fileChangePreviewChars: 600,
        },
      })
    ).resolves.toEqual({
      workspaceImage: 'workspace-image:v2',
      workspaceEditorImage: 'editor-image:v2',
      workspaceGatewayImage: 'gateway-image:v2',
      scheduling: {
        keepAttachedServicesOnSessionNode: false,
        nodeSelector: {
          pool: 'agents',
        },
      },
      readiness: {
        timeoutMs: 90000,
        pollMs: 1500,
      },
      resources: {
        workspace: {
          requests: {
            cpu: '1',
          },
        },
      },
      workspaceStorage: {
        defaultSize: '20Gi',
        allowedSizes: ['10Gi', '20Gi'],
        allowClientOverride: true,
        accessMode: 'ReadWriteMany',
      },
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          domain: 'sandbox.local',
          protocol: 'https',
          apiKeyConfigured: true,
          image: 'custom-opensandbox-image:latest',
          poolRef: 'lifecycle-workspace-pool',
          timeoutSeconds: null,
          useServerProxy: false,
          secureAccess: true,
          resourceLimits: {
            cpu: '4',
            memory: '8Gi',
          },
          execdPort: 44773,
          gatewayPort: 15555,
          editorPort: 15556,
        },
      },
      cleanup: {
        activeIdleSuspendMs: 60000,
        startingTimeoutMs: 120000,
        hibernatedRetentionMs: 180000,
        intervalMs: 30000,
        redisTtlSeconds: 900,
      },
      durability: {
        runExecutionLeaseMs: 45000,
        queuedRunDispatchStaleMs: 5000,
        dispatchRecoveryLimit: 12,
        maxDurablePayloadBytes: 4096,
        payloadPreviewBytes: 512,
        fileChangePreviewChars: 600,
      },
    });

    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith('agentSessionDefaults', {
      controlPlane: {
        systemPrompt: 'global prompt',
      },
      workspaceImage: 'workspace-image:v2',
      workspaceEditorImage: 'editor-image:v2',
      workspaceGatewayImage: 'gateway-image:v2',
      scheduling: {
        keepAttachedServicesOnSessionNode: false,
        nodeSelector: {
          pool: 'agents',
        },
      },
      readiness: {
        timeoutMs: 90000,
        pollMs: 1500,
      },
      resources: {
        workspace: {
          requests: {
            cpu: '1',
          },
        },
      },
      workspaceStorage: {
        defaultSize: '20Gi',
        allowedSizes: ['10Gi', '20Gi'],
        allowClientOverride: true,
        accessMode: 'ReadWriteMany',
      },
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          domain: 'sandbox.local',
          protocol: 'https',
          apiKey: expect.stringMatching(/^lc-enc:v1:/),
          image: 'custom-opensandbox-image:latest',
          poolRef: 'lifecycle-workspace-pool',
          timeoutSeconds: null,
          useServerProxy: false,
          secureAccess: true,
          resourceLimits: {
            cpu: '4',
            memory: '8Gi',
          },
          execdPort: 44773,
          gatewayPort: 15555,
          editorPort: 15556,
        },
      },
      cleanup: {
        activeIdleSuspendMs: 60000,
        startingTimeoutMs: 120000,
        hibernatedRetentionMs: 180000,
        intervalMs: 30000,
        redisTtlSeconds: 900,
      },
      durability: {
        runExecutionLeaseMs: 45000,
        queuedRunDispatchStaleMs: 5000,
        dispatchRecoveryLimit: 12,
        maxDurablePayloadBytes: 4096,
        payloadPreviewBytes: 512,
        fileChangePreviewChars: 600,
      },
    });
    // Encrypted at rest, round-trips to the submitted key.
    const persistedOpensandbox = mockGlobalConfigSetConfig.mock.calls[0][1].workspaceBackend.opensandbox;
    expect(isEncryptedConfigSecret(persistedOpensandbox.apiKey)).toBe(true);
    expect(decryptConfigSecret(persistedOpensandbox.apiKey)).toBe('test-api-key');
  });

  it('preserves persisted workspace backend settings when a runtime replacement omits them', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      controlPlane: {
        systemPrompt: 'global prompt',
      },
      workspaceImage: 'old-workspace-image',
      workspaceEditorImage: 'old-editor-image',
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'old-pool',
        },
      },
    });

    // Merge-not-replace: omitting workspaceBackend must not delete the stored configuration.
    await expect(
      service.setGlobalRuntimeConfig({
        workspaceImage: 'workspace-image:v2',
        workspaceEditorImage: 'editor-image:v2',
      })
    ).resolves.toEqual({
      workspaceImage: 'workspace-image:v2',
      workspaceEditorImage: 'editor-image:v2',
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'old-pool',
          apiKeyConfigured: false,
        },
      },
    });

    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith('agentSessionDefaults', {
      controlPlane: {
        systemPrompt: 'global prompt',
      },
      workspaceImage: 'workspace-image:v2',
      workspaceEditorImage: 'editor-image:v2',
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'old-pool',
        },
      },
    });
  });

  it('preserves stored backend blocks not present in the update and keeps stored ciphertext untouched', async () => {
    const service = makeService();
    const storedCiphertext = encryptConfigSecret('stored-e2b-key');

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'e2b',
        e2b: { apiKey: storedCiphertext, templateId: 'lifecycle-workspace' },
        daytona: { apiKey: encryptConfigSecret('stored-daytona-key'), snapshot: 'lifecycle-workspace-1.0' },
      },
    });

    // Only the daytona block rides this PUT; the e2b block (and its ciphertext) must survive byte-for-byte.
    await service.setGlobalRuntimeConfig({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        daytona: { snapshot: 'lifecycle-workspace-2.0' },
      },
    });

    const persistedBackend = mockGlobalConfigSetConfig.mock.calls[0][1].workspaceBackend;
    expect(persistedBackend.provider).toBe('e2b');
    expect(persistedBackend.e2b).toEqual({ apiKey: storedCiphertext, templateId: 'lifecycle-workspace' });
    expect(persistedBackend.daytona.snapshot).toBe('lifecycle-workspace-2.0');
    expect(decryptConfigSecret(persistedBackend.daytona.apiKey)).toBe('stored-daytona-key');
  });

  it('removes a stored backend block on an explicit null sentinel when no sandboxes reference it', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'lifecycle_kubernetes',
        e2b: { apiKey: encryptConfigSecret('stored-e2b-key'), templateId: 'lifecycle-workspace' },
      },
    });
    mockSandboxResultSize.mockResolvedValue(0);

    const result = await service.setGlobalRuntimeConfig({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: { e2b: null },
    } as any);

    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith(
      'agentSessionDefaults',
      expect.objectContaining({
        workspaceBackend: { provider: 'lifecycle_kubernetes' },
      })
    );
    expect(result.workspaceBackend).toEqual({ provider: 'lifecycle_kubernetes' });
  });

  it('refuses a null removal sentinel while non-ended sandboxes still reference that provider', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        provider: 'lifecycle_kubernetes',
        e2b: { apiKey: encryptConfigSecret('stored-e2b-key'), templateId: 'lifecycle-workspace' },
      },
    });
    mockSandboxResultSize.mockResolvedValue(2);

    await expect(
      service.setGlobalRuntimeConfig({
        workspaceImage: 'workspace-image:v1',
        workspaceEditorImage: 'editor-image:v1',
        workspaceBackend: { e2b: null },
      } as any)
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'workspace_backend_in_use',
      message: expect.stringContaining('2 workspace sandbox(es)'),
    });
    expect(mockGlobalConfigSetConfig).not.toHaveBeenCalled();
  });

  it('rejects selecting a provider that is unconfigured against the merged stored+env config', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
    });

    await expect(
      service.setGlobalRuntimeConfig({
        workspaceImage: 'workspace-image:v1',
        workspaceEditorImage: 'editor-image:v1',
        workspaceBackend: { provider: 'e2b' },
      })
    ).rejects.toThrow('The E2B workspace backend is not configured. Missing required fields: apiKey, templateId.');
    expect(mockGlobalConfigSetConfig).not.toHaveBeenCalled();
  });

  it('accepts configure-and-select in a single update validated against the merged result', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: {
        e2b: { apiKey: encryptConfigSecret('stored-e2b-key'), templateId: 'lifecycle-workspace' },
      },
    });

    // Selecting e2b is valid because the stored block completes the merged config.
    const result = await service.setGlobalRuntimeConfig({
      workspaceImage: 'workspace-image:v1',
      workspaceEditorImage: 'editor-image:v1',
      workspaceBackend: { provider: 'e2b' },
    });

    expect(result.workspaceBackend?.provider).toBe('e2b');
    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith(
      'agentSessionDefaults',
      expect.objectContaining({
        workspaceBackend: expect.objectContaining({ provider: 'e2b' }),
      })
    );
  });

  it('rejects runtime updates that remove the required workspace images', async () => {
    const service = makeService();

    mockGlobalConfigGetConfig.mockResolvedValue({
      controlPlane: {
        systemPrompt: 'global prompt',
      },
      workspaceImage: 'old-workspace-image',
      workspaceEditorImage: 'old-editor-image',
    });

    await expect(
      service.setGlobalRuntimeConfig({
        readiness: {
          timeoutMs: 90000,
        },
      })
    ).rejects.toThrow('Missing required runtime fields: workspaceImage, workspaceEditorImage.');

    expect(mockGlobalConfigSetConfig).not.toHaveBeenCalled();
  });
});
