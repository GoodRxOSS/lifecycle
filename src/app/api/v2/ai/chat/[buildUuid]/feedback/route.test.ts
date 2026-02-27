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

const mockSubmitConversationFeedback = jest.fn();
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

describe('POST /api/v2/ai/chat/[buildUuid]/feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockFeedbackService.mockImplementation(() => ({
      submitConversationFeedback: mockSubmitConversationFeedback,
    }));
    mockResolveFeedbackContext.mockResolvedValue({ repo: 'org/repo', prNumber: 123 });
    mockSubmitConversationFeedback.mockResolvedValue({ id: 1 });
  });

  it('returns 400 when text is not a string', async () => {
    const response = await POST(makeRequest({ rating: 'up', text: 123 }), {
      params: { buildUuid: 'uuid-1' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Invalid text: must be a string' },
    });
    expect(mockSubmitConversationFeedback).not.toHaveBeenCalled();
  });

  it('returns 400 when text exceeds max length', async () => {
    const response = await POST(makeRequest({ rating: 'up', text: 'a'.repeat(MAX_FEEDBACK_TEXT_LENGTH + 1) }), {
      params: { buildUuid: 'uuid-1' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: `Invalid text: exceeds max length of ${MAX_FEEDBACK_TEXT_LENGTH} characters`,
      },
    });
    expect(mockSubmitConversationFeedback).not.toHaveBeenCalled();
  });

  it('returns 404 when repository context cannot be resolved', async () => {
    mockResolveFeedbackContext.mockResolvedValue({ repo: '' });

    const response = await POST(makeRequest({ rating: 'up' }), {
      params: { buildUuid: 'uuid-2' },
    });

    expect(response.status).toBe(404);
    expect(mockSubmitConversationFeedback).not.toHaveBeenCalled();
  });

  it('submits feedback successfully', async () => {
    const response = await POST(makeRequest({ rating: 'down', text: 'Needs work' }), {
      params: { buildUuid: 'uuid-3' },
    });

    expect(response.status).toBe(201);
    expect(mockSubmitConversationFeedback).toHaveBeenCalledWith({
      buildUuid: 'uuid-3',
      rating: 'down',
      text: 'Needs work',
      userIdentifier: undefined,
      repo: 'org/repo',
      prNumber: 123,
    });
  });

  it('derives userIdentifier from auth claims when present', async () => {
    const response = await POST(makeRequest({ rating: 'up' }, { github_username: 'vmelikyan' }), {
      params: { buildUuid: 'uuid-4' },
    });

    expect(response.status).toBe(201);
    expect(mockSubmitConversationFeedback).toHaveBeenCalledWith({
      buildUuid: 'uuid-4',
      rating: 'up',
      text: undefined,
      userIdentifier: 'vmelikyan',
      repo: 'org/repo',
      prNumber: 123,
    });
  });
});
