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
import ConversationPersistenceService from '../conversation/persistence';
import Conversation from 'server/models/Conversation';
import ConversationMessage from 'server/models/ConversationMessage';
import MessageFeedback from 'server/models/MessageFeedback';
import ConversationFeedback from 'server/models/ConversationFeedback';

interface MessageFeedbackParams {
  buildUuid: string;
  messageId?: number;
  messageTimestamp?: number;
  rating: 'up' | 'down';
  text?: string;
  userIdentifier?: string;
  repo: string;
  prNumber?: number;
}

interface ConversationFeedbackParams {
  buildUuid: string;
  rating: 'up' | 'down';
  text?: string;
  userIdentifier?: string;
  repo: string;
  prNumber?: number;
}

export default class FeedbackService {
  private static readonly TIMESTAMP_FALLBACK_BACKWARD_WINDOW_MS = 60_000;
  private static readonly TIMESTAMP_FALLBACK_FORWARD_WINDOW_MS = 10 * 60_000;

  private persistenceService: ConversationPersistenceService;

  constructor(persistenceService: ConversationPersistenceService) {
    this.persistenceService = persistenceService;
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const code = (error as { code?: unknown }).code;
    return code === '23505';
  }

  private async resolveAssistantMessageByTimestamp(
    buildUuid: string,
    messageTimestamp: number
  ): Promise<ConversationMessage | undefined> {
    // Prefer exact timestamp matches when available.
    const exactMatch = await ConversationMessage.query()
      .where({ buildUuid, role: 'assistant', timestamp: messageTimestamp })
      .orderBy('id', 'desc')
      .first();

    if (exactMatch) {
      return exactMatch;
    }

    // Use a bounded window around the client timestamp to reduce mismatches
    // for long-running or stale sessions.
    const nearbyCandidates = await ConversationMessage.query()
      .where({ buildUuid, role: 'assistant' })
      .andWhere('timestamp', '>=', messageTimestamp - FeedbackService.TIMESTAMP_FALLBACK_BACKWARD_WINDOW_MS)
      .andWhere('timestamp', '<=', messageTimestamp + FeedbackService.TIMESTAMP_FALLBACK_FORWARD_WINDOW_MS)
      .orderBy('timestamp', 'asc')
      .orderBy('id', 'desc');

    if (nearbyCandidates.length === 1) {
      return nearbyCandidates[0];
    }

    if (nearbyCandidates.length > 1) {
      const ranked = nearbyCandidates
        .map((candidate) => ({
          candidate,
          delta: Math.abs(Number(candidate.timestamp) - messageTimestamp),
        }))
        .sort((a, b) => {
          if (a.delta !== b.delta) return a.delta - b.delta;
          if (Number(a.candidate.timestamp) !== Number(b.candidate.timestamp)) {
            return Number(a.candidate.timestamp) - Number(b.candidate.timestamp);
          }
          return b.candidate.id - a.candidate.id;
        });

      // Do not guess when two candidates are equally close.
      if (ranked[1] && ranked[0].delta === ranked[1].delta) {
        return undefined;
      }

      return ranked[0].candidate;
    }

    // Conservative fallback: if the conversation has exactly one assistant
    // message total, use it.
    const assistantMessages = await ConversationMessage.query()
      .where({ buildUuid, role: 'assistant' })
      .orderBy('timestamp', 'desc')
      .limit(2);

    if (assistantMessages.length === 1) {
      return assistantMessages[0];
    }

    return undefined;
  }

  async submitMessageFeedback(params: MessageFeedbackParams): Promise<MessageFeedback> {
    const { buildUuid, messageId, messageTimestamp, rating, text, userIdentifier, repo, prNumber } = params;
    const logger = getLogger();

    try {
      await this.persistenceService.persistConversation(buildUuid, repo);
    } catch (err) {
      logger.warn(`AI: feedback persistence trigger failed buildUuid=${buildUuid} error=${err.message}`);
    }

    let message = messageId ? await ConversationMessage.query().findOne({ id: messageId, buildUuid }) : undefined;

    if (!message && messageTimestamp != null) {
      message = await this.resolveAssistantMessageByTimestamp(buildUuid, messageTimestamp);
      if (message && Number(message.timestamp) !== messageTimestamp) {
        logger.info(
          `AI: feedback timestamp fallback matched buildUuid=${buildUuid} requestedTimestamp=${messageTimestamp} resolvedTimestamp=${message.timestamp} resolvedMessageId=${message.id}`
        );
      }
    }

    if (!message) {
      throw new Error(
        `Message not found: messageId=${messageId || 'n/a'} messageTimestamp=${
          messageTimestamp || 'n/a'
        } buildUuid=${buildUuid}`
      );
    }

    const patch: Record<string, unknown> = {
      rating,
      repo,
      prNumber: prNumber || null,
    };
    if (text !== undefined) {
      patch.text = text || null;
    }
    if (userIdentifier !== undefined) {
      patch.userIdentifier = userIdentifier || null;
    }

    const existingRecord = await MessageFeedback.query()
      .where({ buildUuid, messageId: message.id })
      .orderBy('id', 'desc')
      .first();

    if (existingRecord) {
      const record = await MessageFeedback.query().patchAndFetchById(existingRecord.id, patch as any);
      logger.info(`AI: feedback updated type=message buildUuid=${buildUuid} messageId=${message.id} rating=${rating}`);
      return record;
    }

    try {
      const record = await MessageFeedback.query().insertAndFetch({
        buildUuid,
        messageId: message.id,
        rating,
        text: text || null,
        userIdentifier: userIdentifier || null,
        repo,
        prNumber: prNumber || null,
      } as any);

      logger.info(
        `AI: feedback submitted type=message buildUuid=${buildUuid} messageId=${message.id} rating=${rating}`
      );
      return record;
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const conflictRecord = await MessageFeedback.query()
        .where({ buildUuid, messageId: message.id })
        .orderBy('id', 'desc')
        .first();

      if (!conflictRecord) {
        throw error;
      }

      const record = await MessageFeedback.query().patchAndFetchById(conflictRecord.id, patch as any);
      logger.info(`AI: feedback updated type=message buildUuid=${buildUuid} messageId=${message.id} rating=${rating}`);
      return record;
    }
  }

  async submitConversationFeedback(params: ConversationFeedbackParams): Promise<ConversationFeedback> {
    const { buildUuid, rating, text, userIdentifier, repo, prNumber } = params;
    const logger = getLogger();

    try {
      await this.persistenceService.persistConversation(buildUuid, repo);
    } catch (err) {
      logger.warn(`AI: feedback persistence trigger failed buildUuid=${buildUuid} error=${err.message}`);
    }

    const conversation = await Conversation.query().findById(buildUuid);
    if (!conversation) {
      throw new Error(`Conversation not found: buildUuid=${buildUuid}`);
    }

    const patch: Record<string, unknown> = {
      rating,
      repo,
      prNumber: prNumber || null,
    };
    if (text !== undefined) {
      patch.text = text || null;
    }
    if (userIdentifier !== undefined) {
      patch.userIdentifier = userIdentifier || null;
    }

    const existingRecord = await ConversationFeedback.query().where({ buildUuid }).orderBy('id', 'desc').first();

    if (existingRecord) {
      const record = await ConversationFeedback.query().patchAndFetchById(existingRecord.id, patch as any);
      logger.info(`AI: feedback updated type=conversation buildUuid=${buildUuid} rating=${rating}`);
      return record;
    }

    try {
      const record = await ConversationFeedback.query().insertAndFetch({
        buildUuid,
        rating,
        text: text || null,
        userIdentifier: userIdentifier || null,
        repo,
        prNumber: prNumber || null,
      } as any);

      logger.info(`AI: feedback submitted type=conversation buildUuid=${buildUuid} rating=${rating}`);
      return record;
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const conflictRecord = await ConversationFeedback.query().where({ buildUuid }).orderBy('id', 'desc').first();

      if (!conflictRecord) {
        throw error;
      }

      const record = await ConversationFeedback.query().patchAndFetchById(conflictRecord.id, patch as any);
      logger.info(`AI: feedback updated type=conversation buildUuid=${buildUuid} rating=${rating}`);
      return record;
    }
  }
}
