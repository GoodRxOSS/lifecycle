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

import AgentFeedback from '../AgentFeedback';
import {
  AGENT_FEEDBACK_REASONS_BY_RATING,
  MAX_AGENT_FEEDBACK_TEXT_LENGTH,
  type AgentFeedbackReason,
} from 'shared/types/agentFeedback';

const validFeedback = {
  uuid: '00000000-0000-4000-8000-000000000003',
  threadId: 11,
  messageId: null,
  userId: 'owner-id',
  rating: 'up' as const,
  text: null,
};

describe('AgentFeedback model validation', () => {
  it('accepts a canonical feedback record through the actual Objection validator', () => {
    const model = AgentFeedback.fromJson(validFeedback);
    expect(model).toMatchObject(validFeedback);
    expect(model.reasons).toEqual([]);
  });

  it('accepts database-generated UUIDs by allowing inserts without an explicit UUID', () => {
    const { uuid: _uuid, ...insert } = validFeedback;
    expect(AgentFeedback.fromJson(insert)).toMatchObject(insert);
  });

  it.each(['not-a-uuid', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', '00000000000040008000000000000003'])(
    'rejects invalid UUID %s',
    (uuid) => {
      expect(() => AgentFeedback.fromJson({ ...validFeedback, uuid })).toThrow();
    }
  );

  it('keeps rating, owner, and Unicode text constraints enforced by the model', () => {
    expect(() => AgentFeedback.fromJson({ ...validFeedback, rating: 'neutral' as 'up' })).toThrow();
    expect(() => AgentFeedback.fromJson({ ...validFeedback, userId: '' })).toThrow();
    expect(
      AgentFeedback.fromJson({ ...validFeedback, text: '👍'.repeat(MAX_AGENT_FEEDBACK_TEXT_LENGTH) }).text
    ).toHaveLength(MAX_AGENT_FEEDBACK_TEXT_LENGTH * 2);
    expect(() =>
      AgentFeedback.fromJson({ ...validFeedback, text: '👍'.repeat(MAX_AGENT_FEEDBACK_TEXT_LENGTH + 1) })
    ).toThrow();
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
    ['up', ['clear_explanation', 'evidence_backed', 'actionable_steps']],
    ['down', ['missing_evidence', 'unhelpful_steps', 'wrong_context', 'too_slow']],
  ] as const)('validates and serializes supported %s reasons %p as JSONB', (rating, reasons) => {
    const model = AgentFeedback.fromJson({ ...validFeedback, rating, reasons: [...reasons] });
    expect(model.reasons).toEqual(reasons);
    expect(model.$toDatabaseJson().reasons).toBe(JSON.stringify(reasons));
    expect(
      AgentFeedback.fromDatabaseJson({ ...validFeedback, rating, reasons: JSON.stringify(reasons) }).reasons
    ).toEqual(reasons);
    expect(AgentFeedback.fromJson({ rating, reasons: [...reasons] }, { patch: true }).$toDatabaseJson().reasons).toBe(
      JSON.stringify(reasons)
    );
  });

  it.each(['up', 'down'] as const)('keeps the model limit at seven %s reasons across the accepted union', (rating) => {
    const reasons = AGENT_FEEDBACK_REASONS_BY_RATING[rating].slice(0, 7);
    expect(AgentFeedback.fromJson({ ...validFeedback, rating, reasons }).reasons).toEqual(reasons);
    expect(() =>
      AgentFeedback.fromJson({
        ...validFeedback,
        rating,
        reasons: Array(8).fill('other'),
      })
    ).toThrow();
  });

  it.each([
    ['up', ['wrong_context']],
    ['down', ['solved_task']],
    ['up', ['missing_evidence']],
    ['down', ['evidence_backed']],
    ['up', ['unknown']],
    ['down', ['other', 'other']],
    ['down', Array(8).fill('other')],
  ] as const)('rejects invalid %s reason tags %p through the actual model validator', (rating, reasons) => {
    const value = { rating, reasons: [...reasons] as AgentFeedbackReason[] };
    expect(() => AgentFeedback.fromJson({ ...validFeedback, ...value })).toThrow();
    expect(() => AgentFeedback.fromJson(value, { patch: true })).toThrow();
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
  ] as const)('rejects removed %s reason %s for inserts and replacements', (rating, reason) => {
    const value = { rating, reasons: [reason] as unknown as AgentFeedbackReason[] };
    expect(() => AgentFeedback.fromJson({ ...validFeedback, ...value })).toThrow();
    expect(() => AgentFeedback.fromJson(value, { patch: true })).toThrow();
  });
});
