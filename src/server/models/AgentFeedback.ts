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

import Model from './_Model';
import {
  MAX_AGENT_FEEDBACK_TEXT_LENGTH,
  AGENT_FEEDBACK_REASONS_BY_RATING,
  AGENT_FEEDBACK_REASON_IDS,
  MAX_AGENT_FEEDBACK_REASONS,
  type AgentFeedbackRating,
  type AgentFeedbackReason,
} from 'shared/types/agentFeedback';

export default class AgentFeedback extends Model {
  uuid!: string;
  threadId!: number;
  messageId!: number | null;
  userId!: string;
  rating!: AgentFeedbackRating;
  text!: string | null;
  reasons!: AgentFeedbackReason[];

  static tableName = 'agent_feedback';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['threadId', 'userId', 'rating'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      threadId: { type: 'integer' },
      messageId: { type: ['integer', 'null'] },
      userId: { type: 'string', minLength: 1, maxLength: 255 },
      rating: { type: 'string', enum: ['up', 'down'] },
      text: { type: ['string', 'null'], maxLength: MAX_AGENT_FEEDBACK_TEXT_LENGTH },
      reasons: {
        type: 'array',
        items: { type: 'string', enum: AGENT_FEEDBACK_REASON_IDS },
        maxItems: MAX_AGENT_FEEDBACK_REASONS,
        uniqueItems: true,
        default: [],
      },
    },
    allOf: Object.entries(AGENT_FEEDBACK_REASONS_BY_RATING).map(([rating, reasons]) => ({
      if: { properties: { rating: { const: rating } }, required: ['rating'] },
      then: { properties: { reasons: { type: 'array', items: { enum: [...reasons] } } } },
    })),
  };

  static get jsonAttributes() {
    return ['reasons'];
  }
}
