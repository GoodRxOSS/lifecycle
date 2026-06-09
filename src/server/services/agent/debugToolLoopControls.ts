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

import { type Instructions, type ModelMessage, type PrepareStepFunction, type StopCondition, type ToolSet } from 'ai';
import { DEFAULT_AGENT_SESSION_MAX_RUN_INPUT_TOKENS } from 'server/lib/agentSession/runtimeConfig';
import type { AgentRuntimeToolMetadata } from './CapabilityService';
import type { AgentRuntimeContext } from './runtimeContext';
import type { AgentDebugRunIntent, AgentRunPlanSnapshotV1 } from './runPlanTypes';
import { buildAgentToolKey, CHAT_REQUEST_WORKSPACE_TOOL_NAME, LIFECYCLE_BUILTIN_SERVER_SLUG } from './toolKeys';
import { isReadOnlyRuntimeTool, isRepairRuntimeTool } from './toolMetadata';

type AgentPrepareStepFunction = PrepareStepFunction<ToolSet, AgentRuntimeContext>;
type AgentStopCondition = StopCondition<ToolSet, AgentRuntimeContext>;

type DebugToolLoopControls = {
  activeTools?: string[];
  stopWhen: Array<AgentStopCondition>;
  effectiveMaxIterations: number;
  prepareStep?: AgentPrepareStepFunction;
};

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

const REQUEST_WORKSPACE_TOOL_KEY = buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, CHAT_REQUEST_WORKSPACE_TOOL_NAME);

type ToolResultSteps = ReadonlyArray<{
  toolResults?: ReadonlyArray<{ toolName: string; output?: unknown }>;
}>;

// A request_workspace result reads as ready from two shapes: the raw tool return carried on
// step.toolResults (`{ status }`), and the ModelMessage tool-result envelope (`{ type: 'json', value: { status } }`).
function isReadyWorkspaceOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') {
    return false;
  }
  const record = output as { status?: unknown; value?: unknown };
  if (record.status === 'ready') {
    return true;
  }
  const value = record.value;
  if (value && typeof value === 'object') {
    return (value as { status?: unknown }).status === 'ready';
  }
  if (typeof value === 'string') {
    try {
      return (JSON.parse(value) as { status?: unknown }).status === 'ready';
    } catch {
      return false;
    }
  }
  return false;
}

function workspaceBecameReady(steps: ToolResultSteps): boolean {
  return steps.some((step) =>
    (step.toolResults || []).some(
      (result) => result.toolName === REQUEST_WORKSPACE_TOOL_KEY && isReadyWorkspaceOutput(result.output)
    )
  );
}

// The durable signal: an approval pause resumes as a fresh stream whose in-memory `steps` omit the
// pre-pause request_workspace result, but that result is still in the model's message history — the
// same history that told the model the workspace is ready. Read widening from there so it survives the pause.
function workspaceReadyInMessages(messages: ReadonlyArray<ModelMessage>): boolean {
  return messages.some((message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (part) =>
        part?.type === 'tool-result' &&
        part.toolName === REQUEST_WORKSPACE_TOOL_KEY &&
        isReadyWorkspaceOutput((part as { output?: unknown }).output)
    );
  });
}

// The bootstrap system prompt only names workspace_core tools when the workspace was already ready. When
// widening flips mid-run, append the same tool guidance so the model's instructions match its live tool set.
// Handles both instruction shapes resolveAgentInstructions emits: a plain string, or an anthropic system message.
function appendWorkspaceReadyInstructions(instructions: Instructions | undefined, suffix: string): Instructions {
  if (instructions == null) {
    return suffix;
  }
  if (typeof instructions === 'string') {
    return instructions ? `${instructions}\n\n${suffix}` : suffix;
  }
  if (Array.isArray(instructions)) {
    return [...instructions, { role: 'system', content: suffix }];
  }
  return { ...instructions, content: `${instructions.content}\n\n${suffix}` };
}

// The token budget degrades in-loop: prepareStep grants one tools-off answer step after the budget trips, so this
// backstop only ends the loop when that granted step (the budget was already exceeded before it) still made tool calls.
const stopWhenInputTokenBudgetExhausted: AgentStopCondition = ({ steps }) =>
  exceedsRunInputTokenBudget(steps.slice(0, -1));

function withInputTokenBudget(prepareStep?: AgentPrepareStepFunction): AgentPrepareStepFunction {
  return (options) => {
    const inner = prepareStep?.(options);
    if (!exceedsRunInputTokenBudget(options.steps)) {
      return inner;
    }
    // Budget exhausted: steer the model to finish with toolChoice 'none', but keep the tools that were
    // already active. Emptying activeTools here made Gemini's disobedient tool calls fail as a wall of
    // NoSuchToolError ("couldn't use tool"); keeping them active lets such a call execute cleanly
    // instead. stopWhenInputTokenBudgetExhausted still ends the loop after this single granted step.
    const innerActiveTools = (inner as { activeTools?: string[] } | undefined)?.activeTools;
    return innerActiveTools ? { toolChoice: 'none', activeTools: innerActiveTools } : { toolChoice: 'none' };
  };
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
  workspaceReady = false,
  workspaceReadyInstructions,
}: {
  runPlanSnapshot?: AgentRunPlanSnapshotV1 | null;
  tools: ToolSet;
  toolMetadata: AgentRuntimeToolMetadata[];
  maxIterations: number;
  // Authoritative durable signal (session.workspaceStatus === 'ready') read at run build time. A freeform run
  // whose snapshot predates provisioning but that resumes after the workspace is ready must not re-strip.
  workspaceReady?: boolean;
  // Workspace tool guidance to splice into the frozen instructions when a freeform run widens mid-loop.
  workspaceReadyInstructions?: string;
}): DebugToolLoopControls {
  // Step count and cumulative input tokens are the budget knobs; Debug adds intent-based tool scoping + a tools-off final step so the agent always writes a diagnosis.
  const intent = resolveDebugIntent(runPlanSnapshot);
  const effectiveMaxIterations = maxIterations;
  const stopWhen = [isStepCount(effectiveMaxIterations), stopWhenInputTokenBudgetExhausted];

  if (!intent) {
    // No debug intent. Build-context AND freeform chats must never be offered workspace-provisioning tools until a real signal.
    const sourceKind = runPlanSnapshot?.agent.sourceKind;
    const isBuildContext = sourceKind === 'build_context_chat';
    const isFreeform = sourceKind === 'freeform_chat';
    // A freeform run whose workspace is already provisioned (a resume after it became ready) has nothing left
    // to gate — expose every tool like a workspace_session run, independent of the in-loop ready signal.
    if (!isBuildContext && (!isFreeform || workspaceReady)) {
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
    // Freeform starts without workspace tools; once request_workspace reports ready — in this run or an
    // earlier paused/approved turn of it — later steps widen to the full registered tool set (provisioning
    // still requires that explicit call). Widening latches so a later step can't narrow it back.
    const allToolKeys = Object.keys(tools);
    let workspaceWidened = false;
    return {
      activeTools: strippedActiveTools,
      stopWhen,
      effectiveMaxIterations,
      prepareStep: withInputTokenBudget(({ steps, messages = [], initialInstructions }) => {
        if (!workspaceWidened && (workspaceBecameReady(steps) || workspaceReadyInMessages(messages))) {
          workspaceWidened = true;
        }
        if (!workspaceWidened) {
          return { activeTools: strippedActiveTools };
        }
        return {
          activeTools: allToolKeys,
          ...(workspaceReadyInstructions
            ? { instructions: appendWorkspaceReadyInstructions(initialInstructions, workspaceReadyInstructions) }
            : {}),
        };
      }),
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
    // The answer step keeps tools active with toolChoice 'none' — emptying activeTools makes Gemini's
    // disobedient tool calls fail as NoSuchToolError walls instead of executing cleanly (same lesson
    // as the budget backstop in withInputTokenBudget).
    prepareStep: withInputTokenBudget(({ stepNumber }) =>
      stepNumber >= toolStepLimit ? { activeTools, toolChoice: 'none' as const } : { activeTools }
    ),
  };
}
