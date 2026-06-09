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

import type { ToolLoopAgentSettings, ToolSet } from 'ai';
import { randomBytes } from 'crypto';
import os from 'os';
import type { Transaction } from 'objection';
import type AgentRun from 'server/models/AgentRun';
import type AgentSession from 'server/models/AgentSession';
import type AgentThread from 'server/models/AgentThread';
import { getLogger } from 'server/lib/logger';
import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentToolExecution from 'server/models/AgentToolExecution';
import AgentSessionService from 'server/services/agentSession';
import AgentSessionConfigService from 'server/services/agentSessionConfig';
import type { RequestUserIdentity } from 'server/lib/get-user';
import ApprovalService from './ApprovalService';
import AgentCapabilityService from './CapabilityService';
import AgentMessageStore from './MessageStore';
import { AgentRunObservabilityTracker, buildMessageObservabilityMetadataPatch } from './observability';
import AgentProviderRegistry from './ProviderRegistry';
import AgentRunQueueService, { type AgentRunExecuteJob } from './RunQueueService';
import ApprovalGitHubAuthHandoffService from './ApprovalGitHubAuthHandoffService';
import type { AgentRequestGitHubAuth } from './githubAuth';
import { buildAgentRequestGitHubAuthFromToken, normalizeAgentRequestGitHubAuth } from './githubAuth';
import AgentRunService from './RunService';
import AgentRunPlanResolver from './RunPlanResolver';
import AgentSourceService from './SourceService';
import { isAgentRunPlanSnapshotV1, type AgentRunPlanSnapshotV1 } from './runPlanTypes';
import { getToolApprovalAllowlist } from './ThreadService';
import { repairAgentToolName } from './toolCallRepair';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentFileChangeData, AgentUIMessage } from './types';
import { applyApprovalResponsesToFileChangeParts, buildResultFileChanges } from './fileChanges';
import { AgentRunTerminalFailure, SessionWorkspaceGatewayUnavailableError } from './errors';
import { limitDurablePayloadValue } from './payloadLimits';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';
import { resolveDebugIntent, resolveDebugToolLoopControls } from './debugToolLoopControls';
import { buildWorkspaceCorePromptLines } from 'server/services/workspaceCoreMcp/prompt';
import { buildDebugRepairObservationText, repairObservationExpectsRebuild } from './debugRepairObservation';
import EnvironmentWatchService from './EnvironmentWatchService';
import { assistantRunHasText, sanitizeDebugRepairAssistantMessages } from './debugResponseSanitizer';
import { resolveAgentInstructions, resolveThinkingProviderOptions } from './thinkingProviderOptions';
import { loadAiSdk } from './aiSdkRuntime';
import { buildAiToolApprovalConfig } from './capabilityToolHelpers';
import { buildAgentRuntimeContext, type AgentRuntimeContext } from './runtimeContext';

const DEBUG_REPAIR_SYNTHESIS_SYSTEM_PROMPT = [
  'You are closing out a Debug repair run after the tool loop reached its step budget without a confirmed fix.',
  'Summarize what (if anything) was changed, the current environment state, and the single next step.',
  'Do NOT call tools and do NOT claim an unverified fix.',
  'Use only the evidence already present in the transcript.',
].join(' ');

const DEBUG_REPAIR_SYNTHESIS_USER_PROMPT =
  'Write the final repair summary now: what was changed, what is still blocking, and the single next step. Do not call tools and do not claim an unverified fix.';

function buildSystemPrompt(parts: Array<string | undefined>): string | undefined {
  const normalized = parts.map((part) => part?.trim()).filter(Boolean) as string[];
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.join('\n\n');
}

function readResolvedInstructionTexts(runPlan?: AgentRunPlanSnapshotV1 | null): string[] {
  return (runPlan?.prompt.resolvedInstructions || [])
    .map((instruction) => instruction.renderedText)
    .filter((text): text is string => typeof text === 'string' && Boolean(text.trim()));
}

function applyFinalObservabilityToMessages(
  messages: AgentUIMessage[],
  runId: string,
  summary: Record<string, unknown>
): AgentUIMessage[] {
  const targetIndex = [...messages]
    .reverse()
    .findIndex((message) => message.role === 'assistant' && message.metadata?.runId === runId);

  if (targetIndex === -1) {
    return messages;
  }

  const absoluteIndex = messages.length - targetIndex - 1;
  const nextMessages = [...messages];
  const targetMessage = nextMessages[absoluteIndex];
  const metadataPatch = { ...summary };
  const nextUsage =
    metadataPatch.usage &&
    typeof metadataPatch.usage === 'object' &&
    targetMessage.metadata?.usage &&
    typeof targetMessage.metadata.usage === 'object'
      ? {
          ...(targetMessage.metadata.usage as Record<string, unknown>),
          ...(metadataPatch.usage as Record<string, unknown>),
        }
      : metadataPatch.usage;

  if (nextUsage) {
    metadataPatch.usage = nextUsage;
  }

  nextMessages[absoluteIndex] = {
    ...targetMessage,
    metadata: {
      ...(targetMessage.metadata || {}),
      ...metadataPatch,
    },
  };

  return nextMessages;
}

function appendAssistantTextForRun(messages: AgentUIMessage[], runId: string, text: string): AgentUIMessage[] {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return messages;
  }

  const targetIndex = [...messages]
    .reverse()
    .findIndex((message) => message.role === 'assistant' && message.metadata?.runId === runId);

  if (targetIndex === -1) {
    return [
      ...messages,
      {
        id: randomBytes(16).toString('hex'),
        role: 'assistant',
        parts: [{ type: 'text', text: normalizedText }],
        metadata: { runId },
      } as AgentUIMessage,
    ];
  }

  const absoluteIndex = messages.length - targetIndex - 1;
  const nextMessages = [...messages];
  const targetMessage = nextMessages[absoluteIndex];
  const previousTextPart = [...targetMessage.parts].reverse().find((part) => part.type === 'text') as
    | { text?: unknown }
    | undefined;
  const appendedText =
    typeof previousTextPart?.text === 'string' && previousTextPart.text.trim()
      ? `\n\n${normalizedText}`
      : normalizedText;
  nextMessages[absoluteIndex] = {
    ...targetMessage,
    parts: [...targetMessage.parts, { type: 'text', text: appendedText } as AgentUIMessage['parts'][number]],
  };

  return nextMessages;
}

type AgentLoopOutcome = 'paused_for_approval' | 'budget_exhausted' | 'finished';

function findPendingApprovalAction({ threadId, runId, trx }: { threadId: number; runId: number; trx?: Transaction }) {
  return AgentPendingAction.query(trx)
    .where({
      threadId,
      runId,
      kind: 'tool_approval',
      status: 'pending',
    })
    .first()
    .then((action) => (action?.status === 'pending' ? action : null));
}

function runHasPendingApprovalRequest(messages: AgentUIMessage[], runId: string): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.metadata?.runId === runId &&
      message.parts.some((part) => (part as { state?: unknown }).state === 'approval-requested')
  );
}

// The SDK reports finishReason 'tool-calls' both for an approval pause and for budget exhaustion, so the
// outcome must be derived structurally from the final messages.
function classifyLoopOutcome({
  finishReason,
  messages,
  runId,
}: {
  finishReason?: string;
  messages: AgentUIMessage[];
  runId: string;
}): AgentLoopOutcome {
  if (finishReason !== 'tool-calls') {
    return 'finished';
  }

  return runHasPendingApprovalRequest(messages, runId) ? 'paused_for_approval' : 'budget_exhausted';
}

function calculateDurationMs(startedAt?: string | null, completedAt?: string | null): number | null {
  if (!startedAt || !completedAt) {
    return null;
  }

  const startedAtMs = new Date(startedAt).valueOf();
  const completedAtMs = new Date(completedAt).valueOf();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return null;
  }

  return Math.max(0, completedAtMs - startedAtMs);
}

function stripToolResultAuth(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('auth' in result)) {
    return result;
  }

  const { auth: _auth, ...rest } = result as Record<string, unknown>;
  return rest;
}

function classifyTerminalRunFailure({
  finishReason,
  maxIterations,
}: {
  finishReason?: string;
  maxIterations: number;
}): AgentRunTerminalFailure | null {
  switch (finishReason) {
    case undefined:
    case 'stop':
      return null;
    case 'tool-calls':
      return new AgentRunTerminalFailure({
        code: 'max_iterations_exceeded',
        message: `Agent stopped after reaching the configured iteration limit of ${maxIterations}.`,
        details: {
          finishReason,
          maxIterations,
        },
      });
    case 'length':
      return new AgentRunTerminalFailure({
        code: 'token_limit_reached',
        message: 'Agent stopped before completing because the model hit its token limit.',
        details: {
          finishReason,
        },
      });
    case 'content-filter':
      return new AgentRunTerminalFailure({
        code: 'content_filtered',
        message: 'Agent stopped before completing because the model response was blocked by content filtering.',
        details: {
          finishReason,
        },
      });
    case 'error':
      return new AgentRunTerminalFailure({
        code: 'stream_error',
        message: 'Agent stream finished with error.',
        details: {
          finishReason,
        },
      });
    default:
      return new AgentRunTerminalFailure({
        code: 'run_incomplete',
        message: 'Agent stopped before completing the response.',
        details: {
          finishReason,
        },
      });
  }
}

function readRunMaxIterations(run?: AgentRun): number | null {
  const runPlanSnapshot = run?.runPlanSnapshot;
  const snapshot = isAgentRunPlanSnapshotV1(runPlanSnapshot) ? runPlanSnapshot : null;
  const runtimeOptions = snapshot?.runtime.runtimeOptions || run?.policySnapshot?.runtimeOptions;
  if (!runtimeOptions || typeof runtimeOptions !== 'object' || Array.isArray(runtimeOptions)) {
    return null;
  }

  const maxIterations = (runtimeOptions as Record<string, unknown>).maxIterations;
  return typeof maxIterations === 'number' && Number.isInteger(maxIterations) && maxIterations > 0
    ? maxIterations
    : null;
}

function resolveHeartbeatIntervalMs(runExecutionLeaseMs: number): number {
  return Math.min(Math.max(Math.floor(runExecutionLeaseMs / 3), 10_000), 60_000);
}

function buildDirectExecutionOwner(): string {
  return `direct:${os.hostname()}:${process.pid}:${randomBytes(6).toString('hex')}`;
}

export default class AgentRunExecutor {
  static async execute({
    session,
    thread,
    userIdentity,
    requestedProvider,
    requestedModelId,
    requestGitHubToken,
    requestGitHubAuth,
    existingRun,
    dispatchAttemptId,
    dispatchReason,
    onFileChange,
  }: {
    session: AgentSession;
    thread: AgentThread;
    userIdentity: RequestUserIdentity;
    requestedProvider?: string;
    requestedModelId?: string;
    requestGitHubToken?: string | null;
    requestGitHubAuth?: AgentRequestGitHubAuth | null;
    existingRun?: AgentRun;
    dispatchAttemptId?: string;
    dispatchReason?: AgentRunExecuteJob['reason'];
    onFileChange?: (change: AgentFileChangeData) => Promise<void> | void;
  }) {
    const { repoFullName, approvalPolicy: contextApprovalPolicy } = await AgentCapabilityService.resolveSessionContext(
      session.uuid,
      userIdentity
    );
    const existingRunSnapshot = existingRun?.runPlanSnapshot;
    const existingRunPlan: AgentRunPlanSnapshotV1 | null = isAgentRunPlanSnapshotV1(existingRunSnapshot)
      ? existingRunSnapshot
      : null;
    let executionRunPlan: AgentRunPlanSnapshotV1 | null = existingRunPlan;
    let pendingRunPlan: Awaited<ReturnType<typeof AgentRunPlanResolver.resolveForRunAdmission>> | null = null;
    if (!existingRun) {
      const source = await AgentSourceService.getSessionSource(session.id);
      if (!source || source.status !== 'ready') {
        throw new Error('Session source is not ready yet.');
      }
      pendingRunPlan = await AgentRunPlanResolver.resolveForRunAdmission({
        thread,
        session,
        source,
        userIdentity,
        requestedProvider,
        requestedModel: requestedModelId,
        runtimeOptions: {},
      });
      executionRunPlan = pendingRunPlan.runPlanSnapshot;
    }
    const approvalPolicy = executionRunPlan?.runtime.approvalPolicy || contextApprovalPolicy;
    const selection = await AgentProviderRegistry.resolveSelection({
      repoFullName,
      requestedProvider: executionRunPlan?.model.resolvedProvider || requestedProvider,
      requestedModelId: executionRunPlan?.model.resolvedModel || requestedModelId,
    });
    const model = await AgentProviderRegistry.createLanguageModel({
      repoFullName,
      selection,
      userIdentity,
    });
    const { ToolLoopAgent, convertToModelMessages, generateText } = await loadAiSdk();
    // Reasoning is for the streaming ToolLoopAgent path only; synthesis fallbacks discard it.
    const thinkingProviderOptions = resolveThinkingProviderOptions(selection.provider, selection.modelId);
    const observabilityTracker = new AgentRunObservabilityTracker(selection);
    const touchSessionActivity = async () => {
      try {
        await AgentSessionService.touchActivity(session.uuid);
      } catch (error) {
        getLogger().warn(
          { error, sessionId: session.uuid },
          `Session: activity touch failed sessionId=${session.uuid}`
        );
      }
    };
    const effectiveSessionConfig = await AgentSessionConfigService.getInstance().getEffectiveConfig(repoFullName);
    const effectiveRequestGitHubAuth = normalizeAgentRequestGitHubAuth(
      requestGitHubAuth || buildAgentRequestGitHubAuthFromToken(requestGitHubToken, 'user')
    );
    const runMaxIterations = readRunMaxIterations(existingRun);
    const runControlPlaneConfig = {
      ...effectiveSessionConfig,
      ...(runMaxIterations ? { maxIterations: runMaxIterations } : {}),
    };
    let run: AgentRun | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    const requireRun = () => {
      if (!run) {
        throw new Error('Agent run has not been initialized.');
      }

      return run;
    };
    const clearHeartbeatTimer = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    try {
      if (existingRun && !existingRunPlan) {
        throw new Error('Agent run plan snapshot is required for execution.');
      }

      const sessionAllowedToolKeys = new Set(getToolApprovalAllowlist(thread));

      const {
        tools,
        metadata: toolMetadata,
        toolApproval,
        toolsContext,
        workspaceRuntimeReady,
      } = await AgentCapabilityService.buildToolSetWithMetadata({
        session,
        repoFullName,
        userIdentity,
        approvalPolicy,
        resolvedCapabilityAccess: (executionRunPlan?.capabilities.resolvedCapabilityAccess ??
          []) as ResolvedAgentCapabilityAccess[],
        selectedRuntimeMcpConnectionRefs: executionRunPlan?.capabilities.selectedRuntimeMcpConnectionRefs,
        workspaceToolDiscoveryTimeoutMs: runControlPlaneConfig.workspaceToolDiscoveryTimeoutMs,
        workspaceToolExecutionTimeoutMs: runControlPlaneConfig.workspaceToolExecutionTimeoutMs,
        // An approval resume re-enters moments after the pausing run discovered live; crash/lease
        // recovery and fresh submits stay on live discovery.
        workspaceToolDiscoveryMode: dispatchReason === 'approval_resolved' ? 'prefer_cached' : 'live',
        autoProvisionWorkspace: runControlPlaneConfig.autoProvisionWorkspace,
        agentDefinitionId: executionRunPlan?.agent.id,
        agentSourceKind: executionRunPlan?.agent.sourceKind,
        requestGitHubToken: effectiveRequestGitHubAuth.githubToken,
        requestGitHubAuth: effectiveRequestGitHubAuth,
        resolveApprovalGitHubAuth: async ({ runUuid, toolCallId }) =>
          runUuid ? ApprovalGitHubAuthHandoffService.getByToolCallId(runUuid, toolCallId) : null,
        toolRules: runControlPlaneConfig.toolRules,
        hooks: {
          onToolStarted: async (audit) => {
            const activeRun = requireRun();
            const pendingAction = audit.toolCallId
              ? await AgentPendingAction.query()
                  .where({ threadId: thread.id, runId: activeRun.id })
                  .whereRaw(`payload->>'toolCallId' = ?`, [audit.toolCallId])
                  .orderBy('createdAt', 'desc')
                  .first()
              : null;

            await AgentToolExecution.query().insert({
              threadId: thread.id,
              runId: activeRun.id,
              pendingActionId: pendingAction?.id || null,
              source: audit.source,
              serverSlug: audit.serverSlug || null,
              toolName: audit.toolName,
              toolCallId: audit.toolCallId || null,
              args: audit.args,
              status: 'running',
              safetyLevel: audit.capabilityKey,
              approved:
                pendingAction?.status === 'approved'
                  ? true
                  : pendingAction?.status === 'denied'
                  ? false
                  : sessionAllowedToolKeys.has(audit.toolName)
                  ? true
                  : null,
              startedAt: new Date().toISOString(),
            } as Partial<AgentToolExecution>);
          },
          onToolFinished: async (audit) => {
            const activeRun = requireRun();
            const executionQuery = AgentToolExecution.query().where({ runId: activeRun.id });

            if (audit.toolCallId) {
              executionQuery.where({ toolCallId: audit.toolCallId });
            } else {
              executionQuery.where({ toolName: audit.toolName });
            }

            const execution = await executionQuery.orderBy('createdAt', 'desc').first();

            if (!execution) {
              return;
            }

            const completedAt = new Date().toISOString();
            const durability = await resolveAgentSessionDurabilityConfig();
            const fileChanges = audit.toolCallId
              ? buildResultFileChanges({
                  toolCallId: audit.toolCallId,
                  sourceTool: audit.toolName,
                  input: audit.args,
                  result: audit.result,
                  failed: audit.status === 'failed',
                  previewChars: durability.fileChangePreviewChars,
                })
              : [];
            await AgentToolExecution.query().patchAndFetchById(execution.id, {
              status: audit.status,
              result: {
                value: limitDurablePayloadValue(stripToolResultAuth(audit.result), durability),
                ...(audit.auth ? { auth: audit.auth } : {}),
                ...(fileChanges.length > 0 ? { fileChanges } : {}),
              },
              completedAt,
              durationMs: calculateDurationMs(execution.startedAt, completedAt),
            } as Partial<AgentToolExecution>);
          },
          onFileChange: async (change) => {
            await onFileChange?.(change);
          },
          // Tool build runs before `run` is assigned; queue-dispatched entries know their identity via
          // existingRun. Without it a workspace-loss reconcile claim is blocked by our own active run.
          getActiveRunUuid: () => (run ?? existingRun)?.uuid ?? requireRun().uuid,
        },
      });
      const sessionPrompt = await AgentSessionService.getSessionAppendSystemPrompt(
        session.uuid,
        repoFullName,
        runControlPlaneConfig.appendSystemPrompt,
        toolMetadata
      );

      const activeExistingRun = existingRun;
      if (activeExistingRun) {
        if (!activeExistingRun.executionOwner) {
          throw new Error('Agent run execution owner is required.');
        }

        const fallbackResolvedHarness =
          activeExistingRun.resolvedHarness || session.defaultHarness || 'lifecycle_ai_sdk';
        run = await AgentRunService.startRunForExecutionOwner(
          activeExistingRun.uuid,
          activeExistingRun.executionOwner,
          {
            resolvedHarness: existingRunPlan?.runtime.resolvedHarness || fallbackResolvedHarness,
            provider: selection.provider,
            model: selection.modelId,
            sandboxGeneration: activeExistingRun.sandboxGeneration,
          },
          { dispatchAttemptId }
        );
      } else {
        const runPlan = pendingRunPlan;
        if (!runPlan) {
          throw new Error('Agent run plan has not been initialized.');
        }
        executionRunPlan = runPlan.runPlanSnapshot;
        const queuedRun = await AgentRunService.createQueuedRun({
          thread,
          session,
          policy: runPlan.approvalPolicy,
          requestedHarness: runPlan.requestedHarness,
          requestedProvider: runPlan.requestedProvider,
          requestedModel: runPlan.requestedModel,
          resolvedHarness: runPlan.resolvedHarness,
          resolvedProvider: runPlan.resolvedProvider,
          resolvedModel: runPlan.resolvedModel,
          sandboxRequirement: runPlan.sandboxRequirement,
          runPlanSnapshot: runPlan.runPlanSnapshot,
        });
        const executionOwner = buildDirectExecutionOwner();
        const claimedRun = await AgentRunService.claimQueuedRunForExecution(queuedRun.uuid, executionOwner);
        if (!claimedRun) {
          throw new Error('Agent run could not be claimed for execution.');
        }
        run = await AgentRunService.startRunForExecutionOwner(
          claimedRun.uuid,
          executionOwner,
          {
            resolvedHarness: runPlan.resolvedHarness,
            provider: runPlan.resolvedProvider,
            model: runPlan.resolvedModel,
            sandboxGeneration: claimedRun.sandboxGeneration,
          },
          { dispatchAttemptId }
        );
      }
      const activeRun = run;
      const controller = new AbortController();
      const activeExecutionOwner = activeRun.executionOwner || null;
      AgentRunService.registerAbortController(activeRun.uuid, controller);
      if (activeExecutionOwner) {
        const { runExecutionLeaseMs } = await resolveAgentSessionDurabilityConfig();
        heartbeatTimer = setInterval(() => {
          void AgentRunService.heartbeatRunExecution(activeRun.uuid, activeExecutionOwner).catch((error) => {
            if (error instanceof AgentRunOwnershipLostError) {
              getLogger().info(
                {
                  runId: activeRun.uuid,
                  owner: activeExecutionOwner,
                  currentStatus: error.currentStatus || null,
                  currentOwner: error.currentExecutionOwner || null,
                },
                `AgentExec: ownership lost runId=${activeRun.uuid} owner=${activeExecutionOwner}`
              );
              controller.abort(error);
              clearHeartbeatTimer();
              return;
            }

            getLogger().warn({ error, runId: activeRun.uuid }, `AgentExec: heartbeat failed runId=${activeRun.uuid}`);
          });
        }, resolveHeartbeatIntervalMs(runExecutionLeaseMs));
        heartbeatTimer.unref?.();
      }
      // The tool build already probed (and possibly reconciled) the runtime; reuse its verdict instead of
      // re-reading a session row that may predate the reconcile.
      const workspaceReadyAtBuild = workspaceRuntimeReady;
      // Only a freeform run that provisions mid-loop needs its frozen prompt refreshed to name the workspace
      // tools; ready or non-freeform runs already name them at bootstrap (or never gain them).
      const workspaceCorePromptLines =
        executionRunPlan?.agent.sourceKind === 'freeform_chat' && !workspaceReadyAtBuild
          ? buildWorkspaceCorePromptLines({
              approvalPolicy,
              toolRules: runControlPlaneConfig.toolRules,
              runtimeToolMetadata: toolMetadata,
            })
          : [];
      const workspaceReadyInstructions = workspaceCorePromptLines.length
        ? [
            'The Lifecycle workspace is now ready. Equipped tools:',
            ...workspaceCorePromptLines.map((line) => `  ${line}`),
          ].join('\n')
        : undefined;
      const loopControls = resolveDebugToolLoopControls({
        runPlanSnapshot: executionRunPlan,
        tools,
        toolMetadata,
        maxIterations: runControlPlaneConfig.maxIterations,
        // Resume-after-provision carries a stale freeform snapshot; the live session is the ground truth.
        workspaceReady: workspaceReadyAtBuild,
        workspaceReadyInstructions,
      });
      const runtimeContext = buildAgentRuntimeContext({
        session,
        thread,
        run: activeRun,
        userIdentity,
        repoFullName,
        provider: selection.provider,
        modelId: selection.modelId,
        approvalPolicy,
        runPlanSnapshot: executionRunPlan,
      });
      const resolvedInstructionTexts = readResolvedInstructionTexts(executionRunPlan);
      // Tools-off synthesis of a final summary after a repair loop burns its budget without pausing or committing.
      const synthesizeRepairSummaryAnswer = async (
        messages: AgentUIMessage[],
        abortSignal?: AbortSignal
      ): Promise<string | null> => {
        if (abortSignal?.aborted || resolveDebugIntent(executionRunPlan) !== 'repair') {
          return null;
        }

        try {
          const modelMessages = await convertToModelMessages(
            messages.map(({ id: _id, ...message }) => message) as any,
            {
              tools,
              ignoreIncompleteToolCalls: true,
            }
          );
          const result = await generateText({
            model,
            instructions: buildSystemPrompt([
              runControlPlaneConfig.systemPrompt,
              ...resolvedInstructionTexts,
              executionRunPlan?.prompt.instructionAddendum || undefined,
              sessionPrompt,
              DEBUG_REPAIR_SYNTHESIS_SYSTEM_PROMPT,
            ]),
            messages: [...modelMessages, { role: 'user', content: DEBUG_REPAIR_SYNTHESIS_USER_PROMPT }],
            toolChoice: 'none',
            abortSignal,
          });
          const finalStep = (result as { finalStep?: { providerMetadata?: unknown; response?: unknown } }).finalStep;
          observabilityTracker.addGeneration({
            usage: result.usage,
            providerMetadata: (finalStep?.providerMetadata ?? result.providerMetadata) as
              | Parameters<AgentRunObservabilityTracker['addGeneration']>[0]['providerMetadata']
              | undefined,
            finishReason: result.finishReason,
            rawFinishReason: result.rawFinishReason,
            warnings: result.warnings,
            response: finalStep?.response ?? result.response,
          });

          return result.text.trim() || null;
        } catch (error) {
          const activeRun = requireRun();
          getLogger().warn(
            { error, runId: activeRun.uuid },
            `AgentExec: debug synthesis failed runId=${activeRun.uuid}`
          );
          return null;
        }
      };
      const agentSettings: ToolLoopAgentSettings<never, ToolSet, AgentRuntimeContext> = {
        model,
        providerOptions: thinkingProviderOptions as ToolLoopAgentSettings<
          never,
          ToolSet,
          AgentRuntimeContext
        >['providerOptions'],
        instructions: resolveAgentInstructions(
          selection.provider,
          buildSystemPrompt([
            runControlPlaneConfig.systemPrompt,
            ...resolvedInstructionTexts,
            executionRunPlan?.prompt.instructionAddendum || undefined,
            sessionPrompt,
          ])
        ),
        tools,
        runtimeContext,
        toolsContext: toolsContext as never,
        toolApproval: buildAiToolApprovalConfig(toolApproval, {
          autoApprovedToolKeys: sessionAllowedToolKeys,
        }),
        activeTools: loopControls.activeTools,
        stopWhen: loopControls.stopWhen,
        prepareStep: loopControls.prepareStep,
        // Gemini often invents tool namespaces (e.g. default_api:mcp__workspace_core__exec); remap the
        // mangled name back to the real key so the call runs instead of spiralling on NoSuchToolError.
        // Repairs resolve against the step's ACTIVE set (the callback argument), never the full registry —
        // a repair into a stripped tool would just fail re-parse, and must not look like a gating bypass.
        experimental_repairToolCall: async ({ toolCall, tools: stepActiveTools, error }) => {
          if ((error as { name?: string })?.name !== 'AI_NoSuchToolError') {
            return null;
          }
          const repairedName = repairAgentToolName(toolCall.toolName, Object.keys(stepActiveTools ?? {}));
          if (!repairedName) {
            return null;
          }
          getLogger().info(
            `AgentExec: repaired tool name ${toolCall.toolName} -> ${repairedName} runId=${requireRun().uuid}`
          );
          return { ...toolCall, toolName: repairedName };
        },
        onStepEnd: async (step) => {
          try {
            const usageSummary = observabilityTracker.updateFromStep({
              usage: (step as { usage?: unknown }).usage as
                | Parameters<AgentRunObservabilityTracker['updateFromStep']>[0]['usage']
                | undefined,
              stepNumber:
                typeof (step as { stepNumber?: unknown }).stepNumber === 'number'
                  ? (step as { stepNumber: number }).stepNumber
                  : undefined,
              toolCalls: Array.isArray((step as { toolCalls?: unknown[] }).toolCalls)
                ? (step as { toolCalls: unknown[] }).toolCalls
                : undefined,
            });

            if (activeExecutionOwner) {
              await AgentRunService.patchProgressForExecutionOwner(activeRun.uuid, activeExecutionOwner, {
                usageSummary: usageSummary as Record<string, unknown>,
              });
            }
            await touchSessionActivity();
          } catch (error) {
            if (error instanceof AgentRunOwnershipLostError) {
              controller.abort(error);
              clearHeartbeatTimer();
              throw error;
            }

            getLogger().warn(
              { error, runId: activeRun.uuid },
              `AgentExec: step observability patch failed runId=${activeRun.uuid}`
            );
          }
        },
        onEnd: (event) => {
          const finalStep = (event as { finalStep?: { providerMetadata?: unknown; response?: unknown } }).finalStep;
          observabilityTracker.finalize({
            usage: (event as { usage?: unknown }).usage as
              | Parameters<AgentRunObservabilityTracker['finalize']>[0]['usage']
              | undefined,
            providerMetadata: (finalStep?.providerMetadata ??
              (event as { providerMetadata?: unknown }).providerMetadata) as
              | Parameters<AgentRunObservabilityTracker['finalize']>[0]['providerMetadata']
              | undefined,
            steps: Array.isArray((event as { steps?: unknown[] }).steps)
              ? (event as { steps: Array<{ toolCalls?: unknown[] }> }).steps
              : undefined,
            finishReason:
              typeof (event as { finishReason?: unknown }).finishReason === 'string'
                ? (event as { finishReason: string }).finishReason
                : null,
            rawFinishReason:
              typeof (event as { rawFinishReason?: unknown }).rawFinishReason === 'string'
                ? (event as { rawFinishReason: string }).rawFinishReason
                : null,
            warnings: Array.isArray((event as { warnings?: unknown[] }).warnings)
              ? (event as { warnings: unknown[] }).warnings
              : undefined,
            response: (finalStep?.response ?? (event as { response?: unknown }).response) as
              | Parameters<AgentRunObservabilityTracker['finalize']>[0]['response']
              | undefined,
          });
        },
      };
      const agent = new ToolLoopAgent(agentSettings);

      return {
        run: activeRun,
        agent,
        abortSignal: controller.signal,
        selection,
        approvalPolicy,
        toolRules: runControlPlaneConfig.toolRules,
        onStreamFinish: async ({
          messages: updatedMessages,
          finishReason,
          isAborted,
        }: {
          messages: AgentUIMessage[];
          finishReason?: string;
          isAborted: boolean;
        }) => {
          let observabilitySummary = observabilityTracker.getSummary();
          // No graceful synthesis if the run was cancelled or ownership was lost.
          const synthesisAllowed = !isAborted && !controller.signal.aborted;
          try {
            if (!activeExecutionOwner) {
              throw new Error('Agent run execution owner is required.');
            }

            let effectiveMessages = updatedMessages;
            let effectiveFinishReason = finishReason;
            const structuralLoopOutcome = classifyLoopOutcome({
              finishReason,
              messages: updatedMessages,
              runId: activeRun.uuid,
            });
            const streamPersistedApprovalPending =
              structuralLoopOutcome === 'budget_exhausted'
                ? await findPendingApprovalAction({
                    threadId: thread.id,
                    runId: activeRun.id,
                  })
                : null;
            const loopOutcome = streamPersistedApprovalPending ? 'paused_for_approval' : structuralLoopOutcome;
            if (resolveDebugIntent(executionRunPlan) === 'repair') {
              effectiveMessages = sanitizeDebugRepairAssistantMessages(effectiveMessages, activeRun.uuid);
            }
            // A paused run resumes later: no observation and no synthesis while the approval card is pending.
            if (loopOutcome !== 'paused_for_approval') {
              let hasDebugRepairObservation = false;
              try {
                const repairObservationText = await buildDebugRepairObservationText({
                  session,
                  messages: effectiveMessages,
                  runPlanSnapshot: executionRunPlan,
                  runId: activeRun.id,
                });
                if (repairObservationText) {
                  hasDebugRepairObservation = true;
                  if (!assistantRunHasText(effectiveMessages, activeRun.uuid, repairObservationText)) {
                    effectiveMessages = appendAssistantTextForRun(
                      effectiveMessages,
                      activeRun.uuid,
                      repairObservationText
                    );
                  }
                  if (session.buildUuid && repairObservationExpectsRebuild(repairObservationText)) {
                    void EnvironmentWatchService.scheduleEnvironmentWatch({
                      buildUuid: session.buildUuid,
                      threadUuid: thread.uuid,
                      sessionUuid: session.uuid,
                      reason: 'repair_commit',
                    });
                  }
                }
              } catch (error) {
                getLogger().warn(
                  { error, runId: activeRun.uuid },
                  `AgentExec: debug repair observation failed runId=${activeRun.uuid}`
                );
              }
              if (hasDebugRepairObservation && effectiveFinishReason === 'tool-calls') {
                effectiveFinishReason = 'stop';
              }
              // Repair run hit its budget with no commit observation: synthesize a summary instead of failing blank.
              if (!hasDebugRepairObservation && loopOutcome === 'budget_exhausted' && synthesisAllowed) {
                const repairSummary = await synthesizeRepairSummaryAnswer(effectiveMessages, controller.signal);
                if (repairSummary) {
                  effectiveMessages = appendAssistantTextForRun(effectiveMessages, activeRun.uuid, repairSummary);
                  effectiveFinishReason = 'stop';
                }
              }
            }

            observabilitySummary = observabilityTracker.getSummary();
            const completedAt = new Date().toISOString();
            const messagesWithApprovalStages = applyApprovalResponsesToFileChangeParts(effectiveMessages);
            // Stamp run start/end onto the assistant message so the read API exposes a thinking duration.
            const messagesWithObservability = applyFinalObservabilityToMessages(
              messagesWithApprovalStages,
              activeRun.uuid,
              {
                ...buildMessageObservabilityMetadataPatch(observabilitySummary),
                createdAt: activeRun.startedAt || completedAt,
                completedAt,
              }
            );
            const terminalFailure = classifyTerminalRunFailure({
              finishReason: effectiveFinishReason,
              maxIterations: loopControls.effectiveMaxIterations,
            });
            const finalizedRun = await AgentRunService.finalizeRunForExecutionOwner(
              activeRun.uuid,
              activeExecutionOwner,
              async ({ run, trx }) => {
                await AgentMessageStore.upsertCanonicalUiMessagesForThread(thread, messagesWithObservability, {
                  trx,
                  runId: run.id,
                });
                const approvalSync = await ApprovalService.syncApprovalRequestStateFromMessages({
                  thread,
                  run,
                  messages: messagesWithObservability,
                  approvalPolicy,
                  toolRules: runControlPlaneConfig.toolRules,
                  trx,
                });
                const pendingApprovalAction =
                  approvalSync.pendingActions.length > 0
                    ? approvalSync.pendingActions[0]
                    : await findPendingApprovalAction({
                        threadId: thread.id,
                        runId: run.id,
                        trx,
                      });

                if (pendingApprovalAction) {
                  return {
                    status: 'waiting_for_approval',
                    patch: {
                      usageSummary: observabilitySummary as Record<string, unknown>,
                    },
                  };
                }

                if (approvalSync.resolvedActionCount > 0) {
                  return {
                    status: 'queued',
                    patch: {
                      queuedAt: completedAt,
                      usageSummary: observabilitySummary as Record<string, unknown>,
                    },
                  };
                }

                if (terminalFailure) {
                  return {
                    status: 'failed',
                    error: terminalFailure,
                    patch: {
                      completedAt,
                      usageSummary: observabilitySummary as Record<string, unknown>,
                    },
                  };
                }

                return {
                  status: 'completed',
                  patch: {
                    completedAt,
                    usageSummary: observabilitySummary as Record<string, unknown>,
                  },
                };
              },
              { dispatchAttemptId }
            );
            if (finalizedRun.status === 'queued') {
              const approvalAuth =
                (await ApprovalGitHubAuthHandoffService.getFirstForRun(finalizedRun.uuid).catch(() => null)) ||
                effectiveRequestGitHubAuth;
              await AgentRunQueueService.enqueueRun(finalizedRun.uuid, 'approval_resolved', {
                githubAuth: approvalAuth,
              }).catch((error) => {
                getLogger().warn(
                  { error, runId: finalizedRun.uuid },
                  `AgentExec: approval resume enqueue failed runId=${finalizedRun.uuid}`
                );
              });
            }
            await touchSessionActivity();
          } catch (error) {
            if (error instanceof AgentRunOwnershipLostError) {
              controller.abort(error);
              throw error;
            }

            if (activeExecutionOwner) {
              await AgentRunService.markFailedForExecutionOwner(
                activeRun.uuid,
                activeExecutionOwner,
                error,
                observabilitySummary,
                { dispatchAttemptId }
              ).catch((runFailureError) => {
                if (runFailureError instanceof AgentRunOwnershipLostError) {
                  throw runFailureError;
                }

                getLogger().warn(
                  { error: runFailureError, runId: activeRun.uuid },
                  `AgentExec: stream finalization failure record failed runId=${activeRun.uuid}`
                );
              });
            }

            throw error;
          } finally {
            clearHeartbeatTimer();
            AgentRunService.clearAbortController(activeRun.uuid);
          }
        },
        dispose: () => {
          clearHeartbeatTimer();
          AgentRunService.clearAbortController(activeRun.uuid);
        },
      };
    } catch (error) {
      try {
        if (error instanceof SessionWorkspaceGatewayUnavailableError) {
          await AgentSessionService.markSessionRuntimeFailure(session.uuid, error).catch((runtimeFailureError) => {
            getLogger().warn(
              { error: runtimeFailureError, sessionId: session.uuid },
              `Session: runtime failure record failed sessionId=${session.uuid}`
            );
          });
        }

        const failedRun = run || existingRun;
        if (error instanceof AgentRunOwnershipLostError) {
          throw error;
        }

        if (failedRun) {
          const failureOwner = failedRun.executionOwner || existingRun?.executionOwner || null;
          if (!failureOwner) {
            throw error;
          }

          await AgentRunService.markFailedForExecutionOwner(
            failedRun.uuid,
            failureOwner,
            error,
            observabilityTracker.getSummary(),
            { dispatchAttemptId }
          ).catch((runFailureError) => {
            if (runFailureError instanceof AgentRunOwnershipLostError) {
              throw runFailureError;
            }

            getLogger().warn(
              { error: runFailureError, runId: failedRun.uuid },
              `AgentExec: run failure record failed runId=${failedRun.uuid}`
            );
          });
        }

        throw error;
      } finally {
        clearHeartbeatTimer();
      }
    }
  }
}
