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

export default class Conversation extends Model {
  buildUuid!: string;
  repo!: string;
  model?: string | null;
  messageCount!: number;
  metadata!: Record<string, unknown>;

  static tableName = 'conversations';
  static timestamps = true;
  static idColumn = 'buildUuid';

  static get jsonAttributes() {
    return ['metadata'];
  }

  static get relationMappings() {
    const ConversationMessage = require('./ConversationMessage').default;
    return {
      messages: {
        relation: Model.HasManyRelation,
        modelClass: ConversationMessage,
        join: {
          from: 'conversations.buildUuid',
          to: 'conversation_messages.buildUuid',
        },
      },
    };
  }
}
