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

jest.mock('server/services/ai/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    listEffectiveDefinitions: jest.fn().mockResolvedValue([]),
  })),
}));

const mockGlobalConfigGetConfig = jest.fn();
const mockGlobalConfigSetConfig = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGlobalConfigGetConfig(...args),
      setConfig: (...args: unknown[]) => mockGlobalConfigSetConfig(...args),
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
  });

  it('lists only admin-visible sandbox tools in tool inventory', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({});
    jest.spyOn(service, 'getEffectiveConfig').mockResolvedValue({
      systemPrompt: 'base',
      appendSystemPrompt: 'append',
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
    ]);
    expect(entries.find((entry) => entry.toolName === 'skills.list')).toBeUndefined();
    expect(entries.find((entry) => entry.toolName === 'session.get_workspace_state')).toBeUndefined();
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
