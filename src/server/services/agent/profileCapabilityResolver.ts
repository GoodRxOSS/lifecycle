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

import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import type {
  AgentDebugRunIntent,
  AgentRunPlanProfileIntent,
  AgentRunPlanProfileSnapshot,
  AgentRunPlanSnapshotV1,
} from './runPlanTypes';

export const AGENT_HARNESS_V2_CAPABILITIES = [
  'context.read',
  'workspace.request',
  'workspace.read',
  'workspace.write',
  'workspace.exec',
  'workspace.network',
  'workspace.preview',
  'workspace.git_local_write',
  'source_control.remote_write',
  'diagnostics.read',
  'diagnostics.lifecycle_read',
  'deployment.write',
  'external_mcp.read',
  'external_mcp.write',
] as const;

export type AgentHarnessV2Capability = (typeof AGENT_HARNESS_V2_CAPABILITIES)[number];
export type AgentHarnessV2CapabilityState =
  | 'inactive'
  | 'available'
  | 'approval_required'
  | 'active'
  | 'denied'
  | 'exhausted';
export type AgentHarnessV2DebugIntent = Exclude<AgentDebugRunIntent, 'investigate'>;
export type AgentHarnessV2WorkspaceCoreState = 'absent' | 'requested';

export type AgentHarnessV2Profile =
  | {
      kind: 'answer';
      intent: 'chat';
    }
  | {
      kind: 'debug';
      intent: AgentHarnessV2DebugIntent;
    }
  | {
      kind: 'change';
      intent: 'workspace';
    }
  | {
      kind: 'legacy';
      intent: 'legacy';
    };

export type AgentHarnessV2CapabilityResolution = {
  name: AgentHarnessV2Capability;
  state: AgentHarnessV2CapabilityState;
  legacyCapabilityIds: AgentCapabilityCatalogId[];
};

export type AgentHarnessV2ProfileCapabilityResolution = {
  profile: AgentHarnessV2Profile;
  workspaceCore: AgentHarnessV2WorkspaceCoreState;
  capabilities: AgentHarnessV2CapabilityResolution[];
};

export const LEGACY_AGENT_CAPABILITY_TO_V2_CAPABILITIES = {
  read_context: ['context.read'],
  diagnostics_logs: ['diagnostics.read', 'diagnostics.lifecycle_read'],
  diagnostics_codefresh: ['diagnostics.read', 'diagnostics.lifecycle_read'],
  diagnostics_kubernetes: ['diagnostics.read', 'diagnostics.lifecycle_read'],
  diagnostics_database: ['diagnostics.read', 'diagnostics.lifecycle_read'],
  github_read: ['context.read', 'diagnostics.lifecycle_read'],
  github_write: ['source_control.remote_write'],
  workspace_files: ['workspace.read', 'workspace.write'],
  workspace_shell: ['workspace.exec'],
  workspace_git: ['workspace.read'],
  network_access: ['workspace.network'],
  preview_publish: ['workspace.preview'],
  external_mcp_read: ['external_mcp.read'],
  external_mcp_write: ['external_mcp.write'],
  approval_controls: [],
} as const satisfies Record<AgentCapabilityCatalogId, readonly AgentHarnessV2Capability[]>;

const DEBUG_DIAGNOSE_ACTIVE_CAPABILITIES = [
  'context.read',
  'diagnostics.read',
  'diagnostics.lifecycle_read',
] as const satisfies readonly AgentHarnessV2Capability[];

const WORKSPACE_CORE_REQUEST_CAPABILITIES = [
  'workspace.request',
  'workspace.read',
] as const satisfies readonly AgentHarnessV2Capability[];

const DEBUG_READ_COMPAT_CAPABILITIES = new Set<AgentHarnessV2Capability>([
  'context.read',
  'diagnostics.read',
  'diagnostics.lifecycle_read',
  'external_mcp.read',
]);

const CAPABILITY_STATE_PRIORITY: Record<AgentHarnessV2CapabilityState, number> = {
  inactive: 0,
  denied: 1,
  exhausted: 2,
  available: 3,
  approval_required: 4,
  active: 5,
};

function normalizeDebugIntent(intent?: AgentDebugRunIntent | null): AgentHarnessV2DebugIntent {
  return intent === 'repair' ? 'repair' : 'diagnose';
}

function allowedLegacyCapabilityIds(runPlanSnapshot: AgentRunPlanSnapshotV1): AgentCapabilityCatalogId[] {
  const resolved = runPlanSnapshot.capabilities.resolvedCapabilityAccess || [];
  if (resolved.length > 0) {
    return resolved
      .filter((capability) => capability.allowed)
      .map((capability) => capability.capabilityId as AgentCapabilityCatalogId);
  }

  return [...runPlanSnapshot.capabilities.provisionalCapabilityIds];
}

function isDebugRunPlan(runPlanSnapshot: AgentRunPlanSnapshotV1): boolean {
  return Boolean(
    runPlanSnapshot.debug ||
      (runPlanSnapshot.agent.id === 'system.debug' && runPlanSnapshot.agent.sourceKind === 'build_context_chat')
  );
}

function resolveProfile(runPlanSnapshot: AgentRunPlanSnapshotV1): AgentHarnessV2Profile {
  if (isDebugRunPlan(runPlanSnapshot)) {
    return {
      kind: 'debug',
      intent: normalizeDebugIntent(runPlanSnapshot.debug?.resolvedIntent),
    };
  }

  if (runPlanSnapshot.agent.sourceKind === 'freeform_chat') {
    return {
      kind: 'answer',
      intent: 'chat',
    };
  }

  if (runPlanSnapshot.agent.sourceKind === 'workspace_session') {
    return {
      kind: 'change',
      intent: 'workspace',
    };
  }

  return {
    kind: 'legacy',
    intent: 'legacy',
  };
}

function resolveState(
  existing: AgentHarnessV2CapabilityResolution | undefined,
  nextState: AgentHarnessV2CapabilityState
): AgentHarnessV2CapabilityState {
  if (!existing) {
    return nextState;
  }

  return CAPABILITY_STATE_PRIORITY[nextState] > CAPABILITY_STATE_PRIORITY[existing.state] ? nextState : existing.state;
}

function addCapability(
  capabilities: Map<AgentHarnessV2Capability, AgentHarnessV2CapabilityResolution>,
  name: AgentHarnessV2Capability,
  state: AgentHarnessV2CapabilityState,
  legacyCapabilityIds: readonly AgentCapabilityCatalogId[] = []
) {
  const existing = capabilities.get(name);
  capabilities.set(name, {
    name,
    state: resolveState(existing, state),
    legacyCapabilityIds: [
      ...new Set([...(existing?.legacyCapabilityIds || []), ...legacyCapabilityIds]),
    ] as AgentCapabilityCatalogId[],
  });
}

export function mapLegacyAgentCapabilitiesToV2(
  capabilityIds: readonly AgentCapabilityCatalogId[]
): AgentHarnessV2Capability[] {
  return [
    ...new Set(capabilityIds.flatMap((capabilityId) => LEGACY_AGENT_CAPABILITY_TO_V2_CAPABILITIES[capabilityId])),
  ];
}

export function resolveAgentHarnessV2ProfileCapabilities({
  runPlanSnapshot,
  workspaceCoreRequested,
}: {
  runPlanSnapshot: AgentRunPlanSnapshotV1;
  workspaceCoreRequested?: boolean;
}): AgentHarnessV2ProfileCapabilityResolution {
  const legacyCapabilityIds = allowedLegacyCapabilityIds(runPlanSnapshot);
  const capabilities = new Map<AgentHarnessV2Capability, AgentHarnessV2CapabilityResolution>();
  const profile = resolveProfile(runPlanSnapshot);
  const shouldRequestWorkspaceCore = workspaceCoreRequested ?? runPlanSnapshot.agent.sourceKind === 'workspace_session';
  const workspaceCore = shouldRequestWorkspaceCore ? 'requested' : 'absent';

  for (const legacyCapabilityId of legacyCapabilityIds) {
    for (const capability of LEGACY_AGENT_CAPABILITY_TO_V2_CAPABILITIES[legacyCapabilityId]) {
      if (profile.kind === 'debug' && !DEBUG_READ_COMPAT_CAPABILITIES.has(capability)) {
        continue;
      }
      addCapability(capabilities, capability, 'available', [legacyCapabilityId]);
    }
  }

  if (profile.kind === 'debug') {
    for (const capability of DEBUG_DIAGNOSE_ACTIVE_CAPABILITIES) {
      addCapability(capabilities, capability, 'active');
    }

    if (capabilities.has('external_mcp.read')) {
      addCapability(capabilities, 'external_mcp.read', 'active');
    }

    if (profile.intent === 'repair') {
      addCapability(
        capabilities,
        'source_control.remote_write',
        'approval_required',
        legacyCapabilityIds.includes('github_write') ? ['github_write'] : []
      );
      addCapability(
        capabilities,
        'deployment.write',
        'approval_required',
        legacyCapabilityIds.includes('diagnostics_kubernetes') ? ['diagnostics_kubernetes'] : []
      );
    }
  }

  if (workspaceCore === 'requested') {
    addCapability(capabilities, 'workspace.request', 'active');
    addCapability(capabilities, 'workspace.read', 'available');
    for (const capability of WORKSPACE_CORE_REQUEST_CAPABILITIES) {
      addCapability(capabilities, capability, capabilities.get(capability)?.state || 'available');
    }
  }

  return {
    profile,
    workspaceCore,
    capabilities: AGENT_HARNESS_V2_CAPABILITIES.map((name) => capabilities.get(name)).filter(
      (capability): capability is AgentHarnessV2CapabilityResolution => Boolean(capability)
    ),
  };
}

export function toRunPlanProfileSnapshot(
  resolution: Pick<AgentHarnessV2ProfileCapabilityResolution, 'profile' | 'workspaceCore'>
): AgentRunPlanProfileSnapshot {
  return {
    kind: resolution.profile.kind,
    intent: resolution.profile.intent as AgentRunPlanProfileIntent,
    workspaceCore: resolution.workspaceCore,
  };
}
