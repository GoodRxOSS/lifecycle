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

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/services/agent/BuildContextChatService', () => {
  class BuildContextChatBuildNotFoundError extends Error {
    constructor(readonly buildUuid: string) {
      super(`Build not found: ${buildUuid}`);
      this.name = 'BuildContextChatBuildNotFoundError';
    }
  }

  return {
    __esModule: true,
    default: {
      launchBuildContextChat: jest.fn(),
    },
    BuildContextChatBuildNotFoundError,
  };
});

jest.mock('server/services/agent/ProviderRegistry', () => ({
  AgentModelSelectionError: class AgentModelSelectionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AgentModelSelectionError';
    }
  },
  MissingAgentProviderApiKeyError: class MissingAgentProviderApiKeyError extends Error {
    constructor(readonly provider: string) {
      super(`No stored API key is configured for provider "${provider}".`);
      this.name = 'MissingAgentProviderApiKeyError';
    }
  },
}));

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: {
    serializeSessionRecord: jest.fn(),
    serializeThread: jest.fn(),
  },
}));

import { POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import BuildContextChatService, {
  BuildContextChatBuildNotFoundError,
} from 'server/services/agent/BuildContextChatService';
import { AgentModelSelectionError, MissingAgentProviderApiKeyError } from 'server/services/agent/ProviderRegistry';
import AgentSessionReadService from 'server/services/agent/SessionReadService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockLaunchBuildContextChat = BuildContextChatService.launchBuildContextChat as jest.Mock;
const mockSerializeSessionRecord = AgentSessionReadService.serializeSessionRecord as jest.Mock;
const mockSerializeThread = AgentSessionReadService.serializeThread as jest.Mock;

function makeRequest(body: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/build-context-chats'),
  } as unknown as NextRequest;
}

function mockSuccessfulLaunch(overrides: { created?: boolean; reused?: boolean } = {}) {
  const session = { id: 17, uuid: 'session-1' };
  const thread = { id: 29, uuid: 'thread-1' };
  mockLaunchBuildContextChat.mockResolvedValue({
    session,
    thread,
    created: overrides.created ?? true,
    reused: overrides.reused ?? false,
    buildContext: {
      buildUuid: 'build-1',
      buildKind: 'environment',
      namespace: 'env-sample',
      baseBuildUuid: 'base-build-1',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 123,
      },
      contextFreshAt: '2026-04-30T00:00:00.000Z',
    },
  });
  mockSerializeSessionRecord.mockResolvedValue({
    session: {
      id: 'session-1',
      status: 'ready',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      defaults: { model: 'gpt-5.4', harness: 'lifecycle_ai_sdk' },
      defaultThreadId: 'thread-1',
    },
    source: { id: 'source-1', adapter: 'blank_workspace', status: 'ready' },
    sandbox: { id: null, status: 'none' },
  });
  mockSerializeThread.mockResolvedValue({
    id: 'thread-1',
    sessionId: 'session-1',
    title: 'Default thread',
    isDefault: true,
    metadata: {},
    session: { id: 'session-1' },
  });
}

describe('POST /api/v2/ai/agent/build-context-chats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockSuccessfulLaunch();
  });

  it('returns 401 for unauthenticated route access', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(makeRequest({ buildUuid: 'build-1' }));

    expect(response.status).toBe(401);
    expect(mockLaunchBuildContextChat).not.toHaveBeenCalled();
  });

  it('returns 400 for non-object launch bodies', async () => {
    const response = await POST(makeRequest(null));

    expect(response.status).toBe(400);
    expect(mockLaunchBuildContextChat).not.toHaveBeenCalled();
  });

  it.each([
    ['missing buildUuid', {}],
    ['blank buildUuid', { buildUuid: '   ' }],
    ['non-string defaults.model', { buildUuid: 'build-1', defaults: { model: 123 } }],
    ['unsupported defaults key', { buildUuid: 'build-1', defaults: { model: 'gpt-5.4', provider: 'openai' } }],
    ['unsupported source field', { buildUuid: 'build-1', source: { adapter: 'blank_workspace' } }],
    ['unsupported workspace field', { buildUuid: 'build-1', workspace: {} }],
    ['unsupported thread field', { buildUuid: 'build-1', thread: {} }],
    ['unsupported sandbox field', { buildUuid: 'build-1', sandbox: {} }],
    ['unsupported services field', { buildUuid: 'build-1', services: [] }],
    ['unsupported message field', { buildUuid: 'build-1', message: 'hello' }],
  ])('returns 400 for %s', async (_name, body) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(mockLaunchBuildContextChat).not.toHaveBeenCalled();
  });

  it('maps invalid or unknown buildUuid values to 404', async () => {
    mockLaunchBuildContextChat.mockRejectedValueOnce(new BuildContextChatBuildNotFoundError('missing-build'));

    const response = await POST(makeRequest({ buildUuid: 'missing-build' }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Build not found: missing-build');
  });

  it('maps missing provider API keys to 400', async () => {
    mockLaunchBuildContextChat.mockRejectedValueOnce(new MissingAgentProviderApiKeyError('openai'));

    const response = await POST(makeRequest({ buildUuid: 'build-1' }));

    expect(response.status).toBe(400);
  });

  it('maps invalid requested model errors to 400', async () => {
    mockLaunchBuildContextChat.mockRejectedValueOnce(new AgentModelSelectionError('Model sample-model is not enabled'));

    const response = await POST(makeRequest({ buildUuid: 'build-1', defaults: { model: 'sample-model' } }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Model sample-model is not enabled');
  });

  it('delegates launch requests and returns 201 for created chats with execution links', async () => {
    const response = await POST(makeRequest({ buildUuid: ' build-1 ', defaults: { model: ' gpt-5.4 ' } }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockLaunchBuildContextChat).toHaveBeenCalledWith({
      buildUuid: 'build-1',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      },
      model: 'gpt-5.4',
    });
    expect(mockSerializeSessionRecord).toHaveBeenCalledWith({ id: 17, uuid: 'session-1' });
    expect(mockSerializeThread).toHaveBeenCalledWith({ id: 29, uuid: 'thread-1' }, { id: 17, uuid: 'session-1' });
    expect(body.data).toEqual(
      expect.objectContaining({
        created: true,
        reused: false,
        buildContext: {
          buildUuid: 'build-1',
          buildKind: 'environment',
          namespace: 'env-sample',
          baseBuildUuid: 'base-build-1',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
          pullRequestNumber: 123,
          contextFreshAt: '2026-04-30T00:00:00.000Z',
        },
        session: {
          session: {
            id: 'session-1',
            status: 'ready',
            userId: 'sample-user',
            ownerGithubUsername: 'sample-user',
            defaults: { model: 'gpt-5.4', harness: 'lifecycle_ai_sdk' },
            defaultThreadId: 'thread-1',
          },
          source: { id: 'source-1', adapter: 'blank_workspace', status: 'ready' },
          sandbox: { id: null, status: 'none' },
        },
        thread: {
          id: 'thread-1',
          sessionId: 'session-1',
          title: 'Default thread',
          isDefault: true,
          metadata: {},
          session: { id: 'session-1' },
        },
        links: {
          messages: '/api/v2/ai/agent/threads/thread-1/messages',
          runs: '/api/v2/ai/agent/threads/thread-1/runs',
          events: '/api/v2/ai/agent/runs/{runId}/events',
          eventStream: '/api/v2/ai/agent/runs/{runId}/events/stream',
          pendingActions: '/api/v2/ai/agent/threads/thread-1/pending-actions',
        },
      })
    );
  });

  it('returns 200 for reused chats', async () => {
    mockSuccessfulLaunch({ created: false, reused: true });

    const response = await POST(makeRequest({ buildUuid: 'build-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.created).toBe(false);
    expect(body.data.reused).toBe(true);
  });
});
