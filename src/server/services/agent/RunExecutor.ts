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
import AgentRunService from './RunService';
import type { AgentFileChangeData, AgentUIMessage } from './types';
import { applyApprovalResponsesToFileChangeParts, buildResultFileChanges } from './fileChanges';
import { AgentRunTerminalFailure, SessionWorkspaceGatewayUnavailableError } from './errors';

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

export default class AgentRunExecutor {
  static async execute({
    session,
    thread,
    userIdentity,
    messages: _messages,
    requestedProvider,
    requestedModelId,
    requestApiKey,
    requestApiKeyProvider,
    onFileChange,
  }: {
    session: AgentSession;
    thread: AgentThread;
    userIdentity: RequestUserIdentity;
    messages: AgentUIMessage[];
    requestedProvider?: string;
    requestedModelId?: string;
    requestApiKey?: string | null;
    requestApiKeyProvider?: string | null;
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
      requestApiKey,
      requestApiKeyProvider,
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
    const sessionPrompt = await AgentSessionService.getSessionAppendSystemPrompt(
      session.uuid,
      repoFullName,
      effectiveSessionConfig.appendSystemPrompt
    );
    let run: Awaited<ReturnType<typeof AgentRunService.createRun>> | null = null;

    const requireRun = () => {
      if (!run) {
        throw new Error('Agent run has not been initialized.');
      }

      return run;
    };

    try {
      const tools = await AgentCapabilityService.buildToolSet({
        session,
        repoFullName,
        userIdentity,
        approvalPolicy,
        workspaceToolDiscoveryTimeoutMs: effectiveSessionConfig.workspaceToolDiscoveryTimeoutMs,
        workspaceToolExecutionTimeoutMs: effectiveSessionConfig.workspaceToolExecutionTimeoutMs,
        toolRules: effectiveSessionConfig.toolRules,
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
            const fileChanges = audit.toolCallId
              ? buildResultFileChanges({
                  toolCallId: audit.toolCallId,
                  sourceTool: audit.toolName,
                  input: audit.args,
                  result: audit.result,
                  failed: audit.status === 'failed',
                })
              : [];
            await AgentToolExecution.query().patchAndFetchById(execution.id, {
              status: audit.status,
              result: {
                value: audit.result,
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

      run = await AgentRunService.createRun({
        thread,
        session,
        provider: selection.provider,
        model: selection.modelId,
        policy: approvalPolicy,
      });
      const controller = new AbortController();
      AgentRunService.registerAbortController(run.uuid, controller);
      const agent = new ToolLoopAgent({
        model,
        instructions: buildSystemPrompt([effectiveSessionConfig.systemPrompt, sessionPrompt]),
        tools,
        stopWhen: stepCountIs(effectiveSessionConfig.maxIterations),
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

            await AgentRunService.patchRun(run.uuid, {
              usageSummary: usageSummary as Record<string, unknown>,
            });
            await touchSessionActivity();
          } catch (error) {
            getLogger().warn(
              { error, runId: run.uuid },
              `AgentExec: step observability patch failed runId=${run.uuid}`
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
        run,
        agent,
        abortSignal: controller.signal,
        selection,
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
            const messagesWithApprovalStages = applyApprovalResponsesToFileChangeParts(updatedMessages);
            const messagesWithObservability = applyFinalObservabilityToMessages(
              messagesWithApprovalStages,
              run.uuid,
              buildMessageObservabilityMetadataPatch(observabilitySummary)
            );
            const persistedMessages = await AgentMessageStore.syncMessages(
              thread.uuid,
              userIdentity.userId,
              messagesWithObservability,
              run.uuid
            );
            const pendingApprovals = await ApprovalService.syncApprovalRequestsFromMessages({
              thread,
              run,
              messages: persistedMessages,
            });
            await touchSessionActivity();

            const currentRun = await AgentRunService.getRunByUuid(run.uuid);
            if (currentRun?.status === 'cancelled') {
              return;
            }

            if (pendingApprovals.length > 0) {
              await AgentRunService.patchStatus(run.uuid, 'waiting_for_approval', {
                usageSummary: observabilitySummary as Record<string, unknown>,
                streamState: {
                  finishReason: finishReason || null,
                },
              });
              return;
            }

            const terminalFailure = classifyTerminalRunFailure({
              finishReason,
              maxIterations: effectiveSessionConfig.maxIterations,
            });
            if (terminalFailure) {
              await AgentRunService.markFailed(run.uuid, terminalFailure, observabilitySummary, {
                finishReason: finishReason || null,
              });
              return;
            }

            await AgentRunService.markCompleted(run.uuid, observabilitySummary, {
              finishReason: finishReason || null,
            });
          } catch (error) {
            await AgentRunService.markFailed(run.uuid, error, observabilitySummary, {
              finishReason: finishReason || null,
            }).catch((runFailureError) => {
              getLogger().warn(
                { error: runFailureError, runId: run.uuid },
                `AgentExec: stream finalization failure record failed runId=${run.uuid}`
              );
            });

            throw error;
          }
        },
      };
    } catch (error) {
      if (error instanceof SessionWorkspaceGatewayUnavailableError) {
        await AgentSessionService.markSessionRuntimeFailure(session.uuid, error).catch((runtimeFailureError) => {
          getLogger().warn(
            { error: runtimeFailureError, sessionId: session.uuid },
            `Session: runtime failure record failed sessionId=${session.uuid}`
          );
        });
      }

      if (run) {
        await AgentRunService.markFailed(run.uuid, error, observabilityTracker.getSummary()).catch(
          (runFailureError) => {
            getLogger().warn(
              { error: runFailureError, runId: run.uuid },
              `AgentExec: run failure record failed runId=${run.uuid}`
            );
          }
        );
      }

      throw error;
    }
  }
}
