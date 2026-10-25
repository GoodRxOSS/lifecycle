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

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

import {
  canDiscoverWorkspaceMcp,
  resolveWorkspaceMcpAdmission,
  workspaceMcpApprovalMode,
} from '../workspaceMcpAdmission';
import { DEFAULT_AGENT_APPROVAL_POLICY, type AgentApprovalMode } from '../types';
import type { AgentDefinitionOwnerKind } from '../agentDefinitionTypes';
import type { AgentCapabilityAvailability } from '../capabilityCatalog';
import { buildAgentToolKey } from '../toolKeys';

const fallbackOptions = {
  resolvedCapabilityAccess: [
    { capabilityId: 'workspace_shell', allowed: true },
    { capabilityId: 'external_mcp_read', allowed: true },
  ],
  definitionOwnerKind: 'system' as const,
  sourceKind: 'workspace_session',
  approvalPolicy: DEFAULT_AGENT_APPROVAL_POLICY,
};

function policy(modes: Partial<typeof DEFAULT_AGENT_APPROVAL_POLICY.rules>) {
  return { ...DEFAULT_AGENT_APPROVAL_POLICY, rules: { ...DEFAULT_AGENT_APPROVAL_POLICY.rules, ...modes } };
}

describe('workspace MCP admission', () => {
  it('borrows declared workspace command and MCP-read authority without admitting remote write', () => {
    expect(resolveWorkspaceMcpAdmission(fallbackOptions)).toEqual({
      catalogCapabilityId: 'workspace_shell',
      approvalCapabilities: ['external_mcp_write', 'shell_exec', 'external_mcp_read'],
    });
  });

  it.each([
    { resolvedCapabilityAccess: undefined },
    { resolvedCapabilityAccess: [{ capabilityId: 'workspace_shell', allowed: true }] },
    { resolvedCapabilityAccess: [{ capabilityId: 'external_mcp_read', allowed: true }] },
    {
      resolvedCapabilityAccess: [
        { capabilityId: 'workspace_shell', allowed: false },
        { capabilityId: 'external_mcp_read', allowed: true },
      ],
    },
    { definitionOwnerKind: undefined },
    { sourceKind: undefined },
    { sourceKind: 'build_context_chat' },
    { sourceKind: 'unrecognized' },
  ])('fails closed with missing or incompatible fallback authority: %j', (options) => {
    expect(resolveWorkspaceMcpAdmission({ ...fallbackOptions, ...options })).toBeNull();
  });

  it.each([
    ['system', 'admin_only', true],
    ['admin', 'admin_only', true],
    ['user', 'admin_only', false],
    ['user', 'all_users', true],
    ['admin', 'system_only', false],
    ['system', 'system_only', true],
    ['system', 'disabled', false],
  ] as [AgentDefinitionOwnerKind, AgentCapabilityAvailability, boolean][])(
    'uses definition ownership %s with write availability %s',
    (definitionOwnerKind, availability, admitted) => {
      expect(
        Boolean(
          resolveWorkspaceMcpAdmission({
            ...fallbackOptions,
            definitionOwnerKind,
            capabilityPolicy: { availability: { external_mcp_write: availability } },
          })
        )
      ).toBe(admitted);
    }
  );

  it('respects creator-reserved write capability even when all users may use it', () => {
    expect(
      resolveWorkspaceMcpAdmission({
        ...fallbackOptions,
        definitionOwnerKind: 'user',
        capabilityPolicy: { availability: { external_mcp_write: 'all_users' } },
        customAgentCreationPolicy: { capabilityAvailability: { external_mcp_write: 'reserved' } },
      })
    ).toBeNull();
  });

  it('preserves explicit write admission without requiring a shell or new definition context', () => {
    const approvalPolicy = policy({ external_mcp_write: 'allow', shell_exec: 'deny', external_mcp_read: 'deny' });
    const admission = resolveWorkspaceMcpAdmission({
      resolvedCapabilityAccess: [{ capabilityId: 'external_mcp_write', allowed: true }],
      approvalPolicy,
    });
    expect(admission).toEqual({
      catalogCapabilityId: 'external_mcp_write',
      approvalCapabilities: ['external_mcp_write'],
    });
    expect(workspaceMcpApprovalMode(admission!, approvalPolicy)).toBe('allow');
    expect(canDiscoverWorkspaceMcp(admission, 'sample', approvalPolicy)).toBe(true);
  });

  it('never starts discovery when current write availability is disabled, including exact allow rules', () => {
    const admission = resolveWorkspaceMcpAdmission({
      ...fallbackOptions,
      resolvedCapabilityAccess: [{ capabilityId: 'external_mcp_write', allowed: true }],
      capabilityPolicy: { availability: { external_mcp_write: 'disabled' } },
    });
    expect(admission).toBeNull();
    expect(
      canDiscoverWorkspaceMcp(admission, 'sample', DEFAULT_AGENT_APPROVAL_POLICY, [
        { toolKey: 'mcp__sample__write', mode: 'allow' },
      ])
    ).toBe(false);
  });

  it.each(['external_mcp_write', 'shell_exec', 'external_mcp_read'] as const)(
    'honors %s deny before discovery unless the server has an exact exception',
    (capability) => {
      const approvalPolicy = policy({
        external_mcp_write: 'allow',
        shell_exec: 'allow',
        external_mcp_read: 'allow',
        [capability]: 'deny',
      });
      const admission = resolveWorkspaceMcpAdmission({ ...fallbackOptions, approvalPolicy })!;
      const key = buildAgentToolKey('sample-service', 'do_work');
      expect(workspaceMcpApprovalMode(admission, approvalPolicy)).toBe('deny');
      expect(canDiscoverWorkspaceMcp(admission, 'sample-service', approvalPolicy)).toBe(false);
      expect(
        canDiscoverWorkspaceMcp(admission, 'sample-service', approvalPolicy, [
          { toolKey: 'mcp__other__do_work', mode: 'allow' },
        ])
      ).toBe(false);
      for (const mode of ['allow', 'require_approval'] as AgentApprovalMode[]) {
        const rules = [{ toolKey: key, mode }];
        expect(canDiscoverWorkspaceMcp(admission, 'sample-service', approvalPolicy, rules)).toBe(true);
        expect(workspaceMcpApprovalMode(admission, approvalPolicy, rules, key)).toBe(mode);
        expect(workspaceMcpApprovalMode(admission, approvalPolicy, rules, 'mcp__sample_service__other')).toBe('deny');
      }
    }
  );

  it('takes the strictest fallback approval mode while preserving exact rule precedence', () => {
    const admission = resolveWorkspaceMcpAdmission(fallbackOptions)!;
    expect(workspaceMcpApprovalMode(admission, policy({ external_mcp_write: 'allow' }))).toBe('require_approval');
    expect(workspaceMcpApprovalMode(admission, policy({ external_mcp_write: 'allow', shell_exec: 'allow' }))).toBe(
      'allow'
    );
    expect(
      workspaceMcpApprovalMode(
        admission,
        DEFAULT_AGENT_APPROVAL_POLICY,
        [{ toolKey: 'mcp__sample__write', mode: 'allow' }],
        'mcp__sample__write'
      )
    ).toBe('allow');
    expect(
      workspaceMcpApprovalMode(
        admission,
        policy({ external_mcp_write: 'allow', shell_exec: 'allow' }),
        [{ toolKey: 'mcp__sample__write', mode: 'deny' }],
        'mcp__sample__write'
      )
    ).toBe('deny');
  });

  it('keeps first-rule precedence and rejects empty tool names for discovery exceptions', () => {
    const admission = resolveWorkspaceMcpAdmission(fallbackOptions)!;
    const approvalPolicy = policy({ external_mcp_write: 'deny' });
    expect(
      canDiscoverWorkspaceMcp(admission, 'sample', approvalPolicy, [
        { toolKey: 'mcp__sample__write', mode: 'deny' },
        { toolKey: 'mcp__sample__write', mode: 'allow' },
        { toolKey: 'mcp__sample__', mode: 'allow' },
      ])
    ).toBe(false);
  });
});
