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

const mockGetRequestUserIdentity = jest.fn();
const mockFindOne = jest.fn();
const mockCreateChatPreviewGrant = jest.fn();
const mockParseChatPreviewHost = jest.fn();

jest.mock('server/lib/dependencies', () => ({}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  requireRequestUserIdentity: (...args: unknown[]) => {
    const identity = mockGetRequestUserIdentity(...args);
    if (!identity) {
      throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    }
    return identity;
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockFindOne(...args),
    })),
  },
}));

jest.mock('server/lib/agentSession/chatPreviewFactory', () => ({
  parseChatPreviewHost: (...args: unknown[]) => mockParseChatPreviewHost(...args),
  resolveChatPreviewHostProtocol: jest.fn(() => 'https:'),
}));

jest.mock('server/lib/agentSession/chatPreviewGrant', () => ({
  createChatPreviewGrant: (...args: unknown[]) => mockCreateChatPreviewGrant(...args),
}));

import { POST } from './route';

function makeRequest(body: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    url: 'http://localhost/api/v2/ai/agent/preview-grants',
    nextUrl: new URL('http://localhost/api/v2/ai/agent/preview-grants'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/preview-grants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockParseChatPreviewHost.mockReturnValue({
      port: 3000,
      previewSlug: 'abcdef1234567890',
      host: '3000--abcdef1234567890.preview.lifecycle.test',
    });
    mockFindOne.mockResolvedValue({
      uuid: 'session-123',
      userId: 'sample-user',
      sessionKind: 'chat',
      status: 'active',
      workspaceStatus: 'ready',
    });
    mockCreateChatPreviewGrant.mockReturnValue({
      grant: 'grant-1',
      maxAgeSeconds: 3600,
    });
  });

  it('mints a preview grant for an owned ready chat workspace', async () => {
    const response = await POST(
      makeRequest({
        sessionId: 'session-123',
        port: 3000,
        previewHost: 'https://3000--abcdef1234567890.preview.lifecycle.test/',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledWith({
      uuid: 'session-123',
      userId: 'sample-user',
      sessionKind: 'chat',
    });
    expect(mockCreateChatPreviewGrant).toHaveBeenCalledWith({
      sessionId: 'session-123',
      port: 3000,
      userId: 'sample-user',
      previewHost: '3000--abcdef1234567890.preview.lifecycle.test',
    });
    expect(body.data).toEqual({
      grant: 'grant-1',
      maxAgeSeconds: 3600,
      previewUrl: 'https://3000--abcdef1234567890.preview.lifecycle.test/',
      cookie: {
        name: 'lfc_chat_preview_auth',
        path: '/',
        maxAgeSeconds: 3600,
      },
    });
  });

  it('hides missing or not-ready sessions', async () => {
    mockFindOne.mockResolvedValueOnce({
      uuid: 'session-123',
      userId: 'sample-user',
      sessionKind: 'chat',
      status: 'active',
      workspaceStatus: 'starting',
    });

    const response = await POST(
      makeRequest({
        sessionId: 'session-123',
        port: 3000,
        previewHost: '3000--abcdef1234567890.preview.lifecycle.test',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('preview_session_not_found');
    expect(mockCreateChatPreviewGrant).not.toHaveBeenCalled();
  });

  it('requires authentication before minting grants', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(
      makeRequest({
        sessionId: 'session-123',
        port: 3000,
        previewHost: '3000--abcdef1234567890.preview.lifecycle.test',
      })
    );

    expect(response.status).toBe(401);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockCreateChatPreviewGrant).not.toHaveBeenCalled();
  });
});
