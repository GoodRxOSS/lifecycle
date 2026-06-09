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

import { type PrepareStepFunction, type StopCondition, type ToolSet } from 'ai';
import { DEFAULT_AGENT_SESSION_MAX_RUN_INPUT_TOKENS } from 'server/lib/agentSession/runtimeConfig';
import type { AgentRuntimeToolMetadata } from './CapabilityService';
import type { AgentRuntimeContext } from './runtimeContext';
import type { AgentDebugRunIntent, AgentRunPlanSnapshotV1 } from './runPlanTypes';
import { isReadOnlyRuntimeTool, isRepairRuntimeTool } from './toolMetadata';

type AgentPrepareStepFunction = PrepareStepFunction<ToolSet, AgentRuntimeContext>;
type AgentStopCondition = StopCondition<ToolSet, AgentRuntimeContext>;

type DebugToolLoopControls = {
  activeTools?: string[];
  stopWhen: Array<AgentStopCondition>;
  effectiveMaxIterations: number;
  prepareStep?: AgentPrepareStepFunction;
};

const FINAL_ANSWER_STEP = { activeTools: [] as string[], toolChoice: 'none' as const };

type UsageSteps = ReadonlyArray<{ usage?: { inputTokens?: number } }>;

function isStepCount(stepCount: number): AgentStopCondition {
  return ({ steps }) => steps.length === stepCount;
}

function cumulativeInputTokens(steps: UsageSteps): number {
  let total = 0;
  for (const step of steps) {
    const inputTokens = step.usage?.inputTokens;
    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens)) {
      total += inputTokens;
    }
  }
  return total;
}

function exceedsRunInputTokenBudget(steps: UsageSteps): boolean {
  return cumulativeInputTokens(steps) >= DEFAULT_AGENT_SESSION_MAX_RUN_INPUT_TOKENS;
}

// The token budget degrades in-loop: prepareStep grants one tools-off answer step after the budget trips, so this
// backstop only ends the loop when that granted step (the budget was already exceeded before it) still made tool calls.
const stopWhenInputTokenBudgetExhausted: AgentStopCondition = ({ steps }) =>
  exceedsRunInputTokenBudget(steps.slice(0, -1));

function withInputTokenBudget(prepareStep?: AgentPrepareStepFunction): AgentPrepareStepFunction {
  return (options) => (exceedsRunInputTokenBudget(options.steps) ? FINAL_ANSWER_STEP : prepareStep?.(options));
}

function isBuildContextWorkspaceTool(metadata: AgentRuntimeToolMetadata): boolean {
  return (
    metadata.workspaceNeed === 'required' ||
    metadata.resourceDomain === 'workspace' ||
    metadata.resourceDomain === 'git' ||
    metadata.resourceDomain === 'preview' ||
    metadata.catalogCapabilityId === 'workspace_files' ||
    metadata.catalogCapabilityId === 'workspace_shell' ||
    metadata.catalogCapabilityId === 'workspace_git' ||
    metadata.catalogCapabilityId === 'preview_publish'
  );
}

// Build-context chats have no workspace, so any workspace or git tool would provision one on first call. Strip them by source kind, independent of agent id or debug intent.
function buildContextWorkspaceToolKeys(tools: ToolSet, toolMetadata: AgentRuntimeToolMetadata[]): Set<string> {
  const registered = new Set(Object.keys(tools));
  const excluded = new Set<string>();
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

  if (intent === 'diagnose') {
    return isReadOnlyRuntimeTool(metadata);
  }

  return isReadOnlyRuntimeTool(metadata) || isRepairRuntimeTool(metadata);
}

export function resolveDebugIntent(runPlanSnapshot?: AgentRunPlanSnapshotV1 | null): AgentDebugRunIntent | null {
  if (!runPlanSnapshot) {
    return null;
  }

  if (runPlanSnapshot.debug?.resolvedIntent) {
    const resolvedIntent = runPlanSnapshot.debug.resolvedIntent;
    // Old snapshots may carry 'investigate'; it always ran identically to diagnose.
    return resolvedIntent === 'investigate' ? 'diagnose' : resolvedIntent;
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
  // Step count and cumulative input tokens are the budget knobs; Debug adds intent-based tool scoping + a tools-off final step so the agent always writes a diagnosis.
  const intent = resolveDebugIntent(runPlanSnapshot);
  const effectiveMaxIterations = maxIterations;
  const stopWhen = [isStepCount(effectiveMaxIterations), stopWhenInputTokenBudgetExhausted];

  if (!intent) {
    // No debug intent. Build-context AND freeform chats must never be offered workspace-provisioning tools until a real signal.
    const sourceKind = runPlanSnapshot?.agent.sourceKind;
    const isFreeform = sourceKind === 'freeform_chat';
    if (sourceKind !== 'build_context_chat' && !isFreeform) {
      return { stopWhen, effectiveMaxIterations, prepareStep: withInputTokenBudget() };
    }
    const excluded = buildContextWorkspaceToolKeys(tools, toolMetadata);
    if (excluded.size === 0) {
      return { stopWhen, effectiveMaxIterations, prepareStep: withInputTokenBudget() };
    }
    const strippedActiveTools = Object.keys(tools).filter((toolKey) => !excluded.has(toolKey));
    if (!isFreeform) {
      return {
        activeTools: strippedActiveTools,
        stopWhen,
        effectiveMaxIterations,
        prepareStep: withInputTokenBudget(),
      };
    }
    // Freeform keeps the non-workspace tool set active; the source run never widens into workspace tools.
    return {
      activeTools: strippedActiveTools,
      stopWhen,
      effectiveMaxIterations,
      prepareStep: withInputTokenBudget(() => ({ activeTools: strippedActiveTools })),
    };
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
    prepareStep: withInputTokenBudget(({ stepNumber }) =>
      stepNumber >= toolStepLimit ? FINAL_ANSWER_STEP : { activeTools }
    ),
  };
}
