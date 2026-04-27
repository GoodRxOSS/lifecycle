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

import {
  createAgentUIStream,
  createUIMessageStream,
  readUIMessageStream,
  safeValidateUIMessages,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';
import type AgentRunEvent from 'server/models/AgentRunEvent';
import type AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import { getLogger } from 'server/lib/logger';
import type { RequestUserIdentity } from 'server/lib/get-user';
import AgentMessageStore from './MessageStore';
import { buildMessageObservabilityMetadataPatch, normalizeSdkUsageSummary } from './observability';
import ApprovalService from './ApprovalService';
import AgentRunExecutor from './RunExecutor';
import AgentRunService from './RunService';
import AgentRunEventService from './RunEventService';
import type { AgentFileChangeData, AgentUIDataParts, AgentUIMessage, AgentUIMessageMetadata } from './types';
import { applyApprovalResponsesToFileChangeParts } from './fileChanges';
import { AgentRunTerminalFailure } from './errors';
import type { Transaction } from 'objection';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';

type AgentUiMessageChunk = UIMessageChunk<AgentUIMessageMetadata, AgentUIDataParts>;
const CONTINUATION_EVENT_PAGE_LIMIT = 500;
const CONTINUATION_EVENT_MAX_PAGES = 20;

type ApprovalResponse = {
  approved: boolean;
  reason?: string | null;
};

type StreamFinishPayload = {
  messages: AgentUIMessage[];
  finishReason?: string;
  isAborted: boolean;
};

function createChunkReplayStream(chunks: AgentUiMessageChunk[]): ReadableStream<AgentUiMessageChunk> {
  return new ReadableStream<AgentUiMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
}

function extractApprovalResponses(events: AgentRunEvent[]): Map<string, ApprovalResponse> {
  const responses = new Map<string, ApprovalResponse>();

  for (const event of events) {
    if (event.eventType !== 'approval.responded') {
      continue;
    }

    const payload = event.payload || {};
    const approvalId = typeof payload.approvalId === 'string' && payload.approvalId.trim() ? payload.approvalId : null;
    if (!approvalId || typeof payload.approved !== 'boolean') {
      continue;
    }

    responses.set(approvalId, {
      approved: payload.approved,
      reason: typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason : null,
    });
  }

  return responses;
}

function isToolMessagePart(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'));
}

function readApprovalId(part: Record<string, unknown>): string | null {
  const approval =
    part.approval && typeof part.approval === 'object' ? (part.approval as Record<string, unknown>) : null;
  const approvalId = typeof approval?.id === 'string' && approval.id.trim() ? approval.id : null;

  return approvalId;
}

function buildResolvedApproval(
  approvalId: string,
  existingApproval: Record<string, unknown>,
  response: ApprovalResponse
): Record<string, unknown> {
  return {
    ...existingApproval,
    id: approvalId,
    approved: response.approved,
    ...(response.reason ? { reason: response.reason } : {}),
  };
}

export function applyApprovalResponsesToToolParts(
  message: AgentUIMessage,
  responses: Map<string, ApprovalResponse>
): AgentUIMessage {
  if (responses.size === 0) {
    return message;
  }

  return {
    ...message,
    parts: message.parts.map((rawPart) => {
      if (!isToolMessagePart(rawPart)) {
        return rawPart;
      }

      const part = rawPart as Record<string, unknown>;
      const approval =
        part.approval && typeof part.approval === 'object' ? (part.approval as Record<string, unknown>) : {};
      const approvalId = readApprovalId(part);
      const response = approvalId ? responses.get(approvalId) : null;
      if (!approvalId || !response) {
        return rawPart;
      }

      const resolvedApproval = buildResolvedApproval(approvalId, approval, response);
      if (part.state === 'approval-requested' || part.state === 'approval-responded') {
        return {
          ...part,
          state: 'approval-responded',
          approval: resolvedApproval,
        } as AgentUIMessage['parts'][number];
      }

      if (response.approved && (part.state === 'output-available' || part.state === 'output-error')) {
        return {
          ...part,
          approval: resolvedApproval,
        } as AgentUIMessage['parts'][number];
      }

      if (!response.approved && part.state === 'output-denied') {
        return {
          ...part,
          approval: resolvedApproval,
        } as AgentUIMessage['parts'][number];
      }

      return rawPart;
    }),
  };
}

export function normalizeUnavailableToolPartsForAgentInput(
  messages: AgentUIMessage[],
  tools: ToolSet
): AgentUIMessage[] {
  const availableToolNames = new Set(Object.keys(tools));
  let messagesChanged = false;

  const normalizedMessages = messages.map((message) => {
    let messageChanged = false;
    const parts = message.parts.map((rawPart) => {
      if (!isToolMessagePart(rawPart)) {
        return rawPart;
      }

      const part = rawPart as Record<string, unknown>;
      const partType = typeof part.type === 'string' ? part.type : '';
      const staticToolName = partType.startsWith('tool-') ? partType.slice('tool-'.length) : null;
      let nextPart = part;
      let partChanged = false;

      if (staticToolName && !availableToolNames.has(staticToolName)) {
        nextPart = {
          ...nextPart,
          type: 'dynamic-tool',
          toolName: staticToolName,
        };
        partChanged = true;
      }

      if (
        (nextPart.state === 'output-available' ||
          nextPart.state === 'output-error' ||
          nextPart.state === 'output-denied') &&
        !Object.prototype.hasOwnProperty.call(nextPart, 'input')
      ) {
        nextPart = {
          ...nextPart,
          input: nextPart.rawInput,
        };
        partChanged = true;
      }

      if (!partChanged) {
        return rawPart;
      }

      messageChanged = true;
      return nextPart as AgentUIMessage['parts'][number];
    });

    if (!messageChanged) {
      return message;
    }

    messagesChanged = true;
    return {
      ...message,
      parts,
    };
  });

  return messagesChanged ? normalizedMessages : messages;
}

async function validateMessagesForAgentInput({
  runUuid,
  messages,
  tools,
}: {
  runUuid: string;
  messages: AgentUIMessage[];
  tools: ToolSet;
}): Promise<AgentUIMessage[]> {
  const normalizedMessages = normalizeUnavailableToolPartsForAgentInput(messages, tools);
  const validation = await safeValidateUIMessages({
    messages: normalizedMessages,
    tools,
  });

  if (validation.success) {
    return validation.data as AgentUIMessage[];
  }

  getLogger().warn(
    { error: validation.error, runId: runUuid },
    `AgentExec: saved message validation failed runId=${runUuid}`
  );

  throw new AgentRunTerminalFailure({
    code: 'run_resume_state_invalid',
    message:
      'Lifecycle could not resume this response because the saved run state is invalid. Send a new message to continue from the last saved chat state.',
    details: {
      reason: 'ui_message_validation',
    },
  });
}

function sanitizeAgentStreamError(runUuid: string, error: unknown): never {
  if (
    error instanceof Error &&
    (error.name === 'AI_TypeValidationError' || error.message.startsWith('Type validation failed'))
  ) {
    getLogger().warn({ error, runId: runUuid }, `AgentExec: stream validation failed runId=${runUuid}`);

    throw new AgentRunTerminalFailure({
      code: 'run_resume_state_invalid',
      message:
        'Lifecycle could not resume this response because the saved run state is invalid. Send a new message to continue from the last saved chat state.',
      details: {
        reason: 'ui_message_validation',
      },
    });
  }

  throw error;
}

async function listRunEventsForContinuation(runUuid: string): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  let afterSequence = 0;

  for (let pageIndex = 0; pageIndex < CONTINUATION_EVENT_MAX_PAGES; pageIndex += 1) {
    const page = await AgentRunEventService.listRunEventsPage(runUuid, {
      afterSequence,
      limit: CONTINUATION_EVENT_PAGE_LIMIT,
    });
    if (!page) {
      return [];
    }

    events.push(...page.events);
    afterSequence = page.nextSequence;
    if (!page.hasMore) {
      return events;
    }
  }

  throw new Error('Agent run event history is too large to rebuild approval continuation.');
}

async function rebuildAssistantMessageFromEvents(runUuid: string): Promise<AgentUIMessage | null> {
  const events = await listRunEventsForContinuation(runUuid);
  const approvalResponses = extractApprovalResponses(events);
  if (approvalResponses.size === 0) {
    return null;
  }

  const chunks = AgentRunEventService.projectUiChunksFromEvents(events) as AgentUiMessageChunk[];
  let latestMessage: AgentUIMessage | null = null;

  for await (const message of readUIMessageStream<AgentUIMessage>({
    stream: createChunkReplayStream(chunks),
    terminateOnError: false,
    onError: (error) => {
      getLogger().warn({ error, runId: runUuid }, `AgentExec: continuation replay skipped chunk runId=${runUuid}`);
    },
  })) {
    if (message.parts.length > 0) {
      latestMessage = message;
    }
  }

  return latestMessage ? applyApprovalResponsesToToolParts(latestMessage, approvalResponses) : null;
}

async function loadMessagesForRun(
  run: AgentRun,
  thread: AgentThread,
  session: AgentSession
): Promise<AgentUIMessage[]> {
  const storedMessages = await AgentMessageStore.listMessages(thread.uuid, session.userId);
  const continuationMessage = run.startedAt ? await rebuildAssistantMessageFromEvents(run.uuid) : null;
  if (!continuationMessage) {
    return applyApprovalResponsesToFileChangeParts(storedMessages);
  }

  return applyApprovalResponsesToFileChangeParts([
    ...storedMessages.filter((message) => message.metadata?.runId !== run.uuid),
    continuationMessage,
  ]);
}

function getSessionUserIdentity(session: AgentSession): RequestUserIdentity {
  const githubUsername = session.ownerGithubUsername || null;
  const displayName = githubUsername || session.userId;

  return {
    userId: session.userId,
    githubUsername,
    preferredUsername: githubUsername,
    email: null,
    firstName: null,
    lastName: null,
    displayName,
    gitUserName: displayName,
    gitUserEmail: githubUsername ? `${githubUsername}@users.noreply.github.com` : `${session.userId}@local.lifecycle`,
  };
}

function createChunkStream() {
  let controller: ReadableStreamDefaultController<AgentUiMessageChunk> | null = null;
  let closed = false;

  return {
    stream: new ReadableStream<AgentUiMessageChunk>({
      start(nextController) {
        controller = nextController;
        if (closed) {
          nextController.close();
          controller = null;
        }
      },
      cancel() {
        closed = true;
        controller = null;
      },
    }),
    write(chunk: AgentUiMessageChunk) {
      if (!closed && controller) {
        controller.enqueue(chunk);
      }
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      if (controller) {
        controller.close();
        controller = null;
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readFileChangeData(value: unknown): AgentFileChangeData | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.toolCallId !== 'string' ||
    typeof value.sourceTool !== 'string' ||
    typeof value.displayPath !== 'string' ||
    typeof value.stage !== 'string'
  ) {
    return null;
  }

  return value as unknown as AgentFileChangeData;
}

function createEagerApprovalRequestSync({
  thread,
  run,
  approvalPolicy,
  toolRules,
}: {
  thread: AgentThread;
  run: AgentRun;
  approvalPolicy: Awaited<ReturnType<typeof AgentRunExecutor.execute>>['approvalPolicy'];
  toolRules: Awaited<ReturnType<typeof AgentRunExecutor.execute>>['toolRules'];
}) {
  const draftsByToolCallId = new Map<
    string,
    {
      toolName?: string;
      input?: unknown;
      fileChangesById: Map<string, AgentFileChangeData>;
    }
  >();
  const handledApprovals = new Set<string>();

  const getDraft = (toolCallId: string) => {
    const existing = draftsByToolCallId.get(toolCallId);
    if (existing) {
      return existing;
    }

    const draft = {
      fileChangesById: new Map<string, AgentFileChangeData>(),
    };
    draftsByToolCallId.set(toolCallId, draft);
    return draft;
  };

  return async (chunks: AgentUiMessageChunk[], options: { trx?: Transaction; run?: AgentRun } = {}) => {
    for (const chunk of chunks) {
      if (!isRecord(chunk)) {
        continue;
      }

      const type = readStringField(chunk, 'type');
      if (!type) {
        continue;
      }

      if (type === 'data-file-change') {
        const fileChange = readFileChangeData(chunk.data);
        if (fileChange) {
          getDraft(fileChange.toolCallId).fileChangesById.set(fileChange.id, fileChange);
        }
        continue;
      }

      const toolCallId = readStringField(chunk, 'toolCallId');
      if (!toolCallId) {
        continue;
      }

      if (type === 'tool-input-start' || type === 'tool-input-available' || type === 'tool-input-error') {
        const draft = getDraft(toolCallId);
        const toolName = readStringField(chunk, 'toolName');
        if (toolName) {
          draft.toolName = toolName;
        }

        if (type === 'tool-input-available' && Object.prototype.hasOwnProperty.call(chunk, 'input')) {
          draft.input = chunk.input;
        }
        continue;
      }

      if (type !== 'tool-approval-request') {
        continue;
      }

      const approvalId = readStringField(chunk, 'approvalId');
      if (!approvalId) {
        continue;
      }

      const approvalKey = `${approvalId}:${toolCallId}`;
      if (handledApprovals.has(approvalKey)) {
        continue;
      }
      handledApprovals.add(approvalKey);

      const draft = getDraft(toolCallId);
      try {
        const action = await ApprovalService.upsertApprovalRequestFromStream({
          thread,
          run: options.run || run,
          approvalId,
          toolCallId,
          toolName: draft.toolName,
          input: draft.input,
          fileChanges: [...draft.fileChangesById.values()],
          approvalPolicy,
          toolRules,
          trx: options.trx,
        });
        if (action) {
          chunk.actionId = action.uuid;
        }
      } catch (error) {
        getLogger().warn(
          { error, runId: run.uuid, approvalId, toolCallId },
          `AgentExec: approval request persistence failed runId=${run.uuid} approvalId=${approvalId}`
        );
        throw error;
      }
    }
  };
}

async function consumeStream(
  runUuid: string,
  executionOwner: string,
  stream: ReadableStream<AgentUiMessageChunk>,
  beforeAppendChunks?: (chunks: AgentUiMessageChunk[], options: { trx?: Transaction; run?: AgentRun }) => Promise<void>
): Promise<void> {
  const reader = stream.getReader();
  const batch: AgentUiMessageChunk[] = [];

  try {
    let streamDone = false;
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        streamDone = true;
        continue;
      }

      if (!value) {
        continue;
      }

      batch.push(value);
      if (batch.length >= 10) {
        const chunks = batch.splice(0, batch.length);
        await AgentRunService.appendStreamChunksForExecutionOwner(runUuid, executionOwner, chunks, {
          beforeAppendChunks: ({ trx, run }) => beforeAppendChunks?.(chunks, { trx, run }),
        });
      }
    }

    if (batch.length > 0) {
      const chunks = batch.splice(0, batch.length);
      await AgentRunService.appendStreamChunksForExecutionOwner(runUuid, executionOwner, chunks, {
        beforeAppendChunks: ({ trx, run }) => beforeAppendChunks?.(chunks, { trx, run }),
      });
    }
  } finally {
    reader.releaseLock();
  }
}

export default class LifecycleAiSdkHarness {
  static async executeRun(
    run: AgentRun,
    options: {
      requestGitHubToken?: string | null;
      dispatchAttemptId?: string;
    } = {}
  ): Promise<void> {
    const thread = await AgentThread.query().findById(run.threadId);
    const session = await AgentSession.query().findById(run.sessionId);
    if (!thread || !session) {
      throw new Error('Agent run context not found');
    }

    const userIdentity = getSessionUserIdentity(session);
    const normalizedMessages = await loadMessagesForRun(run, thread, session);
    const fileChangeStream = createChunkStream();
    const execution = await AgentRunExecutor.execute({
      session,
      thread,
      userIdentity,
      messages: normalizedMessages,
      requestedProvider: run.resolvedProvider || run.requestedProvider || undefined,
      requestedModelId: run.resolvedModel || run.requestedModel || undefined,
      requestGitHubToken: options.requestGitHubToken,
      existingRun: run,
      dispatchAttemptId: options.dispatchAttemptId,
      onFileChange: async (change) => {
        fileChangeStream.write({
          type: 'data-file-change',
          id: change.id,
          data: change,
        });
      },
    });
    const syncApprovalRequestsBeforeAppend = createEagerApprovalRequestSync({
      thread,
      run: execution.run,
      approvalPolicy: execution.approvalPolicy,
      toolRules: execution.toolRules,
    });
    const executionOwner = execution.run.executionOwner;
    if (!executionOwner) {
      throw new Error('Agent run execution owner is required.');
    }

    let finishContext: {
      finishReason?: string;
      isAborted: boolean;
    } = {
      finishReason: undefined,
      isAborted: false,
    };
    let streamFinishPayload: StreamFinishPayload | null = null;

    const agentInputMessages = await validateMessagesForAgentInput({
      runUuid: run.uuid,
      messages: normalizedMessages,
      tools: execution.agent.tools,
    });

    let agentUiMessageStream: ReadableStream<AgentUiMessageChunk>;
    try {
      agentUiMessageStream = (await createAgentUIStream<
        never,
        typeof execution.agent.tools,
        never,
        AgentUIMessageMetadata
      >({
        agent: execution.agent,
        uiMessages: agentInputMessages,
        generateMessageId: () => crypto.randomUUID(),
        abortSignal: execution.abortSignal,
        onFinish: async ({ finishReason, isAborted }) => {
          finishContext = {
            finishReason,
            isAborted,
          };
          fileChangeStream.close();
        },
        messageMetadata: ({ part }) => {
          const eventType = (part as { type?: string }).type;
          if (eventType === 'start') {
            return {
              sessionId: session.uuid,
              threadId: thread.uuid,
              runId: execution.run.uuid,
              provider: execution.selection.provider,
              model: execution.selection.modelId,
              createdAt: new Date().toISOString(),
            };
          }

          if (eventType === 'finish') {
            const totalUsage =
              (
                part as {
                  totalUsage?: {
                    inputTokens?: number;
                    outputTokens?: number;
                    totalTokens?: number;
                    reasoningTokens?: number;
                    cachedInputTokens?: number;
                    inputTokenDetails?: {
                      cacheReadTokens?: number;
                      cacheWriteTokens?: number;
                      noCacheTokens?: number;
                    };
                    outputTokenDetails?: {
                      reasoningTokens?: number;
                      textTokens?: number;
                    };
                    raw?: unknown;
                  };
                  finishReason?: string;
                  rawFinishReason?: string;
                }
              ).totalUsage ?? undefined;
            const usageSummary = totalUsage
              ? normalizeSdkUsageSummary({
                  usage: totalUsage,
                  finishReason:
                    typeof (part as { finishReason?: unknown }).finishReason === 'string'
                      ? (part as { finishReason: string }).finishReason
                      : undefined,
                  rawFinishReason:
                    typeof (part as { rawFinishReason?: unknown }).rawFinishReason === 'string'
                      ? (part as { rawFinishReason: string }).rawFinishReason
                      : undefined,
                })
              : undefined;

            return {
              sessionId: session.uuid,
              threadId: thread.uuid,
              runId: execution.run.uuid,
              provider: execution.selection.provider,
              model: execution.selection.modelId,
              completedAt: new Date().toISOString(),
              ...(usageSummary ? buildMessageObservabilityMetadataPatch(usageSummary) : {}),
            };
          }

          return undefined;
        },
      })) as ReadableStream<AgentUiMessageChunk>;
    } catch (error) {
      sanitizeAgentStreamError(run.uuid, error);
    }

    const uiMessageStream = createUIMessageStream<AgentUIMessage>({
      originalMessages: agentInputMessages,
      generateId: () => crypto.randomUUID(),
      execute: ({ writer }) => {
        writer.merge(agentUiMessageStream as ReadableStream<AgentUiMessageChunk>);
        writer.merge(fileChangeStream.stream);
      },
      onFinish: async ({ messages }) => {
        streamFinishPayload = {
          messages,
          finishReason: finishContext.finishReason,
          isAborted: finishContext.isAborted,
        };
      },
    });

    try {
      await consumeStream(
        run.uuid,
        executionOwner,
        uiMessageStream as ReadableStream<AgentUiMessageChunk>,
        syncApprovalRequestsBeforeAppend
      );
      if (!streamFinishPayload) {
        throw new Error('Agent run stream finished without final message state.');
      }
      await execution.onStreamFinish(streamFinishPayload);
    } catch (error) {
      if (error instanceof AgentRunOwnershipLostError) {
        getLogger().info(
          {
            runId: run.uuid,
            owner: executionOwner,
            currentStatus: error.currentStatus || null,
            currentOwner: error.currentExecutionOwner || null,
          },
          `AgentExec: ownership lost runId=${run.uuid} owner=${executionOwner}`
        );
        throw error;
      }

      getLogger().warn({ error, runId: run.uuid }, `AgentExec: stream consumption failed runId=${run.uuid}`);
      await AgentRunService.markFailedForExecutionOwner(run.uuid, executionOwner, error, undefined, {
        dispatchAttemptId: options.dispatchAttemptId,
      });
      throw error;
    } finally {
      execution.dispose?.();
    }
  }
}
