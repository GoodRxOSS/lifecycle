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

import { getLogger } from 'server/lib/logger';
import AIAgentConversationService from './storage';
import { ConversationState, DebugMessage } from '../../types/aiAgent';
import Conversation from 'server/models/Conversation';
import ConversationMessage from 'server/models/ConversationMessage';

const TOOL_RESULT_TRUNCATION_LIMIT = 10000;
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 200;

export default class ConversationPersistenceService {
  private conversationService: AIAgentConversationService;

  constructor(conversationService: AIAgentConversationService) {
    this.conversationService = conversationService;
  }

  async persistConversation(buildUuid: string, repo: string, model?: string): Promise<boolean> {
    const logger = getLogger();
    try {
      const conversation = await this.conversationService.getConversation(buildUuid);
      if (!conversation || conversation.messages.length === 0) {
        return false;
      }

      await this.withRetry(() => this.writeToPostgres(buildUuid, repo, model, conversation));
      logger.info(`AI: conversation persisted buildUuid=${buildUuid} messageCount=${conversation.messages.length}`);
      return true;
    } catch (err) {
      logger.error(`AI: conversation persistence failed buildUuid=${buildUuid} error=${err.message}`);
      return false;
    }
  }

  private async writeToPostgres(
    buildUuid: string,
    repo: string,
    model: string | undefined,
    conversation: ConversationState
  ): Promise<void> {
    await Conversation.transact(async (trx) => {
      const existingConversation = await Conversation.query(trx).findById(buildUuid);
      const existingMessages = existingConversation
        ? await ConversationMessage.query(trx).where({ buildUuid }).select('role', 'timestamp')
        : [];
      const existingKeys = new Set(existingMessages.map((msg) => `${msg.role}:${msg.timestamp}`));

      const messageRows = conversation.messages.map((msg) => ({
        buildUuid,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: this.extractMessageMetadata(msg),
      }));

      const newMessageRows = messageRows.filter((msg) => !existingKeys.has(`${msg.role}:${msg.timestamp}`));
      const mergedRepo = existingConversation?.repo || repo;
      const mergedModel = model || existingConversation?.model || null;
      const mergedMessageCount = existingMessages.length + newMessageRows.length;
      const metadata = {
        contextSnapshot: conversation.contextSnapshot || null,
        lastActivity: conversation.lastActivity,
      };

      if (!existingConversation) {
        await Conversation.query(trx).insert({
          buildUuid,
          repo: mergedRepo,
          model: mergedModel,
          messageCount: mergedMessageCount,
          metadata,
        } as any);
      }

      if (newMessageRows.length > 0) {
        await ConversationMessage.query(trx).insert(newMessageRows as any);
      }

      if (existingConversation) {
        await Conversation.query(trx)
          .patch({
            repo: mergedRepo,
            model: mergedModel,
            messageCount: mergedMessageCount,
            metadata,
          } as any)
          .where({ buildUuid });
      }
    });
  }

  private extractMessageMetadata(msg: DebugMessage): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};

    if (msg.isSystemAction) {
      metadata.isSystemAction = msg.isSystemAction;
    }
    if (msg.activityHistory) {
      metadata.activityHistory = msg.activityHistory;
    }
    if (msg.evidenceItems) {
      metadata.evidenceItems = msg.evidenceItems;
    }
    if (msg.totalInvestigationTimeMs) {
      metadata.totalInvestigationTimeMs = msg.totalInvestigationTimeMs;
    }
    if (msg.debugContext) {
      metadata.debugContext = msg.debugContext;
    }
    if (msg.debugToolData) {
      metadata.debugToolData = this.truncateToolResults(msg.debugToolData);
    }
    if (msg.debugMetrics) {
      metadata.debugMetrics = msg.debugMetrics;
    }

    return metadata;
  }

  private truncateToolResults(toolData: DebugMessage['debugToolData']): DebugMessage['debugToolData'] {
    if (!toolData) {
      return undefined;
    }

    return toolData.map((entry) => {
      if (!entry.toolResult) {
        return entry;
      }

      if (typeof entry.toolResult === 'string') {
        if (entry.toolResult.length > TOOL_RESULT_TRUNCATION_LIMIT) {
          return {
            ...entry,
            toolResult: entry.toolResult.substring(0, TOOL_RESULT_TRUNCATION_LIMIT) + '... [truncated]',
          };
        }
        return entry;
      }

      if (typeof entry.toolResult === 'object') {
        const stringified = JSON.stringify(entry.toolResult);
        if (stringified.length > TOOL_RESULT_TRUNCATION_LIMIT) {
          return {
            ...entry,
            toolResult: {
              truncated: true,
              originalLength: stringified.length,
              preview: stringified.substring(0, 500),
            },
          };
        }
      }

      return entry;
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const logger = getLogger();
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt < MAX_RETRY_ATTEMPTS) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          logger.warn(`AI: conversation persistence retry attempt=${attempt} error=${err.message}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }
    throw new Error('withRetry: unreachable');
  }
}
