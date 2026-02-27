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

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('server/lib/logger', () => ({
  getLogger: () => mockLogger,
}));

jest.mock('server/models/Conversation', () => {
  const model: any = {};
  model.query = jest.fn();
  return { __esModule: true, default: model };
});

jest.mock('server/models/ConversationMessage', () => {
  const model: any = {};
  model.query = jest.fn();
  return { __esModule: true, default: model };
});

jest.mock('server/models/MessageFeedback', () => {
  const model: any = {};
  model.query = jest.fn();
  return { __esModule: true, default: model };
});

jest.mock('server/models/ConversationFeedback', () => {
  const model: any = {};
  model.query = jest.fn();
  return { __esModule: true, default: model };
});

import FeedbackService from '../FeedbackService';
import Conversation from 'server/models/Conversation';
import ConversationFeedback from 'server/models/ConversationFeedback';
import ConversationMessage from 'server/models/ConversationMessage';
import MessageFeedback from 'server/models/MessageFeedback';

const MockConversation = Conversation as any;
const MockConversationFeedback = ConversationFeedback as any;
const MockConversationMessage = ConversationMessage as any;
const MockMessageFeedback = MessageFeedback as any;

describe('FeedbackService', () => {
  const persistenceService = { persistConversation: jest.fn() };
  let service: FeedbackService;

  beforeEach(() => {
    jest.clearAllMocks();
    persistenceService.persistConversation.mockResolvedValue(true);
    service = new FeedbackService(persistenceService as any);
  });

  it('submits message feedback using direct persisted messageId', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: 11, buildUuid: 'uuid-1' });
    MockConversationMessage.query.mockReturnValue({ findOne });

    const existingFirst = jest.fn().mockResolvedValue(undefined);
    const existingOrderBy = jest.fn().mockReturnValue({ first: existingFirst });
    const existingWhere = jest.fn().mockReturnValue({ orderBy: existingOrderBy });
    const insertAndFetch = jest.fn().mockResolvedValue({ id: 1, messageId: 11 });
    MockMessageFeedback.query.mockReturnValueOnce({ where: existingWhere }).mockReturnValueOnce({ insertAndFetch });

    await service.submitMessageFeedback({
      buildUuid: 'uuid-1',
      messageId: 11,
      rating: 'up',
      repo: 'org/repo',
    });

    expect(findOne).toHaveBeenCalledWith({ id: 11, buildUuid: 'uuid-1' });
    expect(existingWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-1', messageId: 11 });
    expect(insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 11, buildUuid: 'uuid-1', rating: 'up' })
    );
  });

  it('submits message feedback by resolving assistant message from timestamp', async () => {
    const first = jest.fn().mockResolvedValue({ id: 27, buildUuid: 'uuid-2', timestamp: 1234 });
    const orderBy = jest.fn().mockReturnValue({ first });
    const where = jest.fn().mockReturnValue({ orderBy });
    MockConversationMessage.query.mockReturnValue({ where });

    const existingFirst = jest.fn().mockResolvedValue(undefined);
    const existingOrderBy = jest.fn().mockReturnValue({ first: existingFirst });
    const existingWhere = jest.fn().mockReturnValue({ orderBy: existingOrderBy });
    const insertAndFetch = jest.fn().mockResolvedValue({ id: 2, messageId: 27 });
    MockMessageFeedback.query.mockReturnValueOnce({ where: existingWhere }).mockReturnValueOnce({ insertAndFetch });

    await service.submitMessageFeedback({
      buildUuid: 'uuid-2',
      messageTimestamp: 1234,
      rating: 'down',
      repo: 'org/repo',
      text: 'not helpful',
    });

    expect(where).toHaveBeenCalledWith({ buildUuid: 'uuid-2', role: 'assistant', timestamp: 1234 });
    expect(existingWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-2', messageId: 27 });
    expect(insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 27, rating: 'down', text: 'not helpful' })
    );
  });

  it('submits message feedback by falling back to nearest assistant message when exact timestamp misses', async () => {
    const exactFirst = jest.fn().mockResolvedValue(undefined);
    const exactOrderBy = jest.fn().mockReturnValue({ first: exactFirst });
    const exactWhere = jest.fn().mockReturnValue({ orderBy: exactOrderBy });

    const nearbySecondOrderBy = jest.fn().mockResolvedValue([
      { id: 35, buildUuid: 'uuid-2', timestamp: 1300 },
      { id: 36, buildUuid: 'uuid-2', timestamp: 1500 },
    ]);
    const nearbyFirstOrderBy = jest.fn().mockReturnValue({ orderBy: nearbySecondOrderBy });
    const nearbyUpperBoundWhere = jest.fn().mockReturnValue({ orderBy: nearbyFirstOrderBy });
    const nearbyLowerBoundWhere = jest.fn().mockReturnValue({ andWhere: nearbyUpperBoundWhere });
    const nearbyWhere = jest.fn().mockReturnValue({ andWhere: nearbyLowerBoundWhere });

    MockConversationMessage.query
      .mockReturnValueOnce({ where: exactWhere })
      .mockReturnValueOnce({ where: nearbyWhere });

    const existingFirst = jest.fn().mockResolvedValue(undefined);
    const existingOrderBy = jest.fn().mockReturnValue({ first: existingFirst });
    const existingWhere = jest.fn().mockReturnValue({ orderBy: existingOrderBy });
    const insertAndFetch = jest.fn().mockResolvedValue({ id: 3, messageId: 35 });
    MockMessageFeedback.query.mockReturnValueOnce({ where: existingWhere }).mockReturnValueOnce({ insertAndFetch });

    await service.submitMessageFeedback({
      buildUuid: 'uuid-2',
      messageTimestamp: 1234,
      rating: 'down',
      repo: 'org/repo',
    });

    expect(exactWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-2', role: 'assistant', timestamp: 1234 });
    expect(nearbyWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-2', role: 'assistant' });
    expect(nearbyLowerBoundWhere).toHaveBeenCalledWith('timestamp', '>=', 1234 - 60_000);
    expect(nearbyUpperBoundWhere).toHaveBeenCalledWith('timestamp', '<=', 1234 + 600_000);
    expect(existingWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-2', messageId: 35 });
    expect(insertAndFetch).toHaveBeenCalledWith(expect.objectContaining({ messageId: 35, rating: 'down' }));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('AI: feedback timestamp fallback matched'));
  });

  it('falls back to the only assistant message when bounded timestamp lookup misses', async () => {
    const exactFirst = jest.fn().mockResolvedValue(undefined);
    const exactOrderBy = jest.fn().mockReturnValue({ first: exactFirst });
    const exactWhere = jest.fn().mockReturnValue({ orderBy: exactOrderBy });

    const nearbySecondOrderBy = jest.fn().mockResolvedValue([]);
    const nearbyFirstOrderBy = jest.fn().mockReturnValue({ orderBy: nearbySecondOrderBy });
    const nearbyUpperBoundWhere = jest.fn().mockReturnValue({ orderBy: nearbyFirstOrderBy });
    const nearbyLowerBoundWhere = jest.fn().mockReturnValue({ andWhere: nearbyUpperBoundWhere });
    const nearbyWhere = jest.fn().mockReturnValue({ andWhere: nearbyLowerBoundWhere });

    const fallbackLimit = jest.fn().mockResolvedValue([{ id: 77, buildUuid: 'uuid-2', timestamp: 9000 }]);
    const fallbackOrderBy = jest.fn().mockReturnValue({ limit: fallbackLimit });
    const fallbackWhere = jest.fn().mockReturnValue({ orderBy: fallbackOrderBy });

    MockConversationMessage.query
      .mockReturnValueOnce({ where: exactWhere })
      .mockReturnValueOnce({ where: nearbyWhere })
      .mockReturnValueOnce({ where: fallbackWhere });

    const existingFirst = jest.fn().mockResolvedValue(undefined);
    const existingOrderBy = jest.fn().mockReturnValue({ first: existingFirst });
    const existingWhere = jest.fn().mockReturnValue({ orderBy: existingOrderBy });
    const insertAndFetch = jest.fn().mockResolvedValue({ id: 4, messageId: 77 });
    MockMessageFeedback.query.mockReturnValueOnce({ where: existingWhere }).mockReturnValueOnce({ insertAndFetch });

    await service.submitMessageFeedback({
      buildUuid: 'uuid-2',
      messageTimestamp: 1234,
      rating: 'up',
      repo: 'org/repo',
    });

    expect(fallbackWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-2', role: 'assistant' });
    expect(fallbackLimit).toHaveBeenCalledWith(2);
    expect(existingWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-2', messageId: 77 });
  });

  it('overwrites existing feedback for the same message instead of inserting a new row', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: 44, buildUuid: 'uuid-4' });
    MockConversationMessage.query.mockReturnValue({ findOne });

    const existingFirst = jest.fn().mockResolvedValue({ id: 9, buildUuid: 'uuid-4', messageId: 44, rating: 'up' });
    const existingOrderBy = jest.fn().mockReturnValue({ first: existingFirst });
    const existingWhere = jest.fn().mockReturnValue({ orderBy: existingOrderBy });
    const patchAndFetchById = jest
      .fn()
      .mockResolvedValue({ id: 9, buildUuid: 'uuid-4', messageId: 44, rating: 'down' });

    MockMessageFeedback.query.mockReturnValueOnce({ where: existingWhere }).mockReturnValueOnce({ patchAndFetchById });

    await service.submitMessageFeedback({
      buildUuid: 'uuid-4',
      messageId: 44,
      rating: 'down',
      repo: 'org/repo',
    });

    expect(existingWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-4', messageId: 44 });
    expect(patchAndFetchById).toHaveBeenCalledWith(9, expect.objectContaining({ rating: 'down', repo: 'org/repo' }));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('AI: feedback updated type=message'));
  });

  it('throws when no message can be resolved', async () => {
    const findOne = jest.fn().mockResolvedValue(undefined);
    const exactFirst = jest.fn().mockResolvedValue(undefined);
    const exactOrderBy = jest.fn().mockReturnValue({ first: exactFirst });
    const exactWhere = jest.fn().mockReturnValue({ orderBy: exactOrderBy });

    const nearbySecondOrderBy = jest.fn().mockResolvedValue([]);
    const nearbyFirstOrderBy = jest.fn().mockReturnValue({ orderBy: nearbySecondOrderBy });
    const nearbyUpperBoundWhere = jest.fn().mockReturnValue({ orderBy: nearbyFirstOrderBy });
    const nearbyLowerBoundWhere = jest.fn().mockReturnValue({ andWhere: nearbyUpperBoundWhere });
    const nearbyWhere = jest.fn().mockReturnValue({ andWhere: nearbyLowerBoundWhere });

    const fallbackLimit = jest.fn().mockResolvedValue([
      { id: 81, buildUuid: 'uuid-3', timestamp: 2000 },
      { id: 80, buildUuid: 'uuid-3', timestamp: 1900 },
    ]);
    const fallbackOrderBy = jest.fn().mockReturnValue({ limit: fallbackLimit });
    const fallbackWhere = jest.fn().mockReturnValue({ orderBy: fallbackOrderBy });

    MockConversationMessage.query
      .mockReturnValueOnce({ findOne })
      .mockReturnValueOnce({ where: exactWhere })
      .mockReturnValueOnce({ where: nearbyWhere })
      .mockReturnValueOnce({ where: fallbackWhere });

    await expect(
      service.submitMessageFeedback({
        buildUuid: 'uuid-3',
        messageId: 99,
        messageTimestamp: 1234,
        rating: 'up',
        repo: 'org/repo',
      })
    ).rejects.toThrow('Message not found');
  });

  it('overwrites existing conversation feedback for the same build', async () => {
    const findById = jest.fn().mockResolvedValue({ buildUuid: 'uuid-5' });
    MockConversation.query.mockReturnValue({ findById });

    const existingFirst = jest.fn().mockResolvedValue({ id: 13, buildUuid: 'uuid-5', rating: 'up' });
    const existingOrderBy = jest.fn().mockReturnValue({ first: existingFirst });
    const existingWhere = jest.fn().mockReturnValue({ orderBy: existingOrderBy });
    const patchAndFetchById = jest.fn().mockResolvedValue({ id: 13, buildUuid: 'uuid-5', rating: 'down' });

    MockConversationFeedback.query
      .mockReturnValueOnce({ where: existingWhere })
      .mockReturnValueOnce({ patchAndFetchById });

    await service.submitConversationFeedback({
      buildUuid: 'uuid-5',
      rating: 'down',
      repo: 'org/repo',
      text: 'This improved',
    });

    expect(existingWhere).toHaveBeenCalledWith({ buildUuid: 'uuid-5' });
    expect(patchAndFetchById).toHaveBeenCalledWith(
      13,
      expect.objectContaining({
        rating: 'down',
        repo: 'org/repo',
        text: 'This improved',
      })
    );
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('AI: feedback updated type=conversation'));
  });
});
