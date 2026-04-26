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

import { stepCountIs, ToolLoopAgent } from 'ai';
import { randomBytes } from 'crypto';
import os from 'os';
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
import AgentRunQueueService from './RunQueueService';
import AgentRunService from './RunService';
import type { AgentFileChangeData, AgentUIMessage } from './types';
import { applyApprovalResponsesToFileChangeParts, buildResultFileChanges } from './fileChanges';
import { AgentRunTerminalFailure, SessionWorkspaceGatewayUnavailableError } from './errors';
import { limitDurablePayloadValue } from './payloadLimits';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';

function buildSystemPrompt(parts: Array<string | undefined>): string | undefined {
  const normalized = parts.map((part) => part?.trim()).filter(Boolean) as string[];
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.join('\n\n');
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
  const runtimeOptions = run?.policySnapshot?.runtimeOptions;
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
    existingRun,
    dispatchAttemptId,
    onFileChange,
  }: {
    session: AgentSession;
    thread: AgentThread;
    userIdentity: RequestUserIdentity;
    messages: AgentUIMessage[];
    requestedProvider?: string;
    requestedModelId?: string;
    requestGitHubToken?: string | null;
    existingRun?: AgentRun;
    dispatchAttemptId?: string;
    onFileChange?: (change: AgentFileChangeData) => Promise<void> | void;
  }) {
    const { repoFullName, approvalPolicy } = await AgentCapabilityService.resolveSessionContext(
      session.uuid,
      userIdentity
    );
    const selection = await AgentProviderRegistry.resolveSelection({
      repoFullName,
      requestedProvider,
      requestedModelId,
    });
    const model = await AgentProviderRegistry.createLanguageModel({
      repoFullName,
      selection,
      userIdentity,
    });
    const observabilityTracker = new AgentRunObservabilityTracker();
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
    const runMaxIterations = readRunMaxIterations(existingRun);
    const runControlPlaneConfig = {
      ...effectiveSessionConfig,
      ...(runMaxIterations ? { maxIterations: runMaxIterations } : {}),
    };
    const sessionPrompt = await AgentSessionService.getSessionAppendSystemPrompt(
      session.uuid,
      repoFullName,
      runControlPlaneConfig.appendSystemPrompt
    );
    let run: Awaited<ReturnType<typeof AgentRunService.createRun>> | null = null;
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
      const tools = await AgentCapabilityService.buildToolSet({
        session,
        repoFullName,
        userIdentity,
        approvalPolicy,
        workspaceToolDiscoveryTimeoutMs: runControlPlaneConfig.workspaceToolDiscoveryTimeoutMs,
        workspaceToolExecutionTimeoutMs: runControlPlaneConfig.workspaceToolExecutionTimeoutMs,
        requestGitHubToken,
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
              approved: pendingAction?.status === 'approved' ? true : pendingAction?.status === 'denied' ? false : null,
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
                value: limitDurablePayloadValue(audit.result, durability),
                ...(fileChanges.length > 0 ? { fileChanges } : {}),
              },
              completedAt,
              durationMs: calculateDurationMs(execution.startedAt, completedAt),
            } as Partial<AgentToolExecution>);
          },
          onFileChange: async (change) => {
            await onFileChange?.(change);
          },
        },
      });

      if (existingRun) {
        if (!existingRun.executionOwner) {
          throw new Error('Agent run execution owner is required.');
        }

        run = await AgentRunService.startRunForExecutionOwner(
          existingRun.uuid,
          existingRun.executionOwner,
          {
            resolvedHarness: existingRun.requestedHarness || session.defaultHarness || 'lifecycle_ai_sdk',
            provider: selection.provider,
            model: selection.modelId,
            sandboxGeneration: existingRun.sandboxGeneration,
          },
          { dispatchAttemptId }
        );
      } else {
        const queuedRun = await AgentRunService.createQueuedRun({
          thread,
          session,
          policy: approvalPolicy,
          requestedHarness: session.defaultHarness,
          requestedProvider,
          requestedModel: requestedModelId,
          resolvedHarness: session.defaultHarness || 'lifecycle_ai_sdk',
          resolvedProvider: selection.provider,
          resolvedModel: selection.modelId,
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
            resolvedHarness: session.defaultHarness || 'lifecycle_ai_sdk',
            provider: selection.provider,
            model: selection.modelId,
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
      const agent = new ToolLoopAgent({
        model,
        instructions: buildSystemPrompt([runControlPlaneConfig.systemPrompt, sessionPrompt]),
        tools,
        stopWhen: stepCountIs(runControlPlaneConfig.maxIterations),
        onStepFinish: async (step) => {
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
        onFinish: (event) => {
          observabilityTracker.finalize({
            usage: (event as { totalUsage?: unknown }).totalUsage as
              | Parameters<AgentRunObservabilityTracker['finalize']>[0]['usage']
              | undefined,
            providerMetadata: (event as { providerMetadata?: unknown }).providerMetadata as
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
            response: (event as { response?: unknown }).response as
              | Parameters<AgentRunObservabilityTracker['finalize']>[0]['response']
              | undefined,
          });
        },
      });

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
          isAborted: _isAborted,
        }: {
          messages: AgentUIMessage[];
          finishReason?: string;
          isAborted: boolean;
        }) => {
          const observabilitySummary = observabilityTracker.getSummary();
          try {
            if (!activeExecutionOwner) {
              throw new Error('Agent run execution owner is required.');
            }

            const messagesWithApprovalStages = applyApprovalResponsesToFileChangeParts(updatedMessages);
            const messagesWithObservability = applyFinalObservabilityToMessages(
              messagesWithApprovalStages,
              activeRun.uuid,
              buildMessageObservabilityMetadataPatch(observabilitySummary)
            );
            const terminalFailure = classifyTerminalRunFailure({
              finishReason,
              maxIterations: runControlPlaneConfig.maxIterations,
            });
            const completedAt = new Date().toISOString();

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

                if (approvalSync.pendingActions.length > 0) {
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
              await AgentRunQueueService.enqueueRun(finalizedRun.uuid, 'approval_resolved', {
                githubToken: requestGitHubToken,
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
