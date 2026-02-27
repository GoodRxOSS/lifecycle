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

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {
    knex: Object.assign(jest.fn(), {
      raw: jest.fn(),
      from: jest.fn(),
      queryBuilder: jest.fn(),
    }),
  },
}));

import { GET } from './route';
import { defaultDb } from 'server/lib/dependencies';

const mockKnex = defaultDb.knex as jest.Mock & {
  raw: jest.Mock;
  from: jest.Mock;
  queryBuilder: jest.Mock;
};

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

function createMessageFeedbackQueryBuilder() {
  const query: any = {};
  query.leftJoin = jest.fn().mockReturnValue(query);
  query.select = jest.fn().mockReturnValue(query);
  query.where = jest.fn().mockReturnValue(query);
  query.clone = jest.fn().mockReturnValue({
    as: jest.fn().mockReturnValue('feedback_count_query'),
  });
  query.as = jest.fn().mockReturnValue('feedback_rows_query');
  return query;
}

function createConversationFeedbackQueryBuilder() {
  const query: any = {};
  query.select = jest.fn().mockReturnValue(query);
  query.where = jest.fn().mockReturnValue(query);
  query.clone = jest.fn().mockReturnValue({
    as: jest.fn().mockReturnValue('feedback_count_query'),
  });
  query.as = jest.fn().mockReturnValue('feedback_rows_query');
  return query;
}

describe('GET /api/v2/ai/admin/feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKnex.raw.mockImplementation((sql: string, bindings?: unknown[]) => ({ sql, bindings }));
    mockKnex.queryBuilder.mockReturnValue({
      unionAll: jest.fn(),
    });
  });

  it('returns message feedback rows with safe Unicode truncation and default sorting', async () => {
    const messageQueryBuilder = createMessageFeedbackQueryBuilder();

    mockKnex.mockImplementation((table: string) => {
      if (table === 'message_feedback as mf') {
        return messageQueryBuilder;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    const countBuilder = {
      count: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ count: '1' }),
    };
    const rowsBuilder = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([
        {
          id: 'message-1',
          feedbackType: 'message',
          buildUuid: 'uuid-1',
          rating: 'up',
          text: null,
          userIdentifier: 'vmelikyan',
          repo: 'org/repo',
          prNumber: null,
          messageId: 11,
          messagePreview: null,
          messageContent: '😀'.repeat(200),
          messageMetadata: {
            debugMetrics: {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              inputCostPerMillion: 1.5,
              outputCostPerMillion: 2.5,
            },
          },
          createdAt: '2026-02-27T10:00:00.000Z',
        },
      ]),
    };

    mockKnex.from.mockReturnValueOnce(countBuilder).mockReturnValueOnce(rowsBuilder);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/feedback?type=message&page=1&limit=25'));
    const body = await response.json();
    const preview = body.data[0].messagePreview as string;
    const previewWithoutEllipsis = preview.endsWith('…') ? preview.slice(0, -1) : preview;

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(preview.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(previewWithoutEllipsis)).toBe(false);
    expect(body.data[0].userIdentifier).toBe('vmelikyan');
    expect(body.data[0].costUsd).toBeCloseTo(4, 6);
    expect(rowsBuilder.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
  });

  it('returns conversation feedback rows with aggregated session cost', async () => {
    const conversationQueryBuilder = createConversationFeedbackQueryBuilder();

    const conversationMessagesBuilder = {
      select: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockResolvedValue([
        {
          buildUuid: 'uuid-2',
          metadata: {
            debugMetrics: {
              inputTokens: 2_000_000,
              outputTokens: 0,
              inputCostPerMillion: 1,
              outputCostPerMillion: 1,
            },
          },
        },
        {
          buildUuid: 'uuid-2',
          metadata: {
            debugMetrics: {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              inputCostPerMillion: 1,
              outputCostPerMillion: 1,
            },
          },
        },
      ]),
    };

    mockKnex.mockImplementation((table: string) => {
      if (table === 'conversation_feedback as cf') {
        return conversationQueryBuilder;
      }
      if (table === 'conversation_messages as cm') {
        return conversationMessagesBuilder;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    const countBuilder = {
      count: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ count: '1' }),
    };
    const rowsBuilder = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([
        {
          id: 'conversation-1',
          feedbackType: 'conversation',
          buildUuid: 'uuid-2',
          rating: 'up',
          text: 'Great session',
          userIdentifier: 'vmelikyan',
          repo: 'org/repo',
          prNumber: null,
          messageId: null,
          messagePreview: null,
          messageContent: null,
          messageMetadata: null,
          createdAt: '2026-02-27T11:00:00.000Z',
        },
      ]),
    };

    mockKnex.from.mockReturnValueOnce(countBuilder).mockReturnValueOnce(rowsBuilder);

    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/admin/feedback?type=conversation&page=1&limit=25')
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].userIdentifier).toBe('vmelikyan');
    expect(body.data[0].costUsd).toBeCloseTo(4, 6);
    expect(conversationMessagesBuilder.whereIn).toHaveBeenCalledWith('cm.buildUuid', ['uuid-2']);
  });
});
