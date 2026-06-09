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

import type { AgentCapabilityCatalogId } from '../capabilityCatalog';
import {
  mapLegacyAgentCapabilitiesToV2,
  resolveAgentHarnessV2ProfileCapabilities,
  type AgentHarnessV2Capability,
  type AgentHarnessV2CapabilityState,
} from '../profileCapabilityResolver';
import type { AgentDebugRunIntent, AgentRunPlanSnapshotV1 } from '../runPlanTypes';

function debugRunPlan(intent: AgentDebugRunIntent = 'diagnose'): AgentRunPlanSnapshotV1 {
  const capabilityIds: AgentCapabilityCatalogId[] = [
    'diagnostics_logs',
    'diagnostics_codefresh',
    'diagnostics_kubernetes',
    'diagnostics_database',
    'github_read',
    'github_write',
    'external_mcp_read',
  ];

  return {
    version: 1,
    capturedAt: '2026-06-29T00:00:00.000Z',
    agent: {
      id: 'system.debug',
      label: 'Debug',
      sourceKind: 'build_context_chat',
    },
    source: {
      buildUuid: 'sample-build-1',
      namespace: 'env-sample-build-1',
      freshness: {
        capturedAt: '2026-06-29T00:00:00.000Z',
        freshnessSource: 'source',
      },
    },
    model: {
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
    },
    runtime: {
      resolvedHarness: 'lifecycle_ai_sdk',
      sandboxRequirement: {},
      runtimeOptions: {},
      approvalPolicy: {
        defaultMode: 'require_approval',
        rules: {
          read: 'allow',
          external_mcp_read: 'allow',
          git_write: 'require_approval',
          deploy_k8s_mutation: 'require_approval',
        },
      },
    },
    prompt: {
      instructionRefs: ['system:debug'],
      renderedSummary: 'Debug',
      renderedHash: 'sha256:debug',
    },
    capabilities: {
      provisionalCapabilityIds: capabilityIds,
      resolvedCapabilityAccess: capabilityIds.map((capabilityId) => ({
        capabilityId,
        availability:
          capabilityId === 'external_mcp_read' || capabilityId === 'github_read' ? 'all_users' : 'system_only',
        allowed: true,
        approvalMode: capabilityId === 'github_write' ? 'require_approval' : 'allow',
      })),
    },
    debug: {
      requestedIntent: intent,
      resolvedIntent: intent,
      decisionSource: 'client_request',
      reasonCode: 'test',
    },
    warnings: [],
  };
}

function capabilityStates(
  runPlanSnapshot: AgentRunPlanSnapshotV1,
  workspaceCoreRequested = false
): Record<AgentHarnessV2Capability, AgentHarnessV2CapabilityState | undefined> {
  const result = resolveAgentHarnessV2ProfileCapabilities({
    runPlanSnapshot,
    workspaceCoreRequested,
  });

  return Object.fromEntries(result.capabilities.map((capability) => [capability.name, capability.state])) as Record<
    AgentHarnessV2Capability,
    AgentHarnessV2CapabilityState | undefined
  >;
}

describe('profileCapabilityResolver', () => {
  it('maps legacy capability ids to v2 capability names without changing legacy ids', () => {
    expect(
      mapLegacyAgentCapabilitiesToV2([
        'read_context',
        'diagnostics_logs',
        'diagnostics_kubernetes',
        'github_write',
        'workspace_files',
        'workspace_shell',
        'workspace_git',
        'network_access',
        'preview_publish',
        'external_mcp_read',
        'external_mcp_write',
      ])
    ).toEqual([
      'context.read',
      'diagnostics.read',
      'diagnostics.lifecycle_read',
      'source_control.remote_write',
      'workspace.read',
      'workspace.write',
      'workspace.exec',
      'workspace.network',
      'workspace.preview',
      'external_mcp.read',
      'external_mcp.write',
    ]);
  });

  it('resolves build-context Debug diagnose as a read-only debug profile with workspace_core absent', () => {
    const result = resolveAgentHarnessV2ProfileCapabilities({ runPlanSnapshot: debugRunPlan('diagnose') });
    const states = capabilityStates(debugRunPlan('diagnose'));

    expect(result.profile).toEqual({ kind: 'debug', intent: 'diagnose' });
    expect(result.workspaceCore).toBe('absent');
    expect(states['context.read']).toBe('active');
    expect(states['diagnostics.read']).toBe('active');
    expect(states['diagnostics.lifecycle_read']).toBe('active');
    expect(states['external_mcp.read']).toBe('active');
    expect(states['source_control.remote_write']).toBeUndefined();
    expect(states['deployment.write']).toBeUndefined();
    expect(states['workspace.request']).toBeUndefined();
    expect(states['workspace.read']).toBeUndefined();
  });

  it('resolves build-context Debug repair with current repair writes approval-gated and no workspace_core', () => {
    const result = resolveAgentHarnessV2ProfileCapabilities({ runPlanSnapshot: debugRunPlan('repair') });
    const states = capabilityStates(debugRunPlan('repair'));

    expect(result.profile).toEqual({ kind: 'debug', intent: 'repair' });
    expect(result.workspaceCore).toBe('absent');
    expect(states['context.read']).toBe('active');
    expect(states['diagnostics.lifecycle_read']).toBe('active');
    expect(states['source_control.remote_write']).toBe('approval_required');
    expect(states['deployment.write']).toBe('approval_required');
    expect(states['workspace.request']).toBeUndefined();
    expect(states['workspace.write']).toBeUndefined();
    expect(states['workspace.exec']).toBeUndefined();
  });

  it('keeps workspace_core absent until explicit request activates workspace request/read capabilities', () => {
    const absent = resolveAgentHarnessV2ProfileCapabilities({ runPlanSnapshot: debugRunPlan('diagnose') });
    const requested = resolveAgentHarnessV2ProfileCapabilities({
      runPlanSnapshot: debugRunPlan('diagnose'),
      workspaceCoreRequested: true,
    });

    expect(absent.workspaceCore).toBe('absent');
    expect(absent.capabilities.map((capability) => capability.name)).not.toEqual(
      expect.arrayContaining(['workspace.request', 'workspace.read'])
    );
    expect(requested.workspaceCore).toBe('requested');
    expect(capabilityStates(debugRunPlan('diagnose'), true)).toEqual(
      expect.objectContaining({
        'workspace.request': 'active',
        'workspace.read': 'available',
      })
    );
  });
});
