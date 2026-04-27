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

import { getToolName, isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UITools } from 'ai';
import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentRun from 'server/models/AgentRun';
import type AgentThread from 'server/models/AgentThread';
import type { Transaction } from 'objection';
import type {
  AgentApprovalPolicy,
  AgentCapabilityKey,
  AgentFileChangeData,
  AgentPendingActionStatus,
  AgentUIMessage,
} from './types';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import { listMessageFileChanges } from './fileChanges';
import AgentThreadService from './ThreadService';
import AgentRunQueueService from './RunQueueService';
import AgentRunEventService from './RunEventService';
import AgentPolicyService from './PolicyService';
import {
  buildAgentToolKey,
  CHAT_PUBLISH_HTTP_TOOL_NAME,
  LIFECYCLE_BUILTIN_SERVER_SLUG,
  SESSION_WORKSPACE_SERVER_SLUG,
} from './toolKeys';

type ToolLikePart = ToolUIPart<UITools> | DynamicToolUIPart;
const SESSION_WORKSPACE_TOOL_KEY_PREFIX = `mcp__${SESSION_WORKSPACE_SERVER_SLUG}__`;
const ARGUMENT_PREVIEW_MAX_LENGTH = 160;
const PENDING_ACTION_RESPONSE_FIELDS = new Set(['approved', 'reason']);

type PendingActionResponseBody = {
  approved: boolean;
  reason: string | null;
};

type ApprovalRequestSyncResult = {
  pendingActions: AgentPendingAction[];
  resolvedActionCount: number;
};

type ApprovalRequestSyncOptions = {
  thread: AgentThread;
  run: AgentRun;
  messages: AgentUIMessage[];
  capabilityKey?: AgentCapabilityKey;
  approvalPolicy?: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
  trx?: Transaction;
};

function isToolLikePart(part: unknown): part is ToolLikePart {
  return !!part && typeof part === 'object' && isToolUIPart(part as ToolLikePart);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function truncatePreview(value: string): string {
  return value.length > ARGUMENT_PREVIEW_MAX_LENGTH ? `${value.slice(0, ARGUMENT_PREVIEW_MAX_LENGTH - 3)}...` : value;
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === 'string') {
    return truncatePreview(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value == null) {
    return 'null';
  }

  try {
    return truncatePreview(JSON.stringify(value));
  } catch {
    return '[unserializable]';
  }
}

function summarizeArguments(input: unknown): Array<{ name: string; value: string }> {
  if (!isRecord(input)) {
    return [];
  }

  return Object.entries(input)
    .filter(([name]) => !['content', 'oldText', 'newText', 'command', 'cmd'].includes(name))
    .slice(0, 6)
    .map(([name, value]) => ({
      name,
      value: formatArgumentValue(value),
    }));
}

function getCommandPreview(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const command = readString(input.command) || readString(input.cmd);
  if (command) {
    return truncatePreview(command);
  }

  if (Array.isArray(input.command)) {
    const commandParts = input.command.filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0
    );
    return commandParts.length > 0 ? truncatePreview(commandParts.join(' ')) : null;
  }

  return null;
}

function summarizeFileChanges(value: unknown): Array<{
  path: string;
  action: string;
  summary: string;
  additions: number | null;
  deletions: number | null;
  truncated: boolean;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .slice(0, 10)
    .map((change) => {
      const path = readString(change.displayPath) || readString(change.path) || 'unknown';
      const action = readString(change.kind) || readString(change.stage) || 'change';
      return {
        path,
        action,
        summary: readString(change.summary) || `${action} ${path}`,
        additions: typeof change.additions === 'number' ? change.additions : null,
        deletions: typeof change.deletions === 'number' ? change.deletions : null,
        truncated: change.truncated === true,
      };
    });
}

function getRiskLabels(capabilityKey: string | null | undefined): string[] {
  switch (capabilityKey) {
    case 'workspace_write':
      return ['Workspace write'];
    case 'shell_exec':
      return ['Shell command'];
    case 'git_write':
      return ['Git write'];
    case 'network_access':
      return ['Network access'];
    case 'deploy_k8s_mutation':
      return ['Deployment change'];
    case 'external_mcp_write':
      return ['MCP write'];
    case 'external_mcp_read':
      return ['MCP read'];
    case 'read':
      return ['Read-only'];
    default:
      return [];
  }
}

function resolveApprovalCapabilityKey(toolName: string, fallback: AgentCapabilityKey): AgentCapabilityKey {
  if (toolName === buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, CHAT_PUBLISH_HTTP_TOOL_NAME)) {
    return 'deploy_k8s_mutation';
  }

  if (!toolName.startsWith(SESSION_WORKSPACE_TOOL_KEY_PREFIX)) {
    return fallback;
  }

  const sessionWorkspaceToolName = toolName.slice(SESSION_WORKSPACE_TOOL_KEY_PREFIX.length).replace(/_/g, '.');

  return AgentPolicyService.capabilityForSessionWorkspaceTool(sessionWorkspaceToolName);
}

function shouldPersistApprovalRequest({
  toolName,
  fallbackCapabilityKey,
  approvalPolicy,
  toolRules,
}: {
  toolName: string;
  fallbackCapabilityKey: AgentCapabilityKey;
  approvalPolicy?: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
}): boolean {
  if (!approvalPolicy) {
    return true;
  }

  const capabilityKey = resolveApprovalCapabilityKey(toolName, fallbackCapabilityKey);
  const toolRule = toolRules?.find((rule) => rule.toolKey === toolName);
  const mode = toolRule?.mode || AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey);

  return mode === 'require_approval';
}

async function upsertApprovalRequestRecord({
  thread,
  run,
  approvalId,
  toolCallId,
  toolName,
  input,
  fileChanges,
  capabilityKey,
  trx,
}: {
  thread: AgentThread;
  run: AgentRun;
  approvalId: string;
  toolCallId: string | null;
  toolName: string;
  input: unknown;
  fileChanges?: AgentFileChangeData[];
  capabilityKey: AgentCapabilityKey;
  trx?: Transaction;
}): Promise<AgentPendingAction | null> {
  const existing = await AgentPendingAction.query(trx)
    .where({ runId: run.id, threadId: thread.id })
    .whereRaw(`payload->>'approvalId' = ?`, [approvalId])
    .first();

  const payload = {
    approvalId,
    toolCallId,
    toolName,
    input: input ?? null,
    ...(fileChanges?.length ? { fileChanges } : {}),
  };
  const resolvedCapabilityKey = resolveApprovalCapabilityKey(toolName, capabilityKey);

  if (existing) {
    if (existing.status !== 'pending') {
      return null;
    }

    return AgentPendingAction.query(trx).patchAndFetchById(existing.id, {
      capabilityKey: resolvedCapabilityKey,
      payload,
    } as Partial<AgentPendingAction>);
  }

  return AgentPendingAction.query(trx).insertAndFetch({
    threadId: thread.id,
    runId: run.id,
    kind: 'tool_approval',
    status: 'pending',
    capabilityKey: resolvedCapabilityKey,
    title: `Approve ${toolName}`,
    description: `${toolName} requires approval before it can run.`,
    payload,
    resolution: null,
    resolvedAt: null,
  } as Partial<AgentPendingAction>);
}

export default class ApprovalService {
  static normalizePendingActionResponseBody(body: unknown): PendingActionResponseBody | Error {
    if (!isRecord(body)) {
      return new Error('Request body must be a JSON object');
    }

    const unsupportedFields = Object.keys(body).filter((field) => !PENDING_ACTION_RESPONSE_FIELDS.has(field));
    if (unsupportedFields.length > 0) {
      return new Error(`Unsupported pending action response fields: ${unsupportedFields.join(', ')}`);
    }

    if (typeof body.approved !== 'boolean') {
      return new Error('approved must be a boolean');
    }

    if (body.reason != null && typeof body.reason !== 'string') {
      return new Error('reason must be a string when provided');
    }

    return {
      approved: body.approved,
      reason: typeof body.reason === 'string' ? body.reason : null,
    };
  }

  static async listPendingActions(threadUuid: string, userId: string): Promise<AgentPendingAction[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    return AgentPendingAction.query()
      .alias('action')
      .leftJoinRelated('[thread, run]')
      .where('action.threadId', thread.id)
      .where('action.status', 'pending')
      .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
      .orderBy('action.createdAt', 'asc');
  }

  static async upsertApprovalRequest({
    thread,
    run,
    message,
    toolPart,
    capabilityKey,
    trx,
  }: {
    thread: AgentThread;
    run: AgentRun;
    message: AgentUIMessage;
    toolPart: ToolLikePart;
    capabilityKey: AgentCapabilityKey;
    trx?: Transaction;
  }): Promise<AgentPendingAction | null> {
    const approvalId = toolPart.approval?.id;
    if (!approvalId) {
      throw new Error('Missing approval id');
    }

    const toolCallId = toolPart.toolCallId || null;
    const fileChanges = toolCallId
      ? listMessageFileChanges(message).filter((change) => change.toolCallId === toolCallId)
      : [];

    return upsertApprovalRequestRecord({
      thread,
      run,
      approvalId,
      toolCallId,
      toolName: getToolName(toolPart) || 'tool',
      input: toolPart.input,
      fileChanges,
      capabilityKey,
      trx,
    });
  }

  static async upsertApprovalRequestFromStream({
    thread,
    run,
    approvalId,
    toolCallId,
    toolName,
    input,
    fileChanges,
    capabilityKey = 'external_mcp_write',
    approvalPolicy,
    toolRules,
    trx,
  }: {
    thread: AgentThread;
    run: AgentRun;
    approvalId: string;
    toolCallId: string;
    toolName?: string | null;
    input?: unknown;
    fileChanges?: AgentFileChangeData[];
    capabilityKey?: AgentCapabilityKey;
    approvalPolicy?: AgentApprovalPolicy;
    toolRules?: AgentSessionToolRule[];
    trx?: Transaction;
  }): Promise<AgentPendingAction | null> {
    const resolvedToolName = toolName?.trim() || 'tool';

    if (
      !shouldPersistApprovalRequest({
        toolName: resolvedToolName,
        fallbackCapabilityKey: capabilityKey,
        approvalPolicy,
        toolRules,
      })
    ) {
      return null;
    }

    return upsertApprovalRequestRecord({
      thread,
      run,
      approvalId,
      toolCallId,
      toolName: resolvedToolName,
      input,
      fileChanges,
      capabilityKey,
      trx,
    });
  }

  static async syncApprovalRequestStateFromMessages({
    thread,
    run,
    messages,
    capabilityKey = 'external_mcp_write',
    approvalPolicy,
    toolRules,
    trx,
  }: ApprovalRequestSyncOptions): Promise<ApprovalRequestSyncResult> {
    const pendingActions: AgentPendingAction[] = [];
    let resolvedActionCount = 0;

    for (const message of messages) {
      if (message.role !== 'assistant') {
        continue;
      }

      for (const part of message.parts || []) {
        if (!isToolLikePart(part) || part.state !== 'approval-requested' || !part.approval?.id) {
          continue;
        }

        const toolName = getToolName(part) || 'tool';
        if (
          !shouldPersistApprovalRequest({
            toolName,
            fallbackCapabilityKey: capabilityKey,
            approvalPolicy,
            toolRules,
          })
        ) {
          continue;
        }

        const action = await this.upsertApprovalRequest({
          thread,
          run,
          message,
          toolPart: part,
          capabilityKey,
          trx,
        });
        if (action?.status === 'pending') {
          pendingActions.push(action);
        } else if (!action) {
          resolvedActionCount += 1;
        }
      }
    }

    return {
      pendingActions,
      resolvedActionCount,
    };
  }

  static async syncApprovalRequestsFromMessages(options: ApprovalRequestSyncOptions): Promise<AgentPendingAction[]> {
    const result = await this.syncApprovalRequestStateFromMessages(options);
    return result.pendingActions;
  }

  static async resolvePendingAction(
    actionUuid: string,
    userId: string,
    status: Extract<AgentPendingActionStatus, 'approved' | 'denied'>,
    resolution?: Record<string, unknown>,
    options: {
      githubToken?: string | null;
    } = {}
  ): Promise<AgentPendingAction> {
    const resolvedAt = new Date().toISOString();
    const resolvedActionPatch = {
      status,
      resolvedAt,
      resolution: resolution || {
        approved: status === 'approved',
      },
    } as Partial<AgentPendingAction>;
    const approved = status === 'approved';
    const eventNotifications: Array<{ runUuid: string; sequence: number }> = [];
    let runToEnqueue: string | null = null;

    const resumeRunIfApprovalBlocked = async (actionRun: AgentRun, runId: number, trx: Transaction) => {
      const remainingPendingAction = await AgentPendingAction.query(trx).where({ runId, status: 'pending' }).first();

      if (remainingPendingAction) {
        return;
      }

      if (actionRun.status === 'queued') {
        runToEnqueue = actionRun.uuid;
        return;
      }

      if (actionRun.status !== 'waiting_for_approval') {
        return;
      }

      const queuedRun = await AgentRun.query(trx).patchAndFetchById(actionRun.id, {
        status: 'queued',
        queuedAt: resolvedAt,
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      } as Partial<AgentRun>);
      const queuedSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
        queuedRun,
        'run.queued',
        {
          status: 'queued',
          error: queuedRun.error || null,
          usageSummary: queuedRun.usageSummary || {},
        },
        trx
      );
      if (queuedSequence) {
        eventNotifications.push({ runUuid: queuedRun.uuid, sequence: queuedSequence });
      }
      runToEnqueue = queuedRun.uuid;
    };

    const actionSeed = await AgentPendingAction.query()
      .alias('action')
      .joinRelated('[thread.session, run]')
      .where('action.uuid', actionUuid)
      .where('thread:session.userId', userId)
      .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
      .first();

    if (!actionSeed) {
      throw new Error('Pending action not found');
    }

    const updatedAction = await AgentPendingAction.transaction(async (trx) => {
      const actionRun = await AgentRun.query(trx).findById(actionSeed.runId).forUpdate();
      if (!actionRun) {
        throw new Error('Agent run not found');
      }

      const action = await AgentPendingAction.query(trx)
        .alias('action')
        .joinRelated('[thread, run]')
        .where('action.id', actionSeed.id)
        .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
        .forUpdate()
        .first();

      if (!action) {
        throw new Error('Pending action not found');
      }

      if (action.status !== 'pending') {
        await resumeRunIfApprovalBlocked(actionRun, action.runId, trx);
        return action;
      }

      await AgentPendingAction.query(trx).patchAndFetchById(action.id, resolvedActionPatch);

      const approvalId =
        typeof action.payload?.approvalId === 'string' && action.payload.approvalId.trim()
          ? action.payload.approvalId
          : null;
      const toolCallId =
        typeof action.payload?.toolCallId === 'string' && action.payload.toolCallId.trim()
          ? action.payload.toolCallId
          : null;

      if (approvalId) {
        const approvalEventPayload = {
          actionId: action.uuid,
          approvalId,
          toolCallId,
          approved,
          reason:
            resolution && typeof resolution.reason === 'string' && resolution.reason.trim()
              ? String(resolution.reason)
              : null,
        };
        const resolvedSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
          actionRun,
          'approval.resolved',
          approvalEventPayload,
          trx
        );
        if (resolvedSequence) {
          eventNotifications.push({ runUuid: actionRun.uuid, sequence: resolvedSequence });
        }
        const respondedSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
          actionRun,
          'approval.responded',
          approvalEventPayload,
          trx
        );
        if (respondedSequence) {
          eventNotifications.push({ runUuid: actionRun.uuid, sequence: respondedSequence });
        }
      }

      await resumeRunIfApprovalBlocked(actionRun, action.runId, trx);

      const currentAction = await AgentPendingAction.query(trx)
        .alias('action')
        .joinRelated('[thread, run]')
        .where('action.id', action.id)
        .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
        .first();

      if (!currentAction) {
        throw new Error('Pending action not found');
      }

      return currentAction;
    });

    for (const notification of eventNotifications) {
      await AgentRunEventService.notifyRunEventsInserted(notification.runUuid, notification.sequence);
    }

    if (runToEnqueue) {
      await AgentRunQueueService.enqueueRun(runToEnqueue, 'approval_resolved', {
        githubToken: options.githubToken,
      });
    }

    return updatedAction;
  }

  static serializePendingAction(action: AgentPendingAction) {
    const enrichedAction = action as AgentPendingAction & {
      threadUuid?: string;
      runUuid?: string;
      expiresAt?: string | null;
    };
    const payload = isRecord(action.payload) ? action.payload : {};
    const toolName = readString(payload.toolName);
    const input = payload.input;

    return {
      id: action.uuid,
      kind: action.kind,
      status: action.status,
      threadId: enrichedAction.threadUuid || String(action.threadId),
      runId: enrichedAction.runUuid || String(action.runId),
      title: action.title,
      description: action.description,
      requestedAt: action.createdAt || null,
      expiresAt: enrichedAction.expiresAt || null,
      toolName,
      argumentsSummary: summarizeArguments(input),
      commandPreview: getCommandPreview(input),
      fileChangePreview: summarizeFileChanges(payload.fileChanges),
      riskLabels: getRiskLabels(action.capabilityKey),
    };
  }
}
