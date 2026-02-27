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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import MessageFeedback from 'server/models/MessageFeedback';
import ConversationFeedback from 'server/models/ConversationFeedback';
import Conversation from 'server/models/Conversation';

const getHandler = async (req: NextRequest, { params }: { params: { id: string } }) => {
  const { id } = params;

  if (!id) {
    return errorResponse(new Error('Missing required parameter: id'), { status: 400 }, req);
  }

  const dashIndex = id.indexOf('-');
  if (dashIndex === -1) {
    return errorResponse(new Error('Invalid feedback id format'), { status: 400 }, req);
  }

  const feedbackType = id.slice(0, dashIndex) as 'message' | 'conversation';
  const recordId = parseInt(id.slice(dashIndex + 1), 10);

  if (feedbackType !== 'message' && feedbackType !== 'conversation') {
    return errorResponse(new Error('Invalid feedback type: must be "message" or "conversation"'), { status: 400 }, req);
  }

  if (isNaN(recordId)) {
    return errorResponse(new Error('Invalid feedback record id'), { status: 400 }, req);
  }

  let buildUuid: string;
  let ratedMessageId: number | null = null;
  let repo: string;
  let feedbackRating: 'up' | 'down';
  let feedbackText: string | null = null;
  let feedbackUserIdentifier: string | null = null;
  let feedbackCreatedAt: string | Date;

  if (feedbackType === 'message') {
    const record = await MessageFeedback.query().findById(recordId);
    if (!record) {
      return errorResponse(new Error('Feedback record not found'), { status: 404 }, req);
    }
    buildUuid = record.buildUuid;
    ratedMessageId = record.messageId;
    repo = record.repo;
    feedbackRating = record.rating;
    feedbackText = record.text ?? null;
    feedbackUserIdentifier = record.userIdentifier ?? null;
    feedbackCreatedAt = record.createdAt;
  } else {
    const record = await ConversationFeedback.query().findById(recordId);
    if (!record) {
      return errorResponse(new Error('Feedback record not found'), { status: 404 }, req);
    }
    buildUuid = record.buildUuid;
    repo = record.repo;
    feedbackRating = record.rating;
    feedbackText = record.text ?? null;
    feedbackUserIdentifier = record.userIdentifier ?? null;
    feedbackCreatedAt = record.createdAt;
  }

  const conversation = await Conversation.query()
    .findById(buildUuid)
    .withGraphFetched('messages(orderByTimestamp)')
    .modifiers({
      orderByTimestamp(builder: any) {
        builder.orderBy('timestamp', 'asc');
      },
    });

  if (!conversation) {
    return errorResponse(new Error('Conversation not found'), { status: 404 }, req);
  }

  const messages = ((conversation as any).messages || []).map((msg: any) => {
    // PostgreSQL BIGINT values can come back as strings; normalize for UI consumers.
    const numericTimestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Number(msg.timestamp);

    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: Number.isNaN(numericTimestamp) ? Date.parse(String(msg.timestamp)) : numericTimestamp,
      metadata: msg.metadata || {},
    };
  });

  return successResponse(
    {
      feedbackType,
      feedbackId: recordId,
      buildUuid,
      repo,
      ratedMessageId,
      feedbackRating,
      feedbackText,
      feedbackUserIdentifier,
      feedbackCreatedAt,
      conversation: {
        messageCount: conversation.messageCount,
        model: conversation.model || null,
        messages,
      },
    },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler);
