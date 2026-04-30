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

import AgentSessionConfigService from 'server/services/agentSessionConfig';
import AgentPolicyService from 'server/services/agent/PolicyService';
import { DEFAULT_AGENT_APPROVAL_POLICY } from 'server/services/agent/types';

function makeService() {
  const knex = Object.assign(jest.fn(), {
    fn: {
      now: jest.fn(() => 'now'),
    },
  });

  return new AgentSessionConfigService({ knex } as any, {} as any, {} as any, {} as any);
}

describe('AgentSessionConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGlobalConfigGetConfig.mockResolvedValue(undefined);
    mockGlobalConfigSetConfig.mockResolvedValue(undefined);
    mockAgentRuntimeGetGlobalConfig.mockResolvedValue({});
    mockAgentRuntimeGetRepoConfig.mockResolvedValue({});
    mockAgentRuntimeGetEffectiveConfig.mockResolvedValue({});
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
      toolRules: [],
    });
    jest.spyOn(AgentPolicyService, 'getEffectivePolicy').mockResolvedValue(DEFAULT_AGENT_APPROVAL_POLICY);

    const entries = await service.listToolInventory('global');

    expect(entries.map((entry) => entry.toolName)).toEqual([
      'workspace.read_file',
      'workspace.glob',
      'workspace.grep',
      'workspace.exec',
      'git.status',
      'git.diff',
      'workspace.write_file',
      'workspace.edit_file',
      'workspace.exec_mutation',
      'git.add',
      'git.commit',
      'git.branch',
      'publish_http',
    ]);
    expect(entries.find((entry) => entry.toolName === 'skills.list')).toBeUndefined();
    expect(entries.find((entry) => entry.toolName === 'session.get_workspace_state')).toBeUndefined();
    expect(entries.find((entry) => entry.toolName === 'publish_http')).toEqual(
      expect.objectContaining({
        toolKey: 'mcp__lifecycle__publish_http',
        serverSlug: 'lifecycle',
        serverName: 'Lifecycle',
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
    expect(shell?.tools.map((tool) => tool.toolName)).toEqual(expect.arrayContaining(['workspace.exec_mutation']));
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
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      toolRules: [],
    });
    jest.spyOn(service, 'getRepoConfig').mockResolvedValue({
      maxIterations: 12,
      workspaceToolExecutionTimeoutMs: 45000,
    });

    await expect(service.getEffectiveConfig('example-org/example-repo')).resolves.toEqual({
      systemPrompt: 'global prompt',
      appendSystemPrompt: 'global append',
      maxIterations: 12,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 45000,
      toolRules: [],
    });
  });

  it('persists require-approval tool overrides in control-plane config', async () => {
    const service = makeService();

    await expect(
      service.setGlobalConfig({
        toolRules: [
          {
            toolKey: 'mcp__sandbox__workspace_read_file',
            mode: 'require_approval',
          },
        ],
      })
    ).resolves.toEqual({
      toolRules: [
        {
          toolKey: 'mcp__sandbox__workspace_read_file',
          mode: 'require_approval',
        },
      ],
    });

    expect(mockGlobalConfigSetConfig).toHaveBeenCalledWith('agentSessionDefaults', {
      controlPlane: {
        toolRules: [
          {
            toolKey: 'mcp__sandbox__workspace_read_file',
            mode: 'require_approval',
          },
        ],
      },
    });
  });

  it('treats explicit tool rules as effective overrides in the inventory', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({
      toolRules: [
        {
          toolKey: 'mcp__sandbox__workspace_read_file',
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
      toolRules: [
        {
          toolKey: 'mcp__sandbox__workspace_read_file',
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
    const readFileEntry = entries.find((entry) => entry.toolName === 'workspace.read_file');

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
