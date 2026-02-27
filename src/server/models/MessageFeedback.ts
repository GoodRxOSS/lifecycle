/**
 * Copyright 2025 GoodRx, Inc.
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

export default class MessageFeedback extends Model {
  buildUuid!: string;
  messageId!: number;
  rating!: 'up' | 'down';
  text?: string | null;
  userIdentifier?: string | null;
  repo!: string;
  prNumber?: number | null;

  static tableName = 'message_feedback';
  static timestamps = true;

  static get relationMappings() {
    const Conversation = require('./Conversation').default;
    const ConversationMessage = require('./ConversationMessage').default;
    return {
      conversation: {
        relation: Model.BelongsToOneRelation,
        modelClass: Conversation,
        join: {
          from: 'message_feedback.buildUuid',
          to: 'conversations.buildUuid',
        },
      },
      message: {
        relation: Model.BelongsToOneRelation,
        modelClass: ConversationMessage,
        join: {
          from: 'message_feedback.messageId',
          to: 'conversation_messages.id',
        },
      },
    };
  }
}
