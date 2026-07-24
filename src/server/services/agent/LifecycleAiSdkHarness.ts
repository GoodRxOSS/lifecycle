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

import { type ToolSet, type UIMessageChunk } from 'ai';
import type AgentRunEvent from 'server/models/AgentRunEvent';
import type AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import { getLogger } from 'server/lib/logger';
import type { RequestUserIdentity } from 'server/lib/get-user';
import AgentMessageStore from './MessageStore';
import EnvironmentStateService from './EnvironmentStateService';
import { pruneStaleToolOutputsForModelInput, resolveModelContextWindowTokens } from './contextPruning';
import {
  applyConfiguredModelCostEstimate,
  buildMessageObservabilityMetadataPatch,
  normalizeSdkUsageSummary,
} from './observability';
import ApprovalService from './ApprovalService';
import AgentRunExecutor from './RunExecutor';
import AgentRunService from './RunService';
import AgentRunEventService, { RUN_ATTEMPT_RESTARTED_EVENT_TYPE } from './RunEventService';
import type { AgentFileChangeData, AgentUIDataParts, AgentUIMessage, AgentUIMessageMetadata } from './types';
import { applyApprovalResponsesToFileChangeParts } from './fileChanges';
import { AgentRunTerminalFailure } from './errors';
import type { Transaction } from 'objection';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';
import { loadAiSdk } from './aiSdkRuntime';
import {
  isToolMessagePart,
  normalizeUnavailableToolPartsForAgentInput,
  projectSystemEventMessagesForAgentInput,
} from './agentInputNormalization';
export { normalizeUnavailableToolPartsForAgentInput };
import { describeAgentStreamError } from './agentStreamErrorText';
import { collapseExactSelfRepeat } from './repeatedTextCollapse';
import type { AgentRuntimeContext } from './runtimeContext';
import type { AgentRequestGitHubAuth } from './githubAuth';
import type { AgentRunExecuteJob } from './RunQueueService';

type AgentUiMessageChunk = UIMessageChunk<AgentUIMessageMetadata, AgentUIDataParts>;
type ApprovalRequestDraft = {
  toolName?: string;
  input?: unknown;
  fileChangesById: Map<string, AgentFileChangeData>;
};
const CONTINUATION_EVENT_PAGE_LIMIT = 500;
const CONTINUATION_EVENT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

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

function readApprovalId(part: Record<string, unknown>): string | null {
  const approval =
    part.approval && typeof part.approval === 'object' ? (part.approval as Record<string, unknown>) : null;
  const approvalId = typeof approval?.id === 'string' && approval.id.trim() ? approval.id : null;

  return approvalId;
}

// Reason-less denials reach the model as a bare "Tool call execution denied.", which it confabulates causes for.
const DEFAULT_DENIAL_REASON =
  'The user declined this action in the approval prompt without giving a reason. Do not retry it or ' +
  'guess at technical causes; ask the user how they would like to proceed.';

function buildResolvedApproval(
  approvalId: string,
  existingApproval: Record<string, unknown>,
  response: ApprovalResponse
): Record<string, unknown> {
  return {
    ...existingApproval,
    id: approvalId,
    approved: response.approved,
    ...(response.reason ? { reason: response.reason } : response.approved ? {} : { reason: DEFAULT_DENIAL_REASON }),
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

type SafeValidateUIMessages = Awaited<ReturnType<typeof loadAiSdk>>['safeValidateUIMessages'];

/** Drops only validator-fatal parts so one poisoned part degrades the run instead of bricking the thread. */
export async function quarantineInvalidMessagesForAgentInput(
  messages: AgentUIMessage[],
  tools: ToolSet,
  safeValidateUIMessages: SafeValidateUIMessages
): Promise<AgentUIMessage[] | null> {
  const isValid = async (message: AgentUIMessage): Promise<boolean> =>
    (await safeValidateUIMessages({ messages: [message], tools: tools as never })).success;

  const kept: AgentUIMessage[] = [];
  let quarantined = false;

  for (const message of messages) {
    if (await isValid(message)) {
      kept.push(message);
      continue;
    }

    let parts = message.parts;
    while (parts.length > 0 && !(await isValid({ ...message, parts }))) {
      let culpritIndex = -1;
      for (let index = 0; index < parts.length; index += 1) {
        const trial = parts.filter((_, other) => other !== index);
        if (await isValid({ ...message, parts: trial })) {
          culpritIndex = index;
          break;
        }
      }
      parts = parts.filter((_, index) => index !== (culpritIndex === -1 ? parts.length - 1 : culpritIndex));
    }

    quarantined = true;
    if (parts.length > 0) {
      kept.push({ ...message, parts });
    }
  }

  return quarantined ? kept : null;
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
  const { safeValidateUIMessages } = await loadAiSdk();
  const validation = await safeValidateUIMessages({
    messages: normalizedMessages,
    tools: tools as never,
  });

  if (validation.success) {
    return validation.data as AgentUIMessage[];
  }

  const quarantined = await quarantineInvalidMessagesForAgentInput(normalizedMessages, tools, safeValidateUIMessages);
  if (quarantined) {
    const revalidation = await safeValidateUIMessages({ messages: quarantined, tools: tools as never });
    if (revalidation.success) {
      getLogger().warn(
        {
          error: (validation as { error?: unknown }).error,
          runId: runUuid,
          keptMessages: quarantined.length,
          ofMessages: normalizedMessages.length,
        },
        `AgentExec: quarantined invalid saved message parts runId=${runUuid}`
      );
      return revalidation.data as AgentUIMessage[];
    }
  }

  getLogger().warn(
    { error: (validation as { error?: unknown }).error, runId: runUuid },
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
  let payloadBytes = 0;

  // Paged to completion (every token delta is one row); the byte ceiling only guards worker memory.
  for (;;) {
    const page = await AgentRunEventService.listRunEventsPage(runUuid, {
      afterSequence,
      limit: CONTINUATION_EVENT_PAGE_LIMIT,
    });
    if (!page) {
      return [];
    }

    for (const event of page.events) {
      payloadBytes += event.payload ? JSON.stringify(event.payload).length : 0;
    }
    if (payloadBytes > CONTINUATION_EVENT_MAX_PAYLOAD_BYTES) {
      throw new AgentRunTerminalFailure({
        code: 'run_event_history_exhausted',
        message: 'This response grew too large to resume. Send a new message to continue the conversation.',
        details: { payloadBytes, eventCount: events.length + page.events.length },
      });
    }

    events.push(...page.events);
    if (page.events.length === 0 || !page.hasMore) {
      return events;
    }
    afterSequence = page.nextSequence;
  }
}

export async function rebuildAssistantMessageFromEvents(
  runUuid: string,
  options: { requireApprovalResponses?: boolean } = {}
): Promise<AgentUIMessage | null> {
  const allEvents = await listRunEventsForContinuation(runUuid);
  // Folding across a restart boundary would merge both attempts into one duplicated message.
  const lastRestartIndex = allEvents.map((event) => event.eventType).lastIndexOf(RUN_ATTEMPT_RESTARTED_EVENT_TYPE);
  const events = lastRestartIndex >= 0 ? allEvents.slice(lastRestartIndex + 1) : allEvents;
  const approvalResponses = extractApprovalResponses(events);
  if (options.requireApprovalResponses && approvalResponses.size === 0) {
    return null;
  }

  const chunks = AgentRunEventService.projectUiChunksFromEvents(events) as AgentUiMessageChunk[];
  let latestMessage: AgentUIMessage | null = null;
  const { readUIMessageStream } = await loadAiSdk();

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

  return latestMessage
    ? applyApprovalResponsesToToolParts(collapseSelfRepeatedTextParts(latestMessage), approvalResponses)
    : null;
}

// Replayed events can carry a self-repeated answer; keep it out of the model input.
function collapseSelfRepeatedTextParts(message: AgentUIMessage): AgentUIMessage {
  let changed = false;
  const parts = message.parts.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      return part;
    }

    const collapsed = collapseExactSelfRepeat(part.text);
    if (collapsed === part.text) {
      return part;
    }

    changed = true;
    return { ...part, text: collapsed };
  });

  return changed ? { ...message, parts } : message;
}

/**
 * Provider-load-bearing reasoning must reach the model on replay: Anthropic rejects a resumed
 * tool_use turn without its signed thinking block, and OpenAI reasoning models require their
 * reasoning items (itemId reference or encrypted content) alongside replayed function calls.
 * Gemini is safe to drop — thought signatures ride on tool-call/text parts, not reasoning parts.
 */
function isProviderLoadBearingReasoningPart(part: AgentUIMessage['parts'][number]): boolean {
  if (part.type !== 'reasoning') {
    return false;
  }

  const metadata = part.providerMetadata as
    | {
        anthropic?: { signature?: unknown; redactedData?: unknown };
        openai?: { itemId?: unknown; reasoningEncryptedContent?: unknown };
      }
    | undefined;
  return (
    typeof metadata?.anthropic?.signature === 'string' ||
    typeof metadata?.anthropic?.redactedData === 'string' ||
    typeof metadata?.openai?.itemId === 'string' ||
    typeof metadata?.openai?.reasoningEncryptedContent === 'string'
  );
}

/** Non-load-bearing prior-turn chain-of-thought is dead weight for the model — keep it for the UI, drop it from model input. */
function dropReasoningParts(messages: AgentUIMessage[]): AgentUIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') {
      return [message];
    }

    const parts = message.parts.filter((part) => part.type !== 'reasoning' || isProviderLoadBearingReasoningPart(part));
    if (parts.length === message.parts.length) {
      return [message];
    }

    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

async function loadMessagesForRun(
  run: AgentRun,
  thread: AgentThread,
  session: AgentSession
): Promise<AgentUIMessage[]> {
  const storedMessages = await AgentMessageStore.listMessages(thread.uuid, session.userId);
  const continuationMessage = run.startedAt
    ? await rebuildAssistantMessageFromEvents(run.uuid, { requireApprovalResponses: true })
    : null;
  if (!continuationMessage) {
    if (run.startedAt) {
      // Mark the attempt boundary so replays fold only the newest attempt.
      await AgentRunEventService.appendStatusEvent(run.uuid, RUN_ATTEMPT_RESTARTED_EVENT_TYPE, {});
    }
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
    roles: [],
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
  toolMetadata,
}: {
  thread: AgentThread;
  run: AgentRun;
  approvalPolicy: Awaited<ReturnType<typeof AgentRunExecutor.execute>>['approvalPolicy'];
  toolRules: Awaited<ReturnType<typeof AgentRunExecutor.execute>>['toolRules'];
  toolMetadata: Awaited<ReturnType<typeof AgentRunExecutor.execute>>['toolMetadata'];
}) {
  const draftsByToolCallId = new Map<string, ApprovalRequestDraft>();
  const handledApprovals = new Set<string>();

  const getDraft = (toolCallId: string): ApprovalRequestDraft => {
    const existing = draftsByToolCallId.get(toolCallId);
    if (existing) {
      return existing;
    }

    const draft: ApprovalRequestDraft = {
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

      const chunkRecord = chunk as Record<string, unknown>;
      const type = readStringField(chunkRecord, 'type');
      if (!type) {
        continue;
      }

      if (type === 'data-file-change') {
        const fileChange = readFileChangeData(chunkRecord.data);
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
        const toolName = readStringField(chunkRecord, 'toolName');
        if (toolName) {
          draft.toolName = toolName;
        }

        if (type === 'tool-input-available' && Object.prototype.hasOwnProperty.call(chunkRecord, 'input')) {
          draft.input = chunkRecord.input;
        }
        continue;
      }

      if (type !== 'tool-approval-request') {
        continue;
      }

      // Auto-approved calls (session allowlist) stream a request+response pair for the
      // transcript; persisting a pending action would strand the run in waiting_for_approval.
      if (chunkRecord.isAutomatic === true) {
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
          toolMetadata,
          trx: options.trx,
        });
        if (action) {
          chunkRecord.actionId = action.uuid;
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

// Coalesce chunk flushes to avoid a per-token insert+notify storm.
const STREAM_FLUSH_BATCH_SIZE = 10;
const STREAM_FLUSH_INTERVAL_MS = 50;
async function consumeStream(
  runUuid: string,
  executionOwner: string,
  stream: ReadableStream<AgentUiMessageChunk>,
  beforeAppendChunks?: (chunks: AgentUiMessageChunk[], options: { trx?: Transaction; run?: AgentRun }) => Promise<void>
): Promise<void> {
  const reader = stream.getReader();
  const batch: AgentUiMessageChunk[] = [];
  let lastFlushAt = Date.now();

  const flushBatch = async () => {
    if (batch.length === 0) {
      return;
    }
    const chunks = batch.splice(0, batch.length);
    await AgentRunService.appendStreamChunksForExecutionOwner(runUuid, executionOwner, chunks, {
      beforeAppendChunks: async ({ trx, run }) => {
        if (beforeAppendChunks) {
          await beforeAppendChunks(chunks, { trx, run });
        }
      },
    });
    lastFlushAt = Date.now();
  };

  try {
    let pendingRead: Promise<ReadableStreamReadResult<AgentUiMessageChunk>> | null = reader.read();
    while (pendingRead) {
      // Idle-flush: a burst ending in a tool call would otherwise sit unpersisted for the whole execution.
      let idleTimer: NodeJS.Timeout | null = null;
      const raced =
        batch.length > 0
          ? await Promise.race([
              pendingRead.then((result) => ({ kind: 'read' as const, result })),
              new Promise<{ kind: 'idle' }>((resolve) => {
                idleTimer = setTimeout(() => resolve({ kind: 'idle' }), STREAM_FLUSH_INTERVAL_MS);
              }),
            ])
          : { kind: 'read' as const, result: await pendingRead };
      if (idleTimer) {
        clearTimeout(idleTimer);
      }

      if (raced.kind === 'idle') {
        await flushBatch();
        continue;
      }

      const { value, done } = raced.result;
      if (done) {
        pendingRead = null;
        continue;
      }
      pendingRead = reader.read();

      if (!value) {
        continue;
      }

      batch.push(value);
      if (batch.length >= STREAM_FLUSH_BATCH_SIZE || Date.now() - lastFlushAt >= STREAM_FLUSH_INTERVAL_MS) {
        await flushBatch();
      }
    }

    await flushBatch();
  } finally {
    reader.releaseLock();
  }
}

export default class LifecycleAiSdkHarness {
  static async executeRun(
    run: AgentRun,
    options: {
      requestGitHubToken?: string | null;
      requestGitHubAuth?: AgentRequestGitHubAuth | null;
      dispatchAttemptId?: string;
      dispatchReason?: AgentRunExecuteJob['reason'];
    } = {}
  ): Promise<void> {
    const bootstrapStartedAt = Date.now();
    const thread = await AgentThread.query().findById(run.threadId);
    const session = await AgentSession.query().findById(run.sessionId);
    if (!thread || !session) {
      throw new Error('Agent run context not found');
    }

    const userIdentity = getSessionUserIdentity(session);
    // Freshest possible moment before the model reads the thread; idempotent per run, skipped on approval resume.
    await EnvironmentStateService.ensureRunStartStateEvent({
      session,
      thread,
      runUuid: run.uuid,
      runId: run.id,
      dispatchReason: options.dispatchReason,
    });
    const normalizedMessages = await loadMessagesForRun(run, thread, session);
    const loadMessagesMs = Date.now() - bootstrapStartedAt;
    const fileChangeStream = createChunkStream();
    const execution = await AgentRunExecutor.execute({
      session,
      thread,
      userIdentity,
      requestedProvider: run.resolvedProvider || run.requestedProvider || undefined,
      requestedModelId: run.resolvedModel || run.requestedModel || undefined,
      requestGitHubToken: options.requestGitHubToken,
      requestGitHubAuth: options.requestGitHubAuth,
      existingRun: run,
      dispatchAttemptId: options.dispatchAttemptId,
      dispatchReason: options.dispatchReason,
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
      toolMetadata: execution.toolMetadata,
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

    // Model input only — the outer stream persists agentInputMessages unchanged, so the UI keeps
    // the reasoning, full tool outputs, and system event rows (projection here must never persist).
    const modelInputMessages = pruneStaleToolOutputsForModelInput(
      dropReasoningParts(projectSystemEventMessagesForAgentInput(agentInputMessages)),
      {
        contextWindowTokens: resolveModelContextWindowTokens(execution.selection.modelId),
      }
    );

    // The UI stream's default onError masks failures as "An error occurred." and replaces the SDK's
    // own console logging; log the full error here (so worker logs keep the detail) and hand the user
    // an actionable message instead of a blank turn.
    const onStreamError = (error: unknown): string => {
      getLogger().error(
        { error, runId: run.uuid, provider: execution.selection.provider, model: execution.selection.modelId },
        `AgentExec: model stream error runId=${run.uuid}`
      );
      return describeAgentStreamError(error, {
        provider: execution.selection.provider,
        model: execution.selection.modelId,
      });
    };

    let agentUiMessageStream: ReadableStream<AgentUiMessageChunk>;
    try {
      const { createAgentUIStream } = await loadAiSdk();
      agentUiMessageStream = (await createAgentUIStream<
        never,
        typeof execution.agent.tools,
        AgentRuntimeContext,
        never,
        AgentUIMessageMetadata
      >({
        agent: execution.agent,
        uiMessages: modelInputMessages as never,
        originalMessages: modelInputMessages as never,
        generateMessageId: () => crypto.randomUUID(),
        abortSignal: execution.abortSignal,
        onError: onStreamError,
        onEnd: async ({ finishReason, isAborted }) => {
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
            const usage =
              (
                part as {
                  usage?: {
                    inputTokens?: number;
                    outputTokens?: number;
                    totalTokens?: number;
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
              ).usage ??
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
                }
              ).totalUsage ??
              undefined;
            const usageSummary = usage
              ? applyConfiguredModelCostEstimate(
                  normalizeSdkUsageSummary({
                    usage,
                    finishReason:
                      typeof (part as { finishReason?: unknown }).finishReason === 'string'
                        ? (part as { finishReason: string }).finishReason
                        : undefined,
                    rawFinishReason:
                      typeof (part as { rawFinishReason?: unknown }).rawFinishReason === 'string'
                        ? (part as { rawFinishReason: string }).rawFinishReason
                        : undefined,
                  }),
                  execution.selection
                )
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
    getLogger().info(
      `AgentExec: run bootstrap runId=${run.uuid} reason=${
        options.dispatchReason || 'submit'
      } loadMessagesMs=${loadMessagesMs} totalMs=${Date.now() - bootstrapStartedAt}`
    );

    const { createUIMessageStream } = await loadAiSdk();
    const uiMessageStream = createUIMessageStream<AgentUIMessage>({
      originalMessages: agentInputMessages,
      generateId: () => crypto.randomUUID(),
      onError: onStreamError,
      execute: ({ writer }) => {
        writer.merge(agentUiMessageStream as ReadableStream<AgentUiMessageChunk>);
        writer.merge(fileChangeStream.stream);
      },
      onEnd: async ({ messages }) => {
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
