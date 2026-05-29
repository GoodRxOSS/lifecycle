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

import { stepCountIs, type PrepareStepFunction, type StopCondition, type ToolSet } from 'ai';
import type { AgentRuntimeToolMetadata } from './CapabilityService';
import type { AgentDebugRunIntent, AgentRunPlanSnapshotV1 } from './runPlanTypes';
import { isApprovalGatedWriteRuntimeTool, isReadOnlyRuntimeTool } from './toolMetadata';

type DebugToolLoopControls = {
  activeTools?: string[];
  stopWhen: StopCondition<ToolSet>;
  effectiveMaxIterations: number;
  prepareStep?: PrepareStepFunction<ToolSet>;
};

export function isReadOnlyDebugIntent(intent: AgentDebugRunIntent): boolean {
  return intent === 'diagnose' || intent === 'investigate';
}

function isBuildContextWorkspaceTool(metadata: AgentRuntimeToolMetadata): boolean {
  return (
    metadata.resourceDomain === 'workspace' ||
    metadata.resourceDomain === 'git' ||
    metadata.toolKey.startsWith('mcp__sandbox__')
  );
}

// Build-context chats have no workspace, so any workspace/sandbox/git tool would provision one on first call. Strip them by source kind, independent of agent id or debug intent.
function buildContextWorkspaceToolKeys(tools: ToolSet, toolMetadata: AgentRuntimeToolMetadata[]): Set<string> {
  const registered = new Set(Object.keys(tools));
  const excluded = new Set<string>();
  for (const toolKey of registered) {
    if (toolKey.startsWith('mcp__sandbox__')) {
      excluded.add(toolKey);
    }
  }
  for (const metadata of toolMetadata) {
    if (registered.has(metadata.toolKey) && isBuildContextWorkspaceTool(metadata)) {
      excluded.add(metadata.toolKey);
    }
  }
  return excluded;
}

function isToolActiveForIntent(
  intent: AgentDebugRunIntent,
  metadata: AgentRuntimeToolMetadata,
  runPlanSnapshot?: AgentRunPlanSnapshotV1 | null
): boolean {
  if (runPlanSnapshot?.agent.sourceKind === 'build_context_chat' && isBuildContextWorkspaceTool(metadata)) {
    return false;
  }

  if (isReadOnlyDebugIntent(intent)) {
    return isReadOnlyRuntimeTool(metadata);
  }

  return isReadOnlyRuntimeTool(metadata) || isApprovalGatedWriteRuntimeTool(metadata);
}

export function resolveDebugIntent(runPlanSnapshot?: AgentRunPlanSnapshotV1 | null): AgentDebugRunIntent | null {
  if (!runPlanSnapshot) {
    return null;
  }

  if (runPlanSnapshot.debug?.resolvedIntent) {
    return runPlanSnapshot.debug.resolvedIntent;
  }

  return runPlanSnapshot.agent.id === 'system.debug' && runPlanSnapshot.agent.sourceKind === 'build_context_chat'
    ? 'diagnose'
    : null;
}

export function resolveDebugToolLoopControls({
  runPlanSnapshot,
  tools,
  toolMetadata,
  maxIterations,
}: {
  runPlanSnapshot?: AgentRunPlanSnapshotV1 | null;
  tools: ToolSet;
  toolMetadata: AgentRuntimeToolMetadata[];
  maxIterations: number;
}): DebugToolLoopControls {
  // maxIterations is the only budget knob; Debug adds intent-based tool scoping + a tools-off final step so the agent always writes a diagnosis.
  const intent = resolveDebugIntent(runPlanSnapshot);
  const effectiveMaxIterations = maxIterations;
  const stopWhen = stepCountIs(effectiveMaxIterations);

  if (!intent) {
    // No debug intent (e.g. a custom agent), but build-context chats must still never be offered workspace-provisioning tools.
    if (runPlanSnapshot?.agent.sourceKind !== 'build_context_chat') {
      return { stopWhen, effectiveMaxIterations };
    }
    const excluded = buildContextWorkspaceToolKeys(tools, toolMetadata);
    if (excluded.size === 0) {
      return { stopWhen, effectiveMaxIterations };
    }
    const activeTools = Object.keys(tools).filter((toolKey) => !excluded.has(toolKey));
    return { activeTools, stopWhen, effectiveMaxIterations };
  }

  const registeredToolKeys = new Set(Object.keys(tools));
  const activeTools = [
    ...new Set(
      toolMetadata
        .filter((metadata) => registeredToolKeys.has(metadata.toolKey))
        .filter((metadata) => isToolActiveForIntent(intent, metadata, runPlanSnapshot))
        .map((metadata) => metadata.toolKey)
    ),
  ];

  const toolStepLimit = Math.max(0, effectiveMaxIterations - 1);

  return {
    activeTools,
    stopWhen,
    effectiveMaxIterations,
    prepareStep: ({ stepNumber }) =>
      stepNumber >= toolStepLimit ? { activeTools: [], toolChoice: 'none' } : { activeTools },
  };
}
