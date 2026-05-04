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
const mockCreateChatSession = jest.fn();
const mockSerializeSessionRecord = jest.fn();
const mockResolveAgentSessionRuntimeConfig = jest.fn();
const mockResolveAgentSessionWorkspaceStorageIntent = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
}));

jest.mock('server/services/agent/ChatSessionService', () => ({
  __esModule: true,
  default: {
    createChatSession: (...args: unknown[]) => mockCreateChatSession(...args),
  },
}));

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: {
    listOwnedSessionRecords: jest.fn(),
    serializeSessionRecord: (...args: unknown[]) => mockSerializeSessionRecord(...args),
  },
  DEFAULT_AGENT_SESSION_LIST_LIMIT: 25,
  MAX_AGENT_SESSION_LIST_LIMIT: 100,
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  class AgentSessionRuntimeConfigError extends Error {}
  class AgentSessionWorkspaceStorageConfigError extends Error {}

  return {
    resolveAgentSessionRuntimeConfig: (...args: unknown[]) => mockResolveAgentSessionRuntimeConfig(...args),
    resolveAgentSessionWorkspaceStorageIntent: (...args: unknown[]) =>
      mockResolveAgentSessionWorkspaceStorageIntent(...args),
    AgentSessionRuntimeConfigError,
    AgentSessionWorkspaceStorageConfigError,
  };
});

jest.mock('server/services/agent/ProviderRegistry', () => {
  class MissingAgentProviderApiKeyError extends Error {}
  return {
    __esModule: true,
    default: {},
    MissingAgentProviderApiKeyError,
  };
});

jest.mock('server/services/agent/ThreadRuntimeControlsService', () => {
  class AgentThreadRuntimeControlsError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = 'AgentThreadRuntimeControlsError';
    }
  }

  return {
    __esModule: true,
    AgentThreadRuntimeControlsError,
  };
});

import { POST } from './route';
import { AgentThreadRuntimeControlsError } from 'server/services/agent/ThreadRuntimeControlsService';

const userIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
  preferredUsername: 'sample-user',
  email: 'sample-user@example.com',
  firstName: 'Sample',
  lastName: 'User',
  displayName: 'Sample User',
  gitUserName: 'Sample User',
  gitUserEmail: 'sample-user@example.com',
};

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sessions runtimeControlChoices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue(userIdentity);
    mockResolveAgentSessionRuntimeConfig.mockResolvedValue({
      workspaceStorage: {},
    });
    mockResolveAgentSessionWorkspaceStorageIntent.mockReturnValue(undefined);
    mockCreateChatSession.mockResolvedValue({ uuid: 'session-1' });
    mockSerializeSessionRecord.mockResolvedValue({
      session: {
        id: 'session-1',
        status: 'ready',
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        defaults: { provider: 'openai', model: 'sample-model', harness: null },
        defaultThreadId: 'thread-1',
      },
      source: {},
      sandbox: {},
    });
  });

  it('passes runtimeControlChoices to chat session creation', async () => {
    const body = {
      defaults: { provider: 'openai', model: 'sample-model' },
      source: { adapter: 'blank_workspace', input: {} },
      runtimeControlChoices: {
        agentId: 'custom.sample-agent',
        toolChoiceIds: ['rtc_tool_choice'],
        mcpChoiceIds: [],
      },
    };

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(201);
    expect(mockCreateChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        userIdentity,
        provider: 'openai',
        model: 'sample-model',
        runtimeControlChoices: body.runtimeControlChoices,
      })
    );
  });

  it('preserves current behavior when runtimeControlChoices is absent', async () => {
    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: { adapter: 'blank_workspace', input: {} },
      })
    );

    expect(response.status).toBe(201);
    expect(mockCreateChatSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        runtimeControlChoices: expect.anything(),
      })
    );
  });

  it('maps invalid bootstrap runtime choices to 403', async () => {
    mockCreateChatSession.mockRejectedValueOnce(
      new AgentThreadRuntimeControlsError('policy_denied', 'Runtime control choice is unavailable.')
    );

    const response = await POST(
      makeRequest({
        defaults: { provider: 'openai', model: 'sample-model' },
        source: { adapter: 'blank_workspace', input: {} },
        runtimeControlChoices: {
          toolChoiceIds: ['rtc_denied'],
          mcpChoiceIds: [],
        },
      })
    );

    expect(response.status).toBe(403);
  });
});
