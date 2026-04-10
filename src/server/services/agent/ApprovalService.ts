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
import type AgentRun from 'server/models/AgentRun';
import type AgentThread from 'server/models/AgentThread';
import type { AgentCapabilityKey, AgentPendingActionStatus, AgentUIMessage } from './types';
import { addFileChangesToApprovalPayload } from './fileChanges';
import AgentThreadService from './ThreadService';

type ToolLikePart = ToolUIPart<UITools> | DynamicToolUIPart;

function isToolLikePart(part: unknown): part is ToolLikePart {
  return !!part && typeof part === 'object' && isToolUIPart(part as ToolLikePart);
}

export default class ApprovalService {
  static async listPendingActions(threadUuid: string, userId: string): Promise<AgentPendingAction[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    return AgentPendingAction.query()
      .alias('action')
      .leftJoinRelated('[thread, run]')
      .where('action.threadId', thread.id)
      .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
      .orderBy('action.createdAt', 'asc');
  }

  static async upsertApprovalRequest({
    thread,
    run,
    message,
    toolPart,
    capabilityKey,
  }: {
    thread: AgentThread;
    run: AgentRun;
    message: AgentUIMessage;
    toolPart: ToolLikePart;
    capabilityKey: AgentCapabilityKey;
  }): Promise<AgentPendingAction> {
    const approvalId = toolPart.approval?.id;
    if (!approvalId) {
      throw new Error('Missing approval id');
    }

    const existing = await AgentPendingAction.query()
      .where({ runId: run.id, threadId: thread.id })
      .whereRaw(`payload->>'approvalId' = ?`, [approvalId])
      .first();

    const payload = addFileChangesToApprovalPayload({
      payload: {
        approvalId,
        toolCallId: toolPart.toolCallId || null,
        toolName: getToolName(toolPart) || 'tool',
        input: toolPart.input || null,
      },
      message,
      toolCallId: toolPart.toolCallId || null,
    });

    if (existing) {
      return AgentPendingAction.query().patchAndFetchById(existing.id, {
        status: 'pending',
        payload,
      } as Partial<AgentPendingAction>);
    }

    return AgentPendingAction.query().insertAndFetch({
      threadId: thread.id,
      runId: run.id,
      kind: 'tool_approval',
      status: 'pending',
      capabilityKey,
      title: `Approve ${payload.toolName}`,
      description: `${payload.toolName} requires approval before it can run.`,
      payload,
      resolution: null,
      resolvedAt: null,
    } as Partial<AgentPendingAction>);
  }

  static async syncApprovalResponsesFromMessages(
    threadUuid: string,
    userId: string,
    messages: AgentUIMessage[]
  ): Promise<void> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);

    for (const message of messages) {
      for (const part of message.parts || []) {
        if (!isToolLikePart(part) || part.state !== 'approval-responded' || !part.approval?.id) {
          continue;
        }

        const pending = await AgentPendingAction.query()
          .alias('action')
          .joinRelated('run')
          .where('action.threadId', thread.id)
          .where('action.status', 'pending')
          .whereRaw(`action.payload->>'approvalId' = ?`, [part.approval.id])
          .modify((queryBuilder) => {
            if (part.toolCallId) {
              queryBuilder.whereRaw(`action.payload->>'toolCallId' = ?`, [part.toolCallId]);
            }

            if (typeof message.metadata?.runId === 'string' && message.metadata.runId.trim()) {
              queryBuilder.where('run.uuid', message.metadata.runId);
            }
          })
          .select('action.*')
          .orderBy('action.createdAt', 'desc')
          .first();

        if (!pending) {
          continue;
        }

        const approved = part.approval.approved === true;
        await AgentPendingAction.query().patchAndFetchById(pending.id, {
          status: approved ? 'approved' : 'denied',
          resolvedAt: new Date().toISOString(),
          resolution: {
            approved,
            reason: part.approval.reason || null,
            source: 'message',
          },
        } as Partial<AgentPendingAction>);
      }
    }
  }

  static async syncApprovalRequestsFromMessages({
    thread,
    run,
    messages,
    capabilityKey = 'external_mcp_write',
  }: {
    thread: AgentThread;
    run: AgentRun;
    messages: AgentUIMessage[];
    capabilityKey?: AgentCapabilityKey;
  }): Promise<AgentPendingAction[]> {
    const created: AgentPendingAction[] = [];

    for (const message of messages) {
      if (message.role !== 'assistant') {
        continue;
      }

      for (const part of message.parts || []) {
        if (!isToolLikePart(part) || part.state !== 'approval-requested' || !part.approval?.id) {
          continue;
        }

        const action = await this.upsertApprovalRequest({
          thread,
          run,
          message,
          toolPart: part,
          capabilityKey,
        });
        created.push(action);
      }
    }

    return created;
  }

  static async resolvePendingAction(
    actionUuid: string,
    userId: string,
    status: Extract<AgentPendingActionStatus, 'approved' | 'denied'>,
    resolution?: Record<string, unknown>
  ): Promise<AgentPendingAction> {
    const action = await AgentPendingAction.query()
      .alias('action')
      .joinRelated('[thread.session, run]')
      .where('action.uuid', actionUuid)
      .where('thread:session.userId', userId)
      .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
      .first();

    if (!action) {
      throw new Error('Pending action not found');
    }

    await AgentPendingAction.query().patchAndFetchById(action.id, {
      status,
      resolvedAt: new Date().toISOString(),
      resolution: resolution || {
        approved: status === 'approved',
      },
    } as Partial<AgentPendingAction>);

    const updatedAction = await AgentPendingAction.query()
      .alias('action')
      .joinRelated('[thread, run]')
      .where('action.id', action.id)
      .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
      .first();

    if (!updatedAction) {
      throw new Error('Pending action not found');
    }

    return updatedAction;
  }

  static serializePendingAction(action: AgentPendingAction) {
    const enrichedAction = action as AgentPendingAction & {
      threadUuid?: string;
      runUuid?: string;
    };

    return {
      id: action.uuid,
      threadId: enrichedAction.threadUuid || String(action.threadId),
      runId: enrichedAction.runUuid || String(action.runId),
      kind: action.kind,
      status: action.status,
      capabilityKey: action.capabilityKey,
      title: action.title,
      description: action.description,
      payload: action.payload || {},
      resolution: action.resolution,
      resolvedAt: action.resolvedAt,
      createdAt: action.createdAt || null,
      updatedAt: action.updatedAt || null,
    };
  }
}
