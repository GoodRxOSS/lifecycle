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

import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus, BuildKind } from 'shared/constants';

const mockBuildQuery = jest.fn();
const mockAgentSessionQuery = jest.fn();
const mockAgentSessionTransaction = jest.fn();
const mockAgentThreadQuery = jest.fn();
const mockAgentSourceQuery = jest.fn();
const mockResolveSelection = jest.fn();
const mockGetRequiredStoredApiKey = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockBuildQuery(...args),
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentSessionQuery(...args),
    transaction: (...args: unknown[]) => mockAgentSessionTransaction(...args),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentThreadQuery(...args),
  },
}));

jest.mock('server/models/AgentSource', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentSourceQuery(...args),
  },
}));

jest.mock('../ProviderRegistry', () => ({
  __esModule: true,
  default: {
    resolveSelection: (...args: unknown[]) => mockResolveSelection(...args),
    getRequiredStoredApiKey: (...args: unknown[]) => mockGetRequiredStoredApiKey(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: mockLoggerInfo,
  }),
}));

jest.mock('server/lib/dependencies', () => ({}));

import BuildContextChatService, { BuildContextChatBuildNotFoundError } from '../BuildContextChatService';

const NOW = '2026-04-30T12:00:00.000Z';
const TEST_TRX = { name: 'trx' };

function mockBuildLookup(build: Record<string, unknown> | null) {
  const withGraphFetched = jest.fn().mockResolvedValue(build);
  const findOne = jest.fn(() => ({ withGraphFetched }));
  mockBuildQuery.mockReturnValueOnce({ findOne });
  return { findOne, withGraphFetched };
}

function buildSessionReadQuery({ firstResult, findOneResult }: { firstResult: unknown; findOneResult: unknown }) {
  const query = {
    where: jest.fn(() => query),
    orderBy: jest.fn(() => query),
    first: jest.fn().mockResolvedValue(firstResult),
    findOne: jest.fn().mockResolvedValue(findOneResult),
  };
  return query;
}

function arrangeCreatePath({
  build,
  reuseSession = null,
}: {
  build: Record<string, unknown>;
  reuseSession?: Record<string, unknown> | null;
}) {
  const buildLookup = mockBuildLookup(build);
  const insertedThread = {
    id: 23,
    uuid: 'thread-uuid-1',
    sessionId: 17,
    isDefault: true,
    archivedAt: null,
  };
  let insertedSession: Record<string, unknown> | null = null;
  let finalizedSession: Record<string, unknown> | null = null;

  const sessionInsertAndFetch = jest.fn(async (payload) => {
    insertedSession = {
      id: 17,
      uuid: payload.uuid,
      defaultThreadId: null,
      ...payload,
      updatedAt: NOW,
      createdAt: NOW,
    };
    return insertedSession;
  });
  const sessionPatchAndFetchById = jest.fn(async (_id, patch) => {
    finalizedSession = {
      ...insertedSession,
      ...patch,
    };
    return finalizedSession;
  });
  const sourceInsertAndFetch = jest.fn(async (payload) => ({ id: 31, ...payload }));
  const threadInsertAndFetch = jest.fn(async (payload) => ({
    ...insertedThread,
    ...payload,
  }));

  const reuseQuery = buildSessionReadQuery({
    firstResult: reuseSession,
    findOneResult: () => finalizedSession || insertedSession,
  });
  const ownedQuery = buildSessionReadQuery({
    firstResult: null,
    findOneResult: () => finalizedSession || insertedSession,
  });
  const sessionReadQueries = [reuseQuery, ownedQuery];

  mockAgentSessionQuery.mockImplementation((trx?: unknown) => {
    if (trx) {
      return {
        insertAndFetch: sessionInsertAndFetch,
        patchAndFetchById: sessionPatchAndFetchById,
      };
    }

    const nextQuery =
      sessionReadQueries.shift() ||
      buildSessionReadQuery({ firstResult: null, findOneResult: () => finalizedSession || insertedSession });

    return {
      ...nextQuery,
      findOne: jest.fn(async (...args: unknown[]) => {
        const result = await nextQuery.findOne(...args);
        return typeof result === 'function' ? result() : result;
      }),
    };
  });

  mockAgentSessionTransaction.mockImplementation(async (callback) => callback(TEST_TRX));

  mockAgentThreadQuery.mockImplementation((trx?: unknown) => {
    if (trx) {
      return {
        insertAndFetch: threadInsertAndFetch,
      };
    }

    return {
      findOne: jest.fn().mockResolvedValue(insertedThread),
      insertAndFetch: threadInsertAndFetch,
    };
  });

  mockAgentSourceQuery.mockReturnValue({
    insertAndFetch: sourceInsertAndFetch,
  });

  return {
    buildLookup,
    reuseQuery,
    sessionInsertAndFetch,
    sessionPatchAndFetchById,
    sourceInsertAndFetch,
    threadInsertAndFetch,
    get insertedThread() {
      return insertedThread;
    },
  };
}

function arrangeReusePath({
  build,
  existingSession,
  defaultThread,
}: {
  build: Record<string, unknown>;
  existingSession: Record<string, unknown>;
  defaultThread: Record<string, unknown> | null;
}) {
  const buildLookup = mockBuildLookup(build);
  const reuseQuery = buildSessionReadQuery({ firstResult: existingSession, findOneResult: existingSession });
  const ownedQuery = buildSessionReadQuery({ firstResult: null, findOneResult: existingSession });
  const sessionReadQueries = [reuseQuery, ownedQuery];
  const recreatedThread = {
    id: 29,
    uuid: 'thread-uuid-recreated',
    sessionId: existingSession.id,
    isDefault: true,
    archivedAt: null,
    metadata: {
      sessionUuid: existingSession.uuid,
    },
  };
  const threadFindOne = jest.fn().mockResolvedValue(defaultThread);
  const threadInsertAndFetch = jest.fn().mockResolvedValue(recreatedThread);
  const threadQueries = defaultThread
    ? [{ findOne: threadFindOne }]
    : [{ findOne: threadFindOne }, { insertAndFetch: threadInsertAndFetch }];

  mockAgentSessionQuery.mockImplementation((trx?: unknown) => {
    if (trx) {
      throw new Error('create path should not run when an active build-context chat can be reused');
    }

    return sessionReadQueries.shift() || ownedQuery;
  });
  mockAgentSessionTransaction.mockImplementation(() => {
    throw new Error('transaction should not run when an active build-context chat can be reused');
  });
  mockAgentThreadQuery.mockImplementation(() => threadQueries.shift() || { findOne: threadFindOne });

  return {
    buildLookup,
    reuseQuery,
    threadFindOne,
    threadInsertAndFetch,
    recreatedThread,
  };
}

function sampleBuild(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'build-uuid-1',
    kind: BuildKind.ENVIRONMENT,
    namespace: 'env-sample-123',
    sha: 'commit-sha-1',
    baseBuild: {
      uuid: 'base-build-uuid-1',
    },
    pullRequest: {
      fullName: 'example-org/example-repo',
      branchName: 'feature/sample-change',
      pullRequestNumber: 42,
      latestCommit: 'latest-pr-commit-1',
    },
    ...overrides,
  };
}

function sampleActiveChatSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    uuid: 'session-uuid-existing',
    buildUuid: 'build-uuid-1',
    buildKind: null,
    sessionKind: AgentSessionKind.CHAT,
    userId: 'sample-user',
    status: 'active',
    chatStatus: AgentChatStatus.READY,
    workspaceStatus: AgentWorkspaceStatus.NONE,
    createdAt: '2026-04-30T11:00:00.000Z',
    updatedAt: '2026-04-30T11:10:00.000Z',
    ...overrides,
  };
}

describe('BuildContextChatService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(NOW));
    mockResolveSelection.mockResolvedValue({
      provider: 'gemini',
      modelId: 'gemini-3-flash-preview',
    });
    mockGetRequiredStoredApiKey.mockResolvedValue('sample-api-key');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a ready chat session, default thread, and build-context source for a valid build', async () => {
    const build = sampleBuild();
    const arranged = arrangeCreatePath({ build });

    const result = await BuildContextChatService.launchBuildContextChat({
      buildUuid: 'build-uuid-1',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
        preferredUsername: null,
        email: 'sample-user@example.com',
        firstName: null,
        lastName: null,
        displayName: 'Sample User',
        gitUserName: 'Sample User',
        gitUserEmail: 'sample-user@example.com',
      },
      model: 'gemini-3-flash-preview',
    });

    expect(arranged.buildLookup.findOne).toHaveBeenCalledWith({ uuid: 'build-uuid-1' });
    expect(arranged.buildLookup.withGraphFetched).toHaveBeenCalledWith('[pullRequest, baseBuild]');
    expect(mockResolveSelection).toHaveBeenCalledWith({
      repoFullName: 'example-org/example-repo',
      requestedProvider: undefined,
      requestedModelId: 'gemini-3-flash-preview',
    });
    expect(mockGetRequiredStoredApiKey).toHaveBeenCalledWith({
      provider: 'gemini',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      },
    });
    expect(arranged.sessionInsertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        buildUuid: 'build-uuid-1',
        buildKind: null,
        sessionKind: AgentSessionKind.CHAT,
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        podName: null,
        namespace: null,
        pvcName: null,
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.NONE,
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/sample-change',
            revision: 'commit-sha-1',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
      })
    );

    const launchMetadata = {
      buildUuid: 'build-uuid-1',
      buildKind: BuildKind.ENVIRONMENT,
      sessionKind: AgentSessionKind.CHAT,
      namespace: 'env-sample-123',
      baseBuildUuid: 'base-build-uuid-1',
      revision: 'commit-sha-1',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample-change',
        pullRequestNumber: 42,
      },
      contextFreshAt: NOW,
    };
    expect(arranged.sourceInsertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 17,
        adapter: 'blank_workspace',
        status: 'ready',
        input: {
          ...launchMetadata,
          defaults: {
            provider: 'gemini',
            model: 'gemini-3-flash-preview',
          },
        },
        preparedSource: expect.objectContaining({
          workspaceLayout: expect.objectContaining({
            repos: [],
          }),
          metadata: launchMetadata,
        }),
      })
    );
    expect(result).toMatchObject({
      thread: arranged.insertedThread,
      created: true,
      reused: false,
      buildContext: {
        buildUuid: 'build-uuid-1',
        buildKind: BuildKind.ENVIRONMENT,
        namespace: 'env-sample-123',
        baseBuildUuid: 'base-build-uuid-1',
        revision: 'commit-sha-1',
        pullRequest: {
          fullName: 'example-org/example-repo',
          branchName: 'feature/sample-change',
          pullRequestNumber: 42,
        },
        contextFreshAt: NOW,
      },
    });
    expect(result.session).toMatchObject({
      buildUuid: 'build-uuid-1',
      buildKind: null,
      sessionKind: AgentSessionKind.CHAT,
      workspaceStatus: AgentWorkspaceStatus.NONE,
      chatStatus: AgentChatStatus.READY,
      podName: null,
      namespace: null,
      pvcName: null,
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('Session: launched build-context chat buildUuid=build-uuid-1')
    );
  });

  it('throws a typed not-found error for an invalid or unknown buildUuid', async () => {
    mockBuildLookup(null);

    await expect(
      BuildContextChatService.launchBuildContextChat({
        buildUuid: 'missing-build-uuid',
        userId: 'sample-user',
      })
    ).rejects.toBeInstanceOf(BuildContextChatBuildNotFoundError);

    expect(mockAgentSessionTransaction).not.toHaveBeenCalled();
  });

  it('re-reads and reuses the active chat when a concurrent launch wins the unique constraint race', async () => {
    mockBuildLookup(sampleBuild());
    const racedSession = sampleActiveChatSession({
      uuid: 'session-uuid-raced',
    });
    const defaultThread = {
      id: 23,
      uuid: 'thread-uuid-raced',
      sessionId: 17,
      isDefault: true,
      archivedAt: null,
    };
    const reuseMissQuery = buildSessionReadQuery({ firstResult: null, findOneResult: null });
    const reuseHitQuery = buildSessionReadQuery({ firstResult: racedSession, findOneResult: racedSession });
    const ownedQuery = buildSessionReadQuery({ firstResult: null, findOneResult: racedSession });
    const sessionReadQueries = [reuseMissQuery, reuseHitQuery, ownedQuery];
    mockAgentSessionQuery.mockImplementation((trx?: unknown) => {
      if (trx) {
        return {
          insertAndFetch: jest.fn(),
          patchAndFetchById: jest.fn(),
        };
      }

      return sessionReadQueries.shift() || ownedQuery;
    });
    mockAgentSessionTransaction.mockRejectedValueOnce({
      code: '23505',
      constraint: 'agent_sessions_active_build_context_chat_unique',
    });
    mockAgentThreadQuery.mockReturnValue({
      findOne: jest.fn().mockResolvedValue(defaultThread),
    });

    const result = await BuildContextChatService.launchBuildContextChat({
      buildUuid: 'build-uuid-1',
      userId: 'sample-user',
    });

    expect(mockAgentSessionTransaction).toHaveBeenCalled();
    expect(reuseMissQuery.first).toHaveBeenCalledTimes(1);
    expect(reuseHitQuery.first).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      session: racedSession,
      thread: defaultThread,
      created: false,
      reused: true,
    });
  });

  it('reuses the latest active same user build-context chat and active default thread', async () => {
    const existingSession = sampleActiveChatSession();
    const defaultThread = {
      id: 23,
      uuid: 'thread-uuid-existing',
      sessionId: 17,
      isDefault: true,
      archivedAt: null,
    };
    const arranged = arrangeReusePath({
      build: sampleBuild(),
      existingSession,
      defaultThread,
    });

    const result = await BuildContextChatService.launchBuildContextChat({
      buildUuid: 'build-uuid-1',
      userId: 'sample-user',
    });

    expect(arranged.reuseQuery.where).toHaveBeenCalledWith({
      userId: 'sample-user',
      buildUuid: 'build-uuid-1',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      chatStatus: AgentChatStatus.READY,
    });
    expect(arranged.reuseQuery.orderBy).toHaveBeenNthCalledWith(1, 'updatedAt', 'desc');
    expect(arranged.reuseQuery.orderBy).toHaveBeenNthCalledWith(2, 'createdAt', 'desc');
    expect(result).toMatchObject({
      session: existingSession,
      thread: defaultThread,
      created: false,
      reused: true,
    });
    expect(mockAgentSessionTransaction).not.toHaveBeenCalled();
  });

  it('creates a separate chat when a different user launches the same buildUuid', async () => {
    const arranged = arrangeCreatePath({ build: sampleBuild() });

    const result = await BuildContextChatService.launchBuildContextChat({
      buildUuid: 'build-uuid-1',
      userId: 'sample-user-2',
    });

    expect(arranged.reuseQuery.where).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user-2',
        buildUuid: 'build-uuid-1',
      })
    );
    expect(result).toMatchObject({
      created: true,
      reused: false,
    });
  });

  it('ignores active environment or sandbox sessions and ended or errored chat sessions', async () => {
    const arranged = arrangeCreatePath({ build: sampleBuild({ kind: BuildKind.SANDBOX }) });

    const result = await BuildContextChatService.launchBuildContextChat({
      buildUuid: 'build-uuid-1',
      userId: 'sample-user',
    });

    expect(arranged.reuseQuery.where).toHaveBeenCalledWith({
      userId: 'sample-user',
      buildUuid: 'build-uuid-1',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      chatStatus: AgentChatStatus.READY,
    });
    expect(result).toMatchObject({
      created: true,
      reused: false,
    });
  });

  it('recreates a missing or archived default thread when reusing a chat session', async () => {
    const existingSession = sampleActiveChatSession();
    const arranged = arrangeReusePath({
      build: sampleBuild(),
      existingSession,
      defaultThread: null,
    });

    const result = await BuildContextChatService.launchBuildContextChat({
      buildUuid: 'build-uuid-1',
      userId: 'sample-user',
    });

    expect(arranged.threadFindOne).toHaveBeenCalledWith({
      sessionId: 17,
      isDefault: true,
      archivedAt: null,
    });
    expect(arranged.threadInsertAndFetch).toHaveBeenCalledWith({
      sessionId: 17,
      title: 'Default thread',
      isDefault: true,
      metadata: {
        sessionUuid: 'session-uuid-existing',
      },
    });
    expect(result).toMatchObject({
      thread: arranged.recreatedThread,
      created: false,
      reused: true,
    });
  });
});
