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
  defaultDb: {},
  defaultRedis: {},
}));

jest.mock('server/services/ai/conversation/storage', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('server/services/ai/conversation/persistence', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('server/services/ai/feedback/FeedbackService', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('server/services/ai/feedback/resolveFeedbackContext', () => ({
  resolveFeedbackContext: jest.fn(),
}));

import { POST } from './route';
import { MAX_FEEDBACK_TEXT_LENGTH } from 'server/services/ai/feedback/constants';
import FeedbackService from 'server/services/ai/feedback/FeedbackService';
import { resolveFeedbackContext } from 'server/services/ai/feedback/resolveFeedbackContext';

const mockSubmitMessageFeedback = jest.fn();
const mockResolveFeedbackContext = resolveFeedbackContext as jest.Mock;
const MockFeedbackService = FeedbackService as unknown as jest.Mock;

function makeRequest(body: unknown, userClaims?: Record<string, unknown>): NextRequest {
  const headers = new Headers([['x-request-id', 'req-test']]);
  if (userClaims) {
    headers.set('x-user', Buffer.from(JSON.stringify(userClaims), 'utf8').toString('base64url'));
  }
  return {
    headers,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('POST /api/v2/ai/chat/[buildUuid]/messages/[messageId]/feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockFeedbackService.mockImplementation(() => ({
      submitMessageFeedback: mockSubmitMessageFeedback,
    }));
    mockResolveFeedbackContext.mockResolvedValue({ repo: 'org/repo', prNumber: 123 });
    mockSubmitMessageFeedback.mockResolvedValue({ id: 1 });
  });

  it('returns 400 for invalid messageId', async () => {
    const response = await POST(makeRequest({ rating: 'up' }), {
      params: { buildUuid: 'uuid-1', messageId: '-1' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Invalid messageId: must be a non-negative integer' },
    });
    expect(mockSubmitMessageFeedback).not.toHaveBeenCalled();
  });

  it('returns 400 when text exceeds max length', async () => {
    const response = await POST(makeRequest({ rating: 'up', text: 'a'.repeat(MAX_FEEDBACK_TEXT_LENGTH + 1) }), {
      params: { buildUuid: 'uuid-1', messageId: '1' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: `Invalid text: exceeds max length of ${MAX_FEEDBACK_TEXT_LENGTH} characters`,
      },
    });
    expect(mockSubmitMessageFeedback).not.toHaveBeenCalled();
  });

  it('accepts messageTimestamp when messageId path param is 0', async () => {
    const response = await POST(makeRequest({ rating: 'down', messageTimestamp: 1700000000000 }), {
      params: { buildUuid: 'uuid-2', messageId: '0' },
    });

    expect(response.status).toBe(201);
    expect(mockSubmitMessageFeedback).toHaveBeenCalledWith({
      buildUuid: 'uuid-2',
      messageId: undefined,
      messageTimestamp: 1700000000000,
      rating: 'down',
      text: undefined,
      userIdentifier: undefined,
      repo: 'org/repo',
      prNumber: 123,
    });
  });

  it('derives userIdentifier from auth claims when present', async () => {
    const response = await POST(
      makeRequest({ rating: 'up', messageTimestamp: 1700000000000 }, { preferred_username: 'vmelikyan' }),
      {
        params: { buildUuid: 'uuid-3', messageId: '0' },
      }
    );

    expect(response.status).toBe(201);
    expect(mockSubmitMessageFeedback).toHaveBeenCalledWith({
      buildUuid: 'uuid-3',
      messageId: undefined,
      messageTimestamp: 1700000000000,
      rating: 'up',
      text: undefined,
      userIdentifier: 'vmelikyan',
      repo: 'org/repo',
      prNumber: 123,
    });
  });
});
