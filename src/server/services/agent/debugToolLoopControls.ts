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

const DEBUG_READ_ONLY_MAX_STEPS = 8;
const DEBUG_REPAIR_MAX_STEPS = 9;

export type DebugToolLoopControls = {
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

function resolveDebugMaxIterations(intent: AgentDebugRunIntent | undefined, maxIterations: number): number {
  if (!intent || !isReadOnlyDebugIntent(intent)) {
    return intent === 'repair' ? Math.min(maxIterations, DEBUG_REPAIR_MAX_STEPS + 1) : maxIterations;
  }

  return Math.min(maxIterations, DEBUG_READ_ONLY_MAX_STEPS + 1);
}

function resolveDebugToolStepLimit(intent: AgentDebugRunIntent, maxIterations: number): number {
  const maxSteps = isReadOnlyDebugIntent(intent) ? DEBUG_READ_ONLY_MAX_STEPS : DEBUG_REPAIR_MAX_STEPS;
  return Math.max(0, Math.min(maxIterations, maxSteps + 1) - 1);
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
  const intent = resolveDebugIntent(runPlanSnapshot);
  const effectiveMaxIterations = resolveDebugMaxIterations(intent, maxIterations);
  const stopWhen = stepCountIs(effectiveMaxIterations);

  if (!intent) {
    return { stopWhen, effectiveMaxIterations };
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

  const toolStepLimit = resolveDebugToolStepLimit(intent, maxIterations);

  return {
    activeTools,
    stopWhen,
    effectiveMaxIterations,
    prepareStep: ({ stepNumber }) =>
      stepNumber >= toolStepLimit ? { activeTools: [], toolChoice: 'none' } : { activeTools },
  };
}
