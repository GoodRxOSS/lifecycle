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

export const MAX_AGENT_FEEDBACK_TEXT_LENGTH = 10_000;

export const AGENT_FEEDBACK_SCOPES = ['none', 'debug', 'chat', 'all'] as const;
export type AgentFeedbackScope = (typeof AGENT_FEEDBACK_SCOPES)[number];

export type AgentFeedbackRating = 'up' | 'down';

export const AGENT_FEEDBACK_REASONS_BY_RATING = {
  up: ['solved_task', 'clear_explanation', 'evidence_backed', 'actionable_steps', 'other'],
  down: [
    'incorrect_or_incomplete',
    'did_not_follow_instructions',
    'missing_evidence',
    'unhelpful_steps',
    'wrong_context',
    'too_slow',
    'other',
  ],
} as const;

export type AgentFeedbackReason = (typeof AGENT_FEEDBACK_REASONS_BY_RATING)[AgentFeedbackRating][number];

export const AGENT_FEEDBACK_REASON_IDS = [...new Set(Object.values(AGENT_FEEDBACK_REASONS_BY_RATING).flat())];
export const MAX_AGENT_FEEDBACK_REASONS = 7;

export type AgentFeedbackInput = {
  rating: AgentFeedbackRating;
  text: string | null;
  reasons: AgentFeedbackReason[];
};

export type SerializedAgentFeedback = AgentFeedbackInput & {
  id: string;
  threadId: string;
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentThreadFeedback = {
  feedback: SerializedAgentFeedback[];
  canRateThread: boolean;
  eligibleMessageIds: string[];
};

export type AgentAdminFeedback = SerializedAgentFeedback & {
  sessionId: string;
  threadTitle: string | null;
  userId: string;
  ownerGithubUsername: string | null;
  repo: string | null;
  buildUuid: string | null;
};
