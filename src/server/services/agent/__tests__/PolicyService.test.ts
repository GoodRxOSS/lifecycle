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

const mockGetEffectiveConfig = jest.fn();

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: mockGetEffectiveConfig,
    })),
  },
}));

import AgentPolicyService from '../PolicyService';
import { AGENT_CAPABILITY_KEYS, DEFAULT_AGENT_APPROVAL_POLICY } from '../types';

describe('AgentPolicyService', () => {
  beforeEach(() => {
    mockGetEffectiveConfig.mockReset();
  });

  it('keeps read-only sandbox tools in the read capability', () => {
    expect(
      AgentPolicyService.capabilityForSessionWorkspaceTool('workspace.read_file', {
        readOnlyHint: true,
      })
    ).toBe('read');
  });

  it('keeps session git helpers in the git write capability', () => {
    expect(AgentPolicyService.capabilityForSessionWorkspaceTool('git.branch')).toBe('git_write');
  });

  it('maps read-only external MCP tools to external_mcp_read', () => {
    expect(
      AgentPolicyService.capabilityForExternalMcpTool('getJiraIssue', {
        readOnlyHint: true,
      })
    ).toBe('external_mcp_read');
  });

  it('maps mutating external MCP tools to external_mcp_write without workspace heuristics', () => {
    expect(AgentPolicyService.capabilityForExternalMcpTool('editJiraIssue')).toBe('external_mcp_write');
  });

  it('requires approval for deployment mutations by default', () => {
    expect(AgentPolicyService.modeForCapability(DEFAULT_AGENT_APPROVAL_POLICY, 'deploy_k8s_mutation')).toBe(
      'require_approval'
    );
  });

  it('keeps system approval modes when no approval default is configured', async () => {
    mockGetEffectiveConfig.mockResolvedValue({
      approvalPolicy: {
        rules: {
          shell_exec: 'allow',
        },
      },
    });

    await expect(AgentPolicyService.getEffectivePolicy()).resolves.toEqual({
      defaultMode: DEFAULT_AGENT_APPROVAL_POLICY.defaultMode,
      rules: {
        ...DEFAULT_AGENT_APPROVAL_POLICY.rules,
        shell_exec: 'allow',
      },
    });
  });

  it('uses an explicit approval default as the fallback for known capability families', async () => {
    mockGetEffectiveConfig.mockResolvedValue({
      approvalPolicy: {
        defaultMode: 'deny',
        rules: {
          shell_exec: 'allow',
        },
      },
    });

    await expect(AgentPolicyService.getEffectivePolicy()).resolves.toEqual({
      defaultMode: 'deny',
      rules: {
        ...Object.fromEntries(AGENT_CAPABILITY_KEYS.map((capabilityKey) => [capabilityKey, 'deny'])),
        shell_exec: 'allow',
      },
    });
  });

  it('allows all user-owned definitions to use all-users capabilities', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'workspace_files',
      definitionOwnerKind: 'user',
      sourceKind: 'workspace_session',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        effectiveAvailability: 'all_users',
        approvalMode: 'require_approval',
      })
    );
  });

  it('blocks disabled capabilities for every definition owner', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'read_context',
      capabilityPolicy: {
        availability: {
          read_context: 'disabled',
        },
      },
      definitionOwnerKind: 'system',
      sourceKind: 'freeform_chat',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: 'disabled',
        effectiveAvailability: 'disabled',
      })
    );
  });

  it('blocks system-only capabilities for non-system definitions', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'diagnostics_database',
      definitionOwnerKind: 'admin',
      requesterIsAdmin: true,
      sourceKind: 'build_context_chat',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: 'system_only',
        effectiveAvailability: 'system_only',
      })
    );
  });

  it('allows system-owned definitions to use system-only capabilities', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'diagnostics_kubernetes',
      definitionOwnerKind: 'system',
      sourceKind: 'build_context_chat',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        effectiveAvailability: 'system_only',
        approvalMode: 'allow',
      })
    );
  });

  it('blocks user-owned definitions from admin-only capabilities', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'external_mcp_write',
      definitionOwnerKind: 'user',
      sourceKind: 'freeform_chat',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: 'admin_only',
        effectiveAvailability: 'admin_only',
      })
    );
  });

  it('allows admin-owned definitions to use admin-only capabilities', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'external_mcp_write',
      definitionOwnerKind: 'admin',
      requesterIsAdmin: true,
      sourceKind: 'workspace_session',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        effectiveAvailability: 'admin_only',
      })
    );
  });

  it('uses configured availability over catalog defaults', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'diagnostics_codefresh',
      capabilityPolicy: {
        availability: {
          diagnostics_codefresh: 'all_users',
        },
      },
      definitionOwnerKind: 'user',
      sourceKind: 'build_context_chat',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        configuredAvailability: 'all_users',
        effectiveAvailability: 'all_users',
      })
    );
  });

  it('blocks user-owned definitions from creator-reserved capabilities even when runtime policy allows them', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'workspace_files',
      capabilityPolicy: {
        availability: {
          workspace_files: 'all_users',
        },
      },
      customAgentCreationPolicy: {
        capabilityAvailability: {
          workspace_files: 'reserved',
        },
      },
      definitionOwnerKind: 'user',
      sourceKind: 'workspace_session',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: 'creator_capability_reserved',
        effectiveAvailability: 'all_users',
      })
    );
  });

  it('does not apply creator-reserved policy to system-owned definitions', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'diagnostics_kubernetes',
      customAgentCreationPolicy: {
        capabilityAvailability: {
          diagnostics_kubernetes: 'reserved',
        },
      },
      definitionOwnerKind: 'system',
      sourceKind: 'build_context_chat',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        effectiveAvailability: 'system_only',
      })
    );
  });

  it('keeps prompt-policy boundaries code-owned for Debug capabilities', () => {
    const debugWriteAccess = AgentPolicyService.resolveCapabilitySetAccess(['github_write', 'external_mcp_write'], {
      definitionOwnerKind: 'system',
      sourceKind: 'build_context_chat',
    });

    expect(debugWriteAccess).toEqual([
      expect.objectContaining({
        capabilityId: 'github_write',
        allowed: true,
        effectiveAvailability: 'system_only',
        approvalMode: 'require_approval',
      }),
      expect.objectContaining({
        capabilityId: 'external_mcp_write',
        allowed: true,
        effectiveAvailability: 'admin_only',
        approvalMode: 'require_approval',
      }),
    ]);

    const userDiagnosticAccess = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'diagnostics_codefresh',
      definitionOwnerKind: 'user',
      sourceKind: 'build_context_chat',
    });

    expect(userDiagnosticAccess).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: 'system_only',
        effectiveAvailability: 'system_only',
      })
    );
  });

  it('derives approval mode from mapped runtime approval policy', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'workspace_shell',
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          ...DEFAULT_AGENT_APPROVAL_POLICY.rules,
          shell_exec: 'deny',
        },
      },
      definitionOwnerKind: 'user',
      sourceKind: 'workspace_session',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        approvalMode: 'deny',
      })
    );
  });

  it('blocks source-incompatible capabilities', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'workspace_shell',
      definitionOwnerKind: 'user',
      sourceKind: 'freeform_chat',
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: 'source_incompatible',
      })
    );
  });

  it('blocks unknown capability ids', () => {
    const result = AgentPolicyService.resolveCapabilityAccess({
      capabilityId: 'sample_unknown',
      definitionOwnerKind: 'system',
    });

    expect(result).toEqual({
      capabilityId: 'sample_unknown',
      allowed: false,
      reason: 'unknown_capability',
    });
  });

  it('resolves capability sets in input order', () => {
    const result = AgentPolicyService.resolveCapabilitySetAccess(['read_context', 'external_mcp_write'], {
      definitionOwnerKind: 'user',
      sourceKind: 'freeform_chat',
    });

    expect(result.map((entry) => entry.capabilityId)).toEqual(['read_context', 'external_mcp_write']);
    expect(result.map((entry) => entry.allowed)).toEqual([true, false]);
  });
});
