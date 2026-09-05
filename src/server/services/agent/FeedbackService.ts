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

import AgentFeedback from 'server/models/AgentFeedback';
import AgentMessage from 'server/models/AgentMessage';
import AgentRun from 'server/models/AgentRun';
import AgentThreadService from './ThreadService';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import type { AgentFeedbackScope } from 'server/services/types/agentRuntimeConfig';
import { isDebugRunPlan } from './profileCapabilityResolver';
import { isAgentRunPlanSnapshotV1 } from './runPlanTypes';
import { TERMINAL_RUN_STATUSES } from './RunService';
import { normalizeCanonicalAgentMessageParts } from './canonicalMessages';
import { BadRequestError, ConflictError, NotFoundError } from 'server/lib/appError';
import { getUtcTimestamp } from 'server/lib/time';
import {
  MAX_AGENT_FEEDBACK_TEXT_LENGTH,
  MAX_AGENT_FEEDBACK_REASONS,
  AGENT_FEEDBACK_REASONS_BY_RATING,
  type AgentFeedbackInput,
  type AgentFeedbackReason,
  type AgentFeedbackRating,
  type AgentAdminFeedback,
  type SerializedAgentFeedback,
  type AgentThreadFeedback,
} from 'shared/types/agentFeedback';
import type AgentThread from 'server/models/AgentThread';

type FeedbackRow = AgentFeedback & { threadUuid: string; messageUuid: string | null };
type AdminFeedbackRow = FeedbackRow & Omit<AgentAdminFeedback, keyof SerializedAgentFeedback>;
type FeedbackMessage = AgentMessage & { runStatus: AgentRun['status'] | null; runPlanSnapshot: unknown };

const FEEDBACK_REPO_SQL = `COALESCE(
  (SELECT repo->>'repo' FROM jsonb_array_elements(session."workspaceRepos") WITH ORDINALITY AS repos(repo, position)
    ORDER BY (repo->>'primary' = 'true') DESC NULLS LAST, position ASC LIMIT 1),
  session."selectedServices"->0->>'repo',
  source."input"->'selectedDeploy'->>'repositoryFullName',
  source."input"->'pullRequest'->>'fullName'
)`;

export type AgentFeedbackTarget = { threadId: string; messageId?: string; userId: string };

export type AgentAdminFeedbackFilters = {
  page?: number;
  limit?: number;
  rating?: AgentFeedbackRating | 'all';
  scope?: 'thread' | 'message' | 'all';
  repo?: string;
  user?: string;
};

function validateUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestError('Feedback targets must use canonical UUIDs.', 'invalid_feedback_target');
  }
}

export function parseAgentFeedbackInput(body: unknown): AgentFeedbackInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('Feedback must be an object.', 'invalid_feedback');
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'rating' && key !== 'text' && key !== 'reasons')) {
    throw new BadRequestError('Feedback accepts only rating, text, and reasons.', 'invalid_feedback');
  }
  if (input.rating !== 'up' && input.rating !== 'down') {
    throw new BadRequestError('Rating must be "up" or "down".', 'invalid_feedback');
  }
  if (input.text !== undefined && input.text !== null && typeof input.text !== 'string') {
    throw new BadRequestError('Feedback text must be a string or null.', 'invalid_feedback');
  }
  if (typeof input.text === 'string' && Array.from(input.text).length > MAX_AGENT_FEEDBACK_TEXT_LENGTH) {
    throw new BadRequestError(
      `Feedback text must be at most ${MAX_AGENT_FEEDBACK_TEXT_LENGTH} characters.`,
      'invalid_feedback'
    );
  }
  const reasons = input.reasons === undefined ? [] : input.reasons;
  const allowedReasons: readonly string[] = AGENT_FEEDBACK_REASONS_BY_RATING[input.rating];
  if (
    !Array.isArray(reasons) ||
    reasons.length > MAX_AGENT_FEEDBACK_REASONS ||
    reasons.some((reason) => typeof reason !== 'string' || !allowedReasons.includes(reason)) ||
    new Set(reasons).size !== reasons.length
  ) {
    throw new BadRequestError(
      'Feedback reasons must be distinct supported reasons for the selected rating.',
      'invalid_feedback'
    );
  }
  return {
    rating: input.rating,
    text: typeof input.text === 'string' ? input.text.trim() || null : null,
    reasons: reasons as AgentFeedbackReason[],
  };
}

function serializeFeedback(row: AgentFeedback, threadId: string, messageId: string | null): SerializedAgentFeedback {
  return {
    id: row.uuid,
    threadId,
    messageId,
    rating: row.rating,
    text: row.text,
    reasons: row.reasons ?? [],
    createdAt: row.createdAt!,
    updatedAt: row.updatedAt!,
  };
}

function feedbackQuery() {
  return AgentFeedback.query()
    .alias('feedback')
    .join('agent_threads as thread', 'thread.id', 'feedback.threadId')
    .leftJoin('agent_messages as message', 'message.id', 'feedback.messageId')
    .select('feedback.*', 'thread.uuid as threadUuid', 'message.uuid as messageUuid');
}

function assistantMessageQuery(threadId: number) {
  return AgentMessage.query()
    .alias('message')
    .leftJoin('agent_runs as run', 'run.id', 'message.runId')
    .where({ 'message.threadId': threadId, 'message.role': 'assistant' })
    .select(
      'message.id',
      'message.uuid',
      'message.runId',
      'message.parts',
      'run.status as runStatus',
      'run.runPlanSnapshot'
    );
}

type FeedbackKind = 'debug' | 'chat';

function feedbackKindForRun(snapshot: unknown): FeedbackKind | null {
  if (
    !isAgentRunPlanSnapshotV1(snapshot) ||
    !snapshot.agent ||
    typeof snapshot.agent !== 'object' ||
    Array.isArray(snapshot.agent) ||
    typeof snapshot.agent.id !== 'string' ||
    !snapshot.agent.id.trim()
  )
    return null;
  if (snapshot.profile?.kind === 'debug' || isDebugRunPlan(snapshot)) return 'debug';
  if (
    snapshot.agent.id === 'system.agent' &&
    snapshot.agent.sourceKind === 'build_context_chat' &&
    !['answer', 'change', 'legacy'].includes(snapshot.profile?.kind)
  )
    return null;
  return ['build_context_chat', 'workspace_session', 'freeform_chat'].includes(snapshot.agent.sourceKind)
    ? 'chat'
    : null;
}

function isFinishedMessage(message: FeedbackMessage): boolean {
  return message.runId !== null && Boolean(message.runStatus) && TERMINAL_RUN_STATUSES.includes(message.runStatus!);
}

function hasFinishedContent(message: FeedbackMessage): boolean {
  return isFinishedMessage(message) && normalizeCanonicalAgentMessageParts(message.parts).length > 0;
}

async function feedbackScope(): Promise<AgentFeedbackScope> {
  return (await AgentRuntimeConfigService.getInstance().getEffectiveConfig())?.feedbackScope ?? 'debug';
}

function allowsFeedback(scope: AgentFeedbackScope, kind: FeedbackKind | null): boolean {
  return scope === 'all' || scope === kind;
}

async function canRateThread(
  thread: AgentThread,
  scope: AgentFeedbackScope,
  messages?: FeedbackMessage[]
): Promise<boolean> {
  const replies = messages ?? ((await assistantMessageQuery(thread.id)) as unknown as FeedbackMessage[]);
  if (!replies.some(hasFinishedContent)) return false;
  if (scope === 'all' || scope === 'none') return allowsFeedback(scope, null);
  const latestRun = await AgentRun.query()
    .where('threadId', thread.id)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .first();
  return latestRun ? allowsFeedback(scope, feedbackKindForRun(latestRun.runPlanSnapshot)) : false;
}

async function getOwnedThread(threadId: string, userId: string): Promise<AgentThread> {
  validateUuid(threadId);
  try {
    return await AgentThreadService.getOwnedThread(threadId, userId);
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent thread not found') {
      throw new NotFoundError('Agent thread not found');
    }
    throw error;
  }
}

async function resolveTarget(target: AgentFeedbackTarget) {
  const thread = await getOwnedThread(target.threadId, target.userId);
  if (target.messageId === undefined) return { thread, message: null };
  validateUuid(target.messageId);
  const message = (await assistantMessageQuery(thread.id).where('message.uuid', target.messageId).first()) as
    | FeedbackMessage
    | undefined;
  if (!message) throw new NotFoundError('Agent message not found');
  return { thread, message };
}

export default class AgentFeedbackService {
  static async listOwnedThreadFeedback(threadId: string, userId: string): Promise<AgentThreadFeedback> {
    const thread = await getOwnedThread(threadId, userId);
    const [feedback, scope, messages] = await Promise.all([
      this.listThreadFeedback(thread.id, userId),
      feedbackScope(),
      assistantMessageQuery(thread.id) as unknown as Promise<FeedbackMessage[]>,
    ]);
    return {
      feedback,
      canRateThread: await canRateThread(thread, scope, messages),
      eligibleMessageIds: messages
        .filter(
          (message) => hasFinishedContent(message) && allowsFeedback(scope, feedbackKindForRun(message.runPlanSnapshot))
        )
        .map((message) => message.uuid),
    };
  }

  static async listThreadFeedback(threadId: number, userId?: string): Promise<SerializedAgentFeedback[]> {
    const query = feedbackQuery().where('feedback.threadId', threadId).orderBy('feedback.id', 'asc');
    if (userId !== undefined) query.where('feedback.userId', userId);
    const rows = (await query) as FeedbackRow[];
    return rows.map((row) => serializeFeedback(row, row.threadUuid, row.messageUuid));
  }

  static async setFeedback(target: AgentFeedbackTarget, body: unknown): Promise<SerializedAgentFeedback> {
    const input = parseAgentFeedbackInput(body);
    const { thread, message } = await resolveTarget(target);
    if (message && !isFinishedMessage(message)) {
      throw new ConflictError('Wait for this response to finish before rating it.', 'feedback_message_not_finished');
    }
    const scope = await feedbackScope();
    const eligible = message
      ? hasFinishedContent(message) && allowsFeedback(scope, feedbackKindForRun(message.runPlanSnapshot))
      : await canRateThread(thread, scope);
    if (!eligible) {
      throw new ConflictError('Feedback is not enabled for this conversation.', 'feedback_not_enabled');
    }
    const patch = { ...input, updatedAt: getUtcTimestamp() };
    const row = await AgentFeedback.query()
      .insert({ threadId: thread.id, messageId: message?.id ?? null, userId: target.userId, ...input })
      .onConflict(
        message ? ['messageId', 'userId'] : AgentFeedback.knex().raw('("threadId", "userId") WHERE "messageId" IS NULL')
      )
      .merge(patch)
      .returning('*');
    return serializeFeedback(row, thread.uuid, message?.uuid ?? null);
  }

  static async deleteFeedback(target: AgentFeedbackTarget): Promise<{ deleted: boolean }> {
    const { thread, message } = await resolveTarget(target);
    const deleted = await AgentFeedback.query()
      .delete()
      .where({ threadId: thread.id, messageId: message?.id ?? null, userId: target.userId });
    return { deleted: deleted > 0 };
  }

  static async listAdminFeedback(filters: AgentAdminFeedbackFilters) {
    const { page = 1, limit = 25, rating = 'all', scope = 'all' } = filters;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger((page - 1) * limit)
    ) {
      throw new BadRequestError('Expected a positive page and a limit between 1 and 100.', 'invalid_feedback_filter');
    }
    if (!['all', 'up', 'down'].includes(rating) || !['all', 'thread', 'message'].includes(scope)) {
      throw new BadRequestError('Invalid feedback rating or scope filter.', 'invalid_feedback_filter');
    }
    const query = feedbackQuery()
      .join('agent_sessions as session', 'session.id', 'thread.sessionId')
      .leftJoin('agent_sources as source', 'source.sessionId', 'session.id')
      .select(
        'session.uuid as sessionId',
        'thread.title as threadTitle',
        'session.ownerGithubUsername',
        'session.buildUuid'
      )
      .select(AgentFeedback.knex().raw(`${FEEDBACK_REPO_SQL} as repo`));
    if (rating !== 'all') query.where('feedback.rating', rating);
    if (scope === 'thread') query.whereNull('feedback.messageId');
    if (scope === 'message') query.whereNotNull('feedback.messageId');
    const repo = filters.repo?.trim();
    const user = filters.user?.trim();
    if (repo) query.whereRaw(`${FEEDBACK_REPO_SQL} ILIKE ?`, [`%${repo}%`]);
    if (user)
      query.where((builder) =>
        builder
          .where('feedback.userId', 'ilike', `%${user}%`)
          .orWhere('session.ownerGithubUsername', 'ilike', `%${user}%`)
      );
    const result = await query
      .orderBy('feedback.updatedAt', 'desc')
      .orderBy('feedback.id', 'desc')
      .page(page - 1, limit);
    return {
      data: (result.results as AdminFeedbackRow[]).map(
        (row): AgentAdminFeedback => ({
          ...serializeFeedback(row, row.threadUuid, row.messageUuid),
          sessionId: row.sessionId,
          threadTitle: row.threadTitle,
          userId: row.userId,
          ownerGithubUsername: row.ownerGithubUsername,
          repo: row.repo,
          buildUuid: row.buildUuid,
        })
      ),
      metadata: {
        pagination: { current: page, total: Math.max(1, Math.ceil(result.total / limit)), items: result.total, limit },
      },
    };
  }
}
