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

import BaseService from '../../_service';
import { ConversationState, DebugMessage } from '../../types/aiAgent';

export default class AIAgentConversationService extends BaseService {
  private readonly CONVERSATION_TTL = 3600;
  private readonly KEY_PREFIX = 'lifecycle:agent:conversation:';

  private getConversationKey(buildUuid: string): string {
    return `${this.KEY_PREFIX}${buildUuid}`;
  }

  async getConversation(buildUuid: string): Promise<ConversationState | null> {
    const key = this.getConversationKey(buildUuid);
    const data = await this.redis.get(key);

    if (!data) {
      return null;
    }

    return JSON.parse(data);
  }

  async addMessage(buildUuid: string, message: DebugMessage): Promise<ConversationState> {
    const key = this.getConversationKey(buildUuid);
    const conversation = (await this.getConversation(buildUuid)) || {
      buildUuid,
      messages: [],
      lastActivity: Date.now(),
    };

    conversation.messages.push(message);
    conversation.lastActivity = Date.now();

    await this.redis.setex(key, this.CONVERSATION_TTL, JSON.stringify(conversation));

    return conversation;
  }

  async clearConversation(buildUuid: string): Promise<number> {
    const key = this.getConversationKey(buildUuid);
    const conversation = await this.getConversation(buildUuid);
    await this.redis.del(key);
    return conversation?.messages.length || 0;
  }

  async refreshTTL(buildUuid: string): Promise<void> {
    const key = this.getConversationKey(buildUuid);
    await this.redis.expire(key, this.CONVERSATION_TTL);
  }
}
