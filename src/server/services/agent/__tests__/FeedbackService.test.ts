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

const mockFeedbackQuery = jest.fn();
const mockMessageQuery = jest.fn();
const mockRunQuery = jest.fn();
const mockSourceQuery = jest.fn();
const mockGetOwnedThread = jest.fn();
const mockConfig = jest.fn();
const mockRaw = jest.fn((sql: string, bindings?: unknown[]) => ({ sql, bindings }));

jest.mock('server/models/AgentFeedback', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockFeedbackQuery(...args),
    knex: () => ({ raw: mockRaw }),
  },
}));
jest.mock('server/models/AgentMessage', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockMessageQuery(...args) },
}));
jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockRunQuery(...args) },
}));
jest.mock('server/models/AgentSource', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockSourceQuery(...args) },
}));
jest.mock('../ThreadService', () => ({
  __esModule: true,
  default: { getOwnedThread: (...args: unknown[]) => mockGetOwnedThread(...args) },
}));
jest.mock('../RunService', () => ({ TERMINAL_RUN_STATUSES: ['completed', 'failed', 'cancelled', 'transitioned'] }));
jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getEffectiveConfig: mockConfig }) },
}));

import AgentFeedbackService, { parseAgentFeedbackInput } from '../FeedbackService';
import { AGENT_FEEDBACK_REASONS_BY_RATING, MAX_AGENT_FEEDBACK_TEXT_LENGTH } from 'shared/types/agentFeedback';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '00000000-0000-4000-8000-000000000002';
const FEEDBACK_ID = '00000000-0000-4000-8000-000000000003';
const USER_ID = 'oidc-user';
const thread = { id: 11, uuid: THREAD_ID, sessionId: 10 };
const debugPlan = {
  version: 1,
  agent: { id: 'system.agent', sourceKind: 'build_context_chat' },
  debug: { resolvedIntent: 'diagnose' },
};
const normalPlan = {
  version: 1,
  agent: { id: 'system.agent', sourceKind: 'freeform_chat' },
  profile: { kind: 'answer' },
};
const message = {
  id: 12,
  uuid: MESSAGE_ID,
  threadId: 11,
  role: 'assistant',
  parts: [{ type: 'text', text: 'The investigation is complete.' }],
  runId: 20,
  runStatus: 'completed',
  runPlanSnapshot: debugPlan,
};
const saved = {
  id: 13,
  uuid: FEEDBACK_ID,
  threadId: 11,
  messageId: 12,
  threadUuid: THREAD_ID,
  messageUuid: MESSAGE_ID,
  userId: USER_ID,
  rating: 'down',
  text: 'Wrong diagnosis',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
};
const target = { threadId: THREAD_ID, messageId: MESSAGE_ID, userId: USER_ID };

function query(result: unknown = []) {
  const builder: any = Promise.resolve(result);
  for (const method of [
    'alias',
    'join',
    'leftJoin',
    'select',
    'orderBy',
    'whereNull',
    'whereNotNull',
    'whereRaw',
    'orWhere',
    'insert',
    'onConflict',
    'merge',
    'returning',
    'delete',
  ])
    builder[method] = jest.fn(() => builder);
  builder.where = jest.fn((...args: unknown[]) => {
    if (typeof args[0] === 'function') args[0](builder);
    return builder;
  });
  builder.first = jest.fn().mockResolvedValue(result);
  builder.findOne = jest.fn().mockResolvedValue(result);
  builder.page = jest.fn().mockResolvedValue(result);
  return builder;
}

function assistantQuery(messages: Array<Record<string, unknown>> = [message]) {
  const builder = query(messages);
  builder.first.mockResolvedValue(messages[0]);
  return builder;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnedThread.mockResolvedValue(thread);
  mockConfig.mockResolvedValue({});
  mockMessageQuery.mockImplementation(() => assistantQuery());
  mockRunQuery.mockImplementation(() => query({ runPlanSnapshot: debugPlan }));
  mockSourceQuery.mockImplementation(() => query({ input: { buildUuid: 'build-1' } }));
  mockFeedbackQuery.mockImplementation(() => query(saved));
});

describe('feedback input', () => {
  it.each([
    null,
    [],
    1,
    'up',
    {},
    { rating: 'neutral' },
    { rating: 'up', text: false },
    { rating: 'up', userId: 'other-user' },
    { rating: 'down', messageId: MESSAGE_ID },
  ])('rejects invalid input %p', (body) => {
    expect(() => parseAgentFeedbackInput(body)).toThrow(
      expect.objectContaining({ httpStatus: 400, code: 'invalid_feedback' })
    );
  });
  it('normalizes comments and fully replaces omitted/blank text', () => {
    expect(parseAgentFeedbackInput({ rating: 'down', text: '  More context  ' })).toEqual({
      rating: 'down',
      text: 'More context',
      reasons: [],
    });
    for (const text of [undefined, null, '', '  \n '])
      expect(parseAgentFeedbackInput({ rating: 'up', text })).toEqual({ rating: 'up', text: null, reasons: [] });
  });
  it.each([
    ['up', ['solved_task', 'clear_explanation', 'evidence_backed', 'actionable_steps', 'other']],
    [
      'down',
      [
        'incorrect_or_incomplete',
        'did_not_follow_instructions',
        'missing_evidence',
        'unhelpful_steps',
        'wrong_context',
        'too_slow',
        'other',
      ],
    ],
  ] as const)('preserves every supported %s reason alongside an optional comment', (rating, reasons) => {
    expect(parseAgentFeedbackInput({ rating, reasons, text: '  More context  ' })).toEqual({
      rating,
      reasons,
      text: 'More context',
    });
  });
  it.each([
    ['up', ['clear_explanation', 'evidence_backed', 'actionable_steps']],
    ['down', ['missing_evidence', 'unhelpful_steps', 'wrong_context', 'too_slow']],
  ] as const)('accepts new Lifecycle %s reasons only for their intended rating', (rating, reasons) => {
    expect(parseAgentFeedbackInput({ rating, reasons })).toEqual({ rating, reasons, text: null });
    for (const reason of reasons) {
      expect(() => parseAgentFeedbackInput({ rating: rating === 'up' ? 'down' : 'up', reasons: [reason] })).toThrow(
        expect.objectContaining({ httpStatus: 400, code: 'invalid_feedback' })
      );
    }
  });
  it.each(['up', 'down'] as const)('retains the seven-tag limit for %s reasons', (rating) => {
    const reasons = AGENT_FEEDBACK_REASONS_BY_RATING[rating].slice(0, 7);
    expect(parseAgentFeedbackInput({ rating, reasons }).reasons).toEqual(reasons);
    expect(() => parseAgentFeedbackInput({ rating, reasons: Array(8).fill('other') })).toThrow(
      expect.objectContaining({ httpStatus: 400, code: 'invalid_feedback' })
    );
  });
  it.each([
    ['up', 'followed_instructions'],
    ['up', 'good_quality'],
    ['up', 'efficient'],
    ['up', 'useful_autonomy'],
    ['down', 'wrong_scope'],
    ['down', 'lost_context'],
    ['down', 'slow_or_buggy'],
    ['down', 'safety_concern'],
  ] as const)('rejects removed %s reason %s before writing feedback', async (rating, reason) => {
    await expect(AgentFeedbackService.setFeedback(target, { rating, reasons: [reason] })).rejects.toMatchObject({
      httpStatus: 400,
      code: 'invalid_feedback',
    });
    expect(mockGetOwnedThread).not.toHaveBeenCalled();
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });
  it.each([
    { rating: 'up', reasons: null },
    { rating: 'up', reasons: 'solved_task' },
    { rating: 'up', reasons: {} },
    { rating: 'up', reasons: [false] },
    { rating: 'up', reasons: ['unknown'] },
    { rating: 'up', reasons: ['solved_task', 'solved_task'] },
    { rating: 'up', reasons: ['incorrect_or_incomplete'] },
    { rating: 'down', reasons: ['solved_task'] },
    { rating: 'down', reasons: Array(8).fill('other') },
  ])('rejects invalid reasons without silently dropping tags: %p', (body) => {
    expect(() => parseAgentFeedbackInput(body)).toThrow(
      expect.objectContaining({ httpStatus: 400, code: 'invalid_feedback' })
    );
  });
  it('enforces the Unicode character limit consistently with Postgres char_length', () => {
    expect(
      parseAgentFeedbackInput({ rating: 'up', text: '👍'.repeat(MAX_AGENT_FEEDBACK_TEXT_LENGTH) }).text
    ).toHaveLength(MAX_AGENT_FEEDBACK_TEXT_LENGTH * 2);
    expect(() =>
      parseAgentFeedbackInput({ rating: 'down', text: '👍'.repeat(MAX_AGENT_FEEDBACK_TEXT_LENGTH + 1) })
    ).toThrow(expect.objectContaining({ httpStatus: 400 }));
    expect(() =>
      parseAgentFeedbackInput({ rating: 'down', text: ' '.repeat(MAX_AGENT_FEEDBACK_TEXT_LENGTH + 1) })
    ).toThrow(expect.objectContaining({ httpStatus: 400 }));
  });
});

describe('owner and policy boundaries', () => {
  it.each(['list', 'set', 'delete'])(
    'returns the same 404 for absent or non-owned threads on %s',
    async (operation) => {
      mockGetOwnedThread.mockRejectedValue(new Error('Agent thread not found'));
      const work =
        operation === 'list'
          ? AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID)
          : operation === 'set'
          ? AgentFeedbackService.setFeedback(target, { rating: 'up' })
          : AgentFeedbackService.deleteFeedback(target);
      await expect(work).rejects.toMatchObject({ httpStatus: 404, message: 'Agent thread not found' });
      expect(mockGetOwnedThread).toHaveBeenCalledWith(THREAD_ID, USER_ID);
      expect(mockFeedbackQuery).not.toHaveBeenCalled();
      expect(mockMessageQuery).not.toHaveBeenCalled();
    }
  );
  it('does not disguise unexpected ownership-query failures', async () => {
    mockGetOwnedThread.mockRejectedValue(new Error('database unavailable'));
    await expect(AgentFeedbackService.deleteFeedback(target)).rejects.toThrow('database unavailable');
  });
  it('validates canonical UUIDs instead of matching client IDs or timestamps', async () => {
    await expect(
      AgentFeedbackService.setFeedback({ ...target, threadId: 'not-a-uuid' }, { rating: 'up' })
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      AgentFeedbackService.setFeedback({ ...target, messageId: 'client-message-1' }, { rating: 'up' })
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });
  it('restricts message targets to assistant messages within the owned thread', async () => {
    const messageQuery = query(undefined);
    messageQuery.first.mockResolvedValue(undefined);
    mockMessageQuery.mockReturnValue(messageQuery);
    await expect(AgentFeedbackService.setFeedback(target, { rating: 'up' })).rejects.toMatchObject({
      httpStatus: 404,
      message: 'Agent message not found',
    });
    expect(messageQuery.where).toHaveBeenCalledWith({ 'message.threadId': 11, 'message.role': 'assistant' });
    expect(messageQuery.where).toHaveBeenCalledWith('message.uuid', MESSAGE_ID);
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });
  it.each(['queued', 'starting', 'running', 'waiting_for_approval', 'waiting_for_input', null])(
    'rejects replies whose run is %s',
    async (runStatus) => {
      mockMessageQuery.mockReturnValue(query({ ...message, runStatus }));
      await expect(AgentFeedbackService.setFeedback(target, { rating: 'up' })).rejects.toMatchObject({
        httpStatus: 409,
        code: 'feedback_message_not_finished',
      });
      expect(mockFeedbackQuery).not.toHaveBeenCalled();
    }
  );
  it('rejects detached messages without a known finished run', async () => {
    mockMessageQuery.mockReturnValue(query({ ...message, runId: null, runStatus: null }));
    await expect(AgentFeedbackService.setFeedback(target, { rating: 'up' })).rejects.toMatchObject({
      code: 'feedback_message_not_finished',
    });
  });
  it('defaults to Debug feedback and rejects normal replies regardless of the latest thread run', async () => {
    mockMessageQuery.mockReturnValue(query({ ...message, runPlanSnapshot: normalPlan }));
    await expect(AgentFeedbackService.setFeedback(target, { rating: 'up' })).rejects.toMatchObject({
      code: 'feedback_not_enabled',
    });
    expect(mockRunQuery).not.toHaveBeenCalled();
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });
  it('uses the latest run for conversation feedback, including mixed histories', async () => {
    const runs = query({ runPlanSnapshot: normalPlan });
    mockRunQuery.mockReturnValue(runs);
    await expect(
      AgentFeedbackService.setFeedback({ threadId: THREAD_ID, userId: USER_ID }, { rating: 'up' })
    ).rejects.toMatchObject({ code: 'feedback_not_enabled' });
    expect(runs.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(runs.orderBy).toHaveBeenCalledWith('id', 'desc');
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });
  it.each([
    debugPlan,
    { version: 1, agent: { id: 'system.debug', sourceKind: 'build_context_chat' } },
    { version: 1, agent: { id: 'system.agent' }, profile: { kind: 'debug' } },
  ])('recognizes current and historical Debug run identities', async (runPlanSnapshot) => {
    mockMessageQuery.mockReturnValue(query({ ...message, runPlanSnapshot }));
    await expect(AgentFeedbackService.setFeedback(target, { rating: 'down' })).resolves.toMatchObject({
      id: FEEDBACK_ID,
    });
  });
  it('supports normal chats alongside Debug when the administrator opts into all', async () => {
    mockConfig.mockResolvedValue({ feedbackScope: 'all' });
    mockMessageQuery.mockReturnValue(assistantQuery([{ ...message, runPlanSnapshot: normalPlan }]));
    await expect(AgentFeedbackService.setFeedback(target, { rating: 'down' })).resolves.toMatchObject({
      id: FEEDBACK_ID,
    });
    await expect(
      AgentFeedbackService.setFeedback({ threadId: THREAD_ID, userId: USER_ID }, { rating: 'down' })
    ).resolves.toMatchObject({ messageId: null });
  });
  it.each([true, false])(
    'does not offer conversation feedback before a response, including build context: %s',
    async (hasBuild) => {
      mockRunQuery.mockReturnValue(query(null));
      mockSourceQuery.mockReturnValue(query({ input: hasBuild ? { buildUuid: 'build-1' } : {} }));
      mockMessageQuery.mockReturnValue(query([]));
      mockFeedbackQuery.mockReturnValue(query([]));
      await expect(AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID)).resolves.toEqual({
        feedback: [],
        canRateThread: false,
        eligibleMessageIds: [],
      });
    }
  );
});

describe('feedback collection modes', () => {
  const modes = [
    { scope: 'none', debug: false, chat: false },
    { scope: 'debug', debug: true, chat: false },
    { scope: 'chat', debug: false, chat: true },
    { scope: 'all', debug: true, chat: true },
  ] as const;
  const cases = modes.flatMap(({ scope, debug, chat }) => [
    { scope, kind: 'debug', plan: debugPlan, allowed: debug },
    { scope, kind: 'chat', plan: normalPlan, allowed: chat },
  ]);

  it.each(cases)(
    'applies $scope to $kind consistently for lists and both write targets',
    async ({ scope, plan, allowed }) => {
      mockConfig.mockResolvedValue({ feedbackScope: scope });
      mockMessageQuery.mockReturnValue(assistantQuery([{ ...message, runPlanSnapshot: plan }]));
      mockRunQuery.mockReturnValue(query({ runPlanSnapshot: plan }));
      mockFeedbackQuery.mockReturnValue(query([saved]));

      const result = await AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID);

      expect(result.canRateThread).toBe(allowed);
      expect(result.eligibleMessageIds).toEqual(allowed ? [MESSAGE_ID] : []);
      expect(result.feedback).toHaveLength(1);
      expect(mockMessageQuery).toHaveBeenCalledTimes(1);

      mockFeedbackQuery.mockClear().mockImplementation(() => query(saved));
      for (const feedbackTarget of [target, { threadId: THREAD_ID, userId: USER_ID }]) {
        const write = AgentFeedbackService.setFeedback(feedbackTarget, { rating: 'up' });
        if (allowed) await expect(write).resolves.toMatchObject({ id: FEEDBACK_ID });
        else await expect(write).rejects.toMatchObject({ httpStatus: 409, code: 'feedback_not_enabled' });
      }
      expect(mockFeedbackQuery).toHaveBeenCalledTimes(allowed ? 2 : 0);
    }
  );

  it.each(modes)(
    'rates mixed histories by response origin and the latest conversation run under $scope',
    async ({ scope, debug, chat }) => {
      const normalId = '00000000-0000-4000-8000-000000000099';
      mockConfig.mockResolvedValue({ feedbackScope: scope });
      mockFeedbackQuery.mockReturnValue(query([]));
      mockMessageQuery.mockReturnValue(
        assistantQuery([
          message,
          { ...message, uuid: normalId, runPlanSnapshot: normalPlan },
          { ...message, uuid: 'active-message', runStatus: 'running' },
        ])
      );
      mockRunQuery.mockReturnValue(query({ runPlanSnapshot: normalPlan }));

      const result = await AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID);

      expect(result.canRateThread).toBe(chat);
      expect(result.eligibleMessageIds).toEqual([...(debug ? [MESSAGE_ID] : []), ...(chat ? [normalId] : [])]);
    }
  );

  it.each(
    modes.flatMap(({ scope }) => [
      { scope, plan: null },
      { scope, plan: {} },
      { scope, plan: { version: 2, agent: { id: 'system.agent', sourceKind: 'freeform_chat' } } },
      { scope, plan: { version: 1, agent: {} } },
      { scope, plan: { version: 1, agent: { id: '', sourceKind: 'freeform_chat' } } },
      { scope, plan: { version: 1, agent: { id: 'system.agent', sourceKind: 'build_context_chat' } } },
    ])
  )('does not infer normal chat from an unknown snapshot under $scope: $plan', async ({ scope, plan }) => {
    mockConfig.mockResolvedValue({ feedbackScope: scope });
    mockMessageQuery.mockReturnValue(assistantQuery([{ ...message, runPlanSnapshot: plan }]));
    mockRunQuery.mockReturnValue(query({ runPlanSnapshot: plan }));
    mockFeedbackQuery.mockReturnValue(query([]));
    const allowed = scope === 'all';

    const result = await AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID);

    expect(result.canRateThread).toBe(allowed);
    expect(result.eligibleMessageIds).toEqual(allowed ? [MESSAGE_ID] : []);
    expect(mockSourceQuery).not.toHaveBeenCalled();
    mockFeedbackQuery.mockReturnValue(query(saved));
    for (const feedbackTarget of [target, { threadId: THREAD_ID, userId: USER_ID }]) {
      const write = AgentFeedbackService.setFeedback(feedbackTarget, { rating: 'up' });
      if (allowed) await expect(write).resolves.toMatchObject({ id: FEEDBACK_ID });
      else await expect(write).rejects.toMatchObject({ httpStatus: 409, code: 'feedback_not_enabled' });
    }
  });

  it.each([
    { label: 'no assistant responses', messages: [] },
    { label: 'first response still running', messages: [{ ...message, runStatus: 'running' }] },
    { label: 'empty assistant placeholder', messages: [{ ...message, parts: [] }] },
    { label: 'blank assistant text', messages: [{ ...message, parts: [{ type: 'text', text: '  ' }] }] },
    {
      label: 'unfinished tool part',
      messages: [{ ...message, parts: [{ type: 'tool_call', toolName: 'query_database' }] }],
    },
  ])('rejects conversation feedback with $label', async ({ messages }) => {
    mockConfig.mockResolvedValue({ feedbackScope: 'all' });
    mockMessageQuery.mockReturnValue(assistantQuery(messages));
    mockFeedbackQuery.mockReturnValue(query([saved]));

    const result = await AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID);

    expect(result.canRateThread).toBe(false);
    expect(result.eligibleMessageIds).toEqual([]);
    expect(result.feedback).toHaveLength(1);
    mockFeedbackQuery.mockClear();
    await expect(
      AgentFeedbackService.setFeedback({ threadId: THREAD_ID, userId: USER_ID }, { rating: 'up' })
    ).rejects.toMatchObject({ httpStatus: 409, code: 'feedback_not_enabled' });
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'text', text: 'Here is the diagnosis.' },
    { type: 'reasoning', text: 'The failing step identifies the dependency.' },
    { type: 'file_ref', path: 'lifecycle.yaml' },
    { type: 'source_ref', url: 'https://example.test/build/log' },
    { type: 'tool_call', toolName: 'query_database', toolCallId: 'call-1', state: 'completed' },
  ])('accepts a completed visible assistant part %p', async (part) => {
    mockConfig.mockResolvedValue({ feedbackScope: 'all' });
    mockMessageQuery.mockReturnValue(assistantQuery([{ ...message, parts: [part] }]));
    mockFeedbackQuery.mockReturnValue(query([]));

    const result = await AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID);

    expect(result.canRateThread).toBe(true);
    expect(result.eligibleMessageIds).toEqual([MESSAGE_ID]);
  });

  it('keeps saved ratings readable and removable when collection is disabled', async () => {
    mockConfig.mockResolvedValue({ feedbackScope: 'none' });
    mockMessageQuery.mockReturnValue(assistantQuery([]));
    mockFeedbackQuery.mockReturnValue(query([saved]));
    await expect(AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID)).resolves.toMatchObject({
      canRateThread: false,
      eligibleMessageIds: [],
      feedback: [expect.objectContaining({ id: FEEDBACK_ID })],
    });

    mockMessageQuery.mockReturnValue(assistantQuery());
    mockFeedbackQuery.mockReturnValue(query(1));
    for (const feedbackTarget of [target, { threadId: THREAD_ID, userId: USER_ID }]) {
      await expect(AgentFeedbackService.deleteFeedback(feedbackTarget)).resolves.toEqual({ deleted: true });
    }
  });

  it('does not infer conversation type if the latest run disappears after reading responses', async () => {
    mockConfig.mockResolvedValue({ feedbackScope: 'chat' });
    mockMessageQuery.mockReturnValue(assistantQuery([{ ...message, runPlanSnapshot: normalPlan }]));
    mockRunQuery.mockReturnValue(query(null));
    mockSourceQuery.mockReturnValue(query({ input: {} }));
    mockFeedbackQuery.mockReturnValue(query([]));

    await expect(AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID)).resolves.toMatchObject({
      canRateThread: false,
      eligibleMessageIds: [MESSAGE_ID],
    });
    await expect(
      AgentFeedbackService.setFeedback({ threadId: THREAD_ID, userId: USER_ID }, { rating: 'up' })
    ).rejects.toMatchObject({ code: 'feedback_not_enabled' });
    expect(mockSourceQuery).not.toHaveBeenCalled();
  });
});

describe('persistence and reload', () => {
  it('atomically upserts one owner/message value, preserving identity and creation time on conflict', async () => {
    const write = query(saved);
    mockFeedbackQuery.mockReturnValue(write);
    await expect(
      AgentFeedbackService.setFeedback(target, { rating: 'down', text: '  Wrong diagnosis  ' })
    ).resolves.toEqual({
      id: FEEDBACK_ID,
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      rating: 'down',
      text: 'Wrong diagnosis',
      reasons: [],
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    expect(write.insert).toHaveBeenCalledWith({
      threadId: 11,
      messageId: 12,
      userId: USER_ID,
      rating: 'down',
      text: 'Wrong diagnosis',
      reasons: [],
    });
    expect(write.onConflict).toHaveBeenCalledWith(['messageId', 'userId']);
    expect(write.merge).toHaveBeenCalledWith({
      rating: 'down',
      text: 'Wrong diagnosis',
      reasons: [],
      updatedAt: expect.any(String),
    });
    expect(write.returning).toHaveBeenCalledWith('*');
  });
  it('uses the partial unique constraint for conversation feedback and clears omitted text and reasons', async () => {
    const write = query({ ...saved, messageId: null, text: null });
    mockFeedbackQuery.mockReturnValue(write);
    await AgentFeedbackService.setFeedback({ threadId: THREAD_ID, userId: USER_ID }, { rating: 'up' });
    expect(write.onConflict).toHaveBeenCalledWith({
      sql: '("threadId", "userId") WHERE "messageId" IS NULL',
      bindings: undefined,
    });
    expect(write.merge).toHaveBeenCalledWith({ rating: 'up', text: null, reasons: [], updatedAt: expect.any(String) });
  });
  it('persists reason tags atomically with the rating and comment on inserts and replacements', async () => {
    const reasons = ['incorrect_or_incomplete', 'wrong_context', 'missing_evidence'];
    const write = query({ ...saved, reasons });
    mockFeedbackQuery.mockReturnValue(write);
    await expect(
      AgentFeedbackService.setFeedback(target, { rating: 'down', text: saved.text, reasons })
    ).resolves.toMatchObject({ rating: 'down', text: saved.text, reasons });
    expect(write.insert).toHaveBeenCalledWith({
      threadId: 11,
      messageId: 12,
      userId: USER_ID,
      rating: 'down',
      text: saved.text,
      reasons,
    });
    expect(write.merge).toHaveBeenCalledWith({
      rating: 'down',
      text: saved.text,
      reasons,
      updatedAt: expect.any(String),
    });
    await AgentFeedbackService.setFeedback(target, { rating: 'up', text: saved.text });
    expect(write.merge).toHaveBeenLastCalledWith({
      rating: 'up',
      text: saved.text,
      reasons: [],
      updatedAt: expect.any(String),
    });
  });
  it('rejects cross-rating tags before writing any part of the feedback', async () => {
    await expect(
      AgentFeedbackService.setFeedback(target, { rating: 'up', reasons: ['wrong_context'], text: 'Resolved' })
    ).rejects.toMatchObject({ httpStatus: 400, code: 'invalid_feedback' });
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });
  it('reloads saved feedback once and computes exact eligible canonical replies from origin runs', async () => {
    const feedback = query([saved]);
    mockFeedbackQuery.mockReturnValue(feedback);
    mockMessageQuery.mockReturnValue(
      query([
        message,
        { ...message, uuid: 'normal', runPlanSnapshot: normalPlan },
        { ...message, uuid: 'running', runStatus: 'running' },
      ])
    );
    mockRunQuery.mockReturnValue(query({ runPlanSnapshot: normalPlan }));
    const result = await AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID);
    expect(result.feedback).toHaveLength(1);
    expect(result.feedback[0].reasons).toEqual([]);
    expect(result.eligibleMessageIds).toEqual([MESSAGE_ID]);
    expect(result.canRateThread).toBe(false);
    expect(feedback.where).toHaveBeenCalledWith('feedback.userId', USER_ID);
    expect(feedback.where).toHaveBeenCalledWith('feedback.threadId', 11);
    expect(mockFeedbackQuery).toHaveBeenCalledTimes(1);
  });
  it('reloads structured reasons through owner and existing administrator conversation reads', async () => {
    const reasons = ['wrong_context', 'other'];
    mockFeedbackQuery.mockReturnValue(query([{ ...saved, reasons }]));
    mockMessageQuery.mockReturnValue(query([message]));
    const owned = await AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID);
    expect(owned.feedback[0]).toMatchObject({ id: FEEDBACK_ID, reasons, text: saved.text });
    const admin = await AgentFeedbackService.listThreadFeedback(11);
    expect(admin[0]).toMatchObject({ id: FEEDBACK_ID, reasons, text: saved.text });
  });
  it('offers finished normal replies in all scope but keeps active replies ineligible', async () => {
    mockConfig.mockResolvedValue({ feedbackScope: 'all' });
    mockFeedbackQuery.mockReturnValue(query([]));
    mockMessageQuery.mockReturnValue(
      query([
        { ...message, runPlanSnapshot: normalPlan },
        { ...message, uuid: 'active', runStatus: 'running' },
      ])
    );
    await expect(AgentFeedbackService.listOwnedThreadFeedback(THREAD_ID, USER_ID)).resolves.toMatchObject({
      canRateThread: true,
      eligibleMessageIds: [MESSAGE_ID],
    });
  });
  it.each([1, 0])(
    'allows retracting saved feedback after scope narrows and returns idempotent deletion result %s',
    async (count) => {
      mockMessageQuery.mockReturnValue(query({ ...message, runPlanSnapshot: normalPlan, runStatus: 'running' }));
      const deletion = query(count);
      mockFeedbackQuery.mockReturnValue(deletion);
      await expect(AgentFeedbackService.deleteFeedback(target)).resolves.toEqual({ deleted: count > 0 });
      expect(deletion.where).toHaveBeenCalledWith({ threadId: 11, messageId: 12, userId: USER_ID });
      expect(mockConfig).not.toHaveBeenCalled();
    }
  );
});

describe('administrator review', () => {
  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: Infinity },
    { limit: 101 },
    { limit: 0 },
    { rating: 'bad' },
    { scope: 'bad' },
  ])('rejects invalid review filters %p', async (filters) => {
    await expect(AgentFeedbackService.listAdminFeedback(filters as any)).rejects.toMatchObject({
      httpStatus: 400,
      code: 'invalid_feedback_filter',
    });
    expect(mockFeedbackQuery).not.toHaveBeenCalled();
  });
  it('paginates in SQL with a deterministic order and only applies parameterized filters', async () => {
    const review = query({
      results: [
        {
          ...saved,
          reasons: ['wrong_context'],
          sessionId: 'session-uuid',
          threadTitle: 'Investigation',
          ownerGithubUsername: 'alice',
          repo: 'org/repo',
          buildUuid: 'build-uuid',
        },
      ],
      total: 26,
    });
    mockFeedbackQuery.mockReturnValue(review);
    const result = await AgentFeedbackService.listAdminFeedback({
      page: 2,
      limit: 25,
      rating: 'down',
      scope: 'message',
      repo: "org/o'hare",
      user: 'alice',
    });
    expect(review.page).toHaveBeenCalledWith(1, 25);
    expect(review.where).toHaveBeenCalledWith('feedback.rating', 'down');
    expect(review.whereNotNull).toHaveBeenCalledWith('feedback.messageId');
    expect(review.whereRaw).toHaveBeenCalledWith(expect.stringContaining('ILIKE ?'), ["%org/o'hare%"]);
    expect(review.orderBy).toHaveBeenCalledWith('feedback.updatedAt', 'desc');
    expect(review.orderBy).toHaveBeenCalledWith('feedback.id', 'desc');
    expect(result.metadata.pagination).toEqual({ current: 2, total: 2, items: 26, limit: 25 });
    expect(result.data[0]).toMatchObject({
      id: FEEDBACK_ID,
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      sessionId: 'session-uuid',
      userId: USER_ID,
      reasons: ['wrong_context'],
    });
    expect(mockConfig).not.toHaveBeenCalled();
  });
  it('supports empty conversation-only review pages', async () => {
    const review = query({ results: [], total: 0 });
    mockFeedbackQuery.mockReturnValue(review);
    await expect(AgentFeedbackService.listAdminFeedback({ scope: 'thread' })).resolves.toEqual({
      data: [],
      metadata: { pagination: { current: 1, total: 1, items: 0, limit: 25 } },
    });
    expect(review.whereNull).toHaveBeenCalledWith('feedback.messageId');
  });
});
