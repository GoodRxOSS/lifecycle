/**
 * Copyright 2026 GoodRx, Inc.
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
import { BadRequestError, ConflictError, NotFoundError } from 'server/lib/appError';

const mockIdentity = jest.fn();
const mockList = jest.fn();
const mockSet = jest.fn();
const mockDelete = jest.fn();
const mockAdminList = jest.fn();
jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
  getUser: () => {
    const identity = mockIdentity();
    return identity ? { sub: identity.userId, realm_access: { roles: identity.roles } } : null;
  },
  requireRequestUserIdentity: (...args: unknown[]) => {
    const identity = mockIdentity(...args);
    if (!identity) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return identity;
  },
}));
jest.mock('server/services/agent/FeedbackService', () => ({
  __esModule: true,
  default: {
    listOwnedThreadFeedback: (...args: unknown[]) => mockList(...args),
    setFeedback: (...args: unknown[]) => mockSet(...args),
    deleteFeedback: (...args: unknown[]) => mockDelete(...args),
    listAdminFeedback: (...args: unknown[]) => mockAdminList(...args),
  },
}));

import { GET, PUT, DELETE } from './threads/[threadId]/feedback/route';
import { PUT as MESSAGE_PUT, DELETE as MESSAGE_DELETE } from './threads/[threadId]/messages/[messageId]/feedback/route';
import { GET as ADMIN_GET } from '../admin/agent/feedback/route';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '00000000-0000-4000-8000-000000000002';
const saved = {
  id: 'feedback-id',
  threadId: THREAD_ID,
  messageId: null,
  rating: 'up',
  text: null,
  reasons: ['solved_task'],
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
};
function request(
  body: unknown = { rating: 'up' },
  url = 'http://localhost/api/v2/ai/agent/threads/' + THREAD_ID + '/feedback'
) {
  return {
    headers: new Headers(),
    nextUrl: new URL(url),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}
const threadContext = { params: Promise.resolve({ threadId: THREAD_ID }) };
const messageContext = { params: Promise.resolve({ threadId: THREAD_ID, messageId: MESSAGE_ID }) };
const ownerRoutes = [
  ['GET', GET, threadContext],
  ['PUT', PUT, threadContext],
  ['DELETE', DELETE, threadContext],
  ['MESSAGE_PUT', MESSAGE_PUT, messageContext],
  ['MESSAGE_DELETE', MESSAGE_DELETE, messageContext],
] as const;
const originalAuth = process.env.ENABLE_AUTH;
afterAll(() => {
  if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
  else process.env.ENABLE_AUTH = originalAuth;
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  mockIdentity.mockReturnValue({ userId: 'owner-id', githubUsername: 'alice', roles: ['user'] });
  mockList.mockResolvedValue({ feedback: [saved], canRateThread: true, eligibleMessageIds: [MESSAGE_ID] });
  mockSet.mockResolvedValue(saved);
  mockDelete.mockResolvedValue({ deleted: true });
  mockAdminList.mockResolvedValue({
    data: [],
    metadata: { pagination: { current: 1, total: 1, items: 0, limit: 25 } },
  });
});

describe('canonical feedback owner routes', () => {
  it.each(ownerRoutes)('%s requires an authenticated interactive identity', async (_name, handler, context) => {
    mockIdentity.mockReturnValue(null);
    const response = await handler(request(), context);
    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it.each(ownerRoutes)('%s rejects API keys before any feedback lookup', async (_name, handler, context) => {
    const req = request();
    req.headers.set('authorization', 'Bearer lfc_test_key');
    const response = await handler(req, context);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('interactive_auth_required');
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it('GET returns persisted ratings with authoritative eligibility', async () => {
    const response = await GET(request(), threadContext);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      feedback: [saved],
      canRateThread: true,
      eligibleMessageIds: [MESSAGE_ID],
    });
    expect(mockList).toHaveBeenCalledWith(THREAD_ID, 'owner-id');
  });
  it.each([
    ['conversation', PUT, threadContext, { threadId: THREAD_ID }],
    ['reply', MESSAGE_PUT, messageContext, { threadId: THREAD_ID, messageId: MESSAGE_ID }],
  ] as const)('PUT uses the authenticated owner and exact %s target', async (_name, handler, context, target) => {
    const value = { rating: 'down', text: 'Missing evidence', reasons: ['incorrect_or_incomplete', 'other'] };
    const response = await handler(request(value), context);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(saved);
    expect(mockSet).toHaveBeenCalledWith({ ...target, userId: 'owner-id' }, value);
  });
  it.each([PUT, MESSAGE_PUT])('rejects malformed JSON before calling persistence', async (handler) => {
    const req = request();
    req.json = jest.fn().mockRejectedValue(new SyntaxError('bad json'));
    const response = await handler(req, messageContext);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_feedback');
    expect(mockSet).not.toHaveBeenCalled();
  });
  it.each([
    [new BadRequestError('Invalid text', 'invalid_feedback'), 400],
    [new NotFoundError('Agent thread not found'), 404],
    [new ConflictError('Not enabled', 'feedback_not_enabled'), 409],
    [new ConflictError('Still running', 'feedback_message_not_finished'), 409],
  ] as const)('preserves typed service error status', async (error, status) => {
    mockSet.mockRejectedValue(error);
    const response = await PUT(request(), threadContext);
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(error.code);
  });
  it.each([
    ['conversation', DELETE, threadContext, { threadId: THREAD_ID }],
    ['reply', MESSAGE_DELETE, messageContext, { threadId: THREAD_ID, messageId: MESSAGE_ID }],
  ] as const)('DELETE retracts only the authenticated owners %s rating', async (_name, handler, context, target) => {
    const response = await handler(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ deleted: true });
    expect(mockDelete).toHaveBeenCalledWith({ ...target, userId: 'owner-id' });
  });
});

describe('feedback administrator review route', () => {
  it('rejects unauthenticated requests', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await ADMIN_GET(request())).status).toBe(401);
    expect(mockAdminList).not.toHaveBeenCalled();
  });
  it('rejects non-admin users before querying other users feedback', async () => {
    expect((await ADMIN_GET(request())).status).toBe(403);
    expect(mockAdminList).not.toHaveBeenCalled();
  });
  it('forwards bounded filters and returns pagination to administrators', async () => {
    mockIdentity.mockReturnValue({ userId: 'admin-id', roles: ['admin'] });
    const response = await ADMIN_GET(
      request(
        undefined,
        'http://localhost/api/v2/ai/admin/agent/feedback?page=2&limit=50&rating=down&scope=message&repo=org%2Frepo&user=alice'
      )
    );
    expect(response.status).toBe(200);
    expect(mockAdminList).toHaveBeenCalledWith({
      page: 2,
      limit: 50,
      rating: 'down',
      scope: 'message',
      repo: 'org/repo',
      user: 'alice',
    });
    expect((await response.json()).metadata.pagination).toEqual({ current: 1, total: 1, items: 0, limit: 25 });
  });
  it('defaults missing query values and preserves invalid numeric input for validation', async () => {
    mockIdentity.mockReturnValue({ userId: 'admin-id', roles: ['admin'] });
    await ADMIN_GET(request());
    expect(mockAdminList).toHaveBeenCalledWith({
      page: 1,
      limit: 25,
      rating: 'all',
      scope: 'all',
      repo: undefined,
      user: undefined,
    });
    mockAdminList.mockRejectedValueOnce(new BadRequestError('Invalid pagination', 'invalid_feedback_filter'));
    const response = await ADMIN_GET(
      request(undefined, 'http://localhost/api/v2/ai/admin/agent/feedback?page=garbage')
    );
    expect(response.status).toBe(400);
    expect(mockAdminList.mock.calls[1][0].page).toBeNaN();
  });
});
