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

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentSource', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentSandbox', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentSandboxExposure', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

const mockThreadKnexRaw = jest.fn();
jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    knex: jest.fn(() => ({ raw: (...args: unknown[]) => mockThreadKnexRaw(...args) })),
  },
}));

jest.mock('server/services/agent/SandboxService', () => ({
  __esModule: true,
  default: {
    serializeSandboxExposure: jest.fn((exposure) => ({
      id: exposure.uuid,
      kind: exposure.kind,
      status: exposure.status,
      targetPort: exposure.targetPort,
      url: exposure.url,
      metadata: exposure.metadata || {},
      lastVerifiedAt: exposure.lastVerifiedAt,
      endedAt: exposure.endedAt,
      createdAt: exposure.createdAt || null,
      updatedAt: exposure.updatedAt || null,
    })),
  },
}));

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  default: {
    serializeThread: jest.fn(),
  },
}));

jest.mock('server/services/agent/AgentUsageService', () => ({
  __esModule: true,
  default: {
    aggregateRuns: jest.fn(() => ({
      usageSummary: { totalTokens: 0 },
      usageByModel: [],
      usageCompleteness: {
        runCount: 0,
        reportedRunCount: 0,
        missingUsageRunCount: 0,
        complete: true,
      },
    })),
    aggregateSessionsUsage: jest.fn(),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
    resolveAgentSessionCleanupConfig: jest.fn().mockResolvedValue({
      activeIdleSuspendMs: 30 * 60 * 1000,
      startingTimeoutMs: 15 * 60 * 1000,
      hibernatedRetentionMs: 24 * 60 * 60 * 1000,
      idleArchiveMs: 30 * 24 * 60 * 60 * 1000,
      intervalMs: 5 * 60 * 1000,
      redisTtlSeconds: 7200,
    }),
  };
});

import AgentSession from 'server/models/AgentSession';
import AgentSource from 'server/models/AgentSource';
import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentThread from 'server/models/AgentThread';
import AgentUsageService from 'server/services/agent/AgentUsageService';
import AgentThreadService from '../ThreadService';
import AgentSessionReadService, {
  DEFAULT_AGENT_SESSION_LIST_LIMIT,
  MAX_AGENT_SESSION_LIST_LIMIT,
} from '../SessionReadService';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';

const mockSessionQuery = AgentSession.query as jest.Mock;
const mockSourceQuery = AgentSource.query as jest.Mock;
const mockSandboxQuery = AgentSandbox.query as jest.Mock;
const mockSandboxExposureQuery = AgentSandboxExposure.query as jest.Mock;
const mockThreadQuery = AgentThread.query as jest.Mock;
const mockAggregateSessionsUsage = AgentUsageService.aggregateSessionsUsage as jest.Mock;
const mockAggregateRuns = AgentUsageService.aggregateRuns as jest.Mock;

const canonicalFailure = {
  stage: 'connect_runtime',
  title: 'Session workspace pod failed to start',
  message: 'init-workspace: ImagePullBackOff',
  recordedAt: '2026-04-24T12:04:00.000Z',
  retryable: false,
  origin: 'agent_session',
};

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    uuid: 'session-1',
    status: 'active',
    userId: 'sample-user',
    ownerGithubUsername: 'sample-user',
    defaultThreadId: 9,
    defaultModel: 'gpt-5.4',
    defaultHarness: 'lifecycle_ai_sdk',
    buildUuid: 'build-1',
    buildKind: 'environment',
    sessionKind: 'environment',
    workspaceStatus: 'ready',
    lastActivity: '2026-04-24T12:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-04-24T12:00:00.000Z',
    updatedAt: '2026-04-24T12:05:00.000Z',
    workspaceRepos: [{ repo: 'example-org/example-repo', branch: 'main', mountPath: '/workspace/example-repo' }],
    selectedServices: [{ name: 'sample-service' }],
    ...overrides,
  };
}

function buildPagedSessionQuery(results: unknown[], total: number) {
  const query = {
    where: jest.fn(),
    whereIn: jest.fn(),
    orderBy: jest.fn(),
    page: jest.fn().mockResolvedValue({ results, total }),
  };
  query.where.mockReturnValue(query);
  query.whereIn.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return query;
}

function buildOrderedQuery<T>(rows: T[], orderCalls = 1) {
  const query = {
    whereIn: jest.fn(),
    where: jest.fn(),
    whereNull: jest.fn(),
    orderBy: jest.fn(),
  };
  query.whereIn.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.whereNull.mockReturnValue(query);
  for (let index = 0; index < orderCalls - 1; index += 1) {
    query.orderBy.mockReturnValueOnce(query);
  }
  query.orderBy.mockResolvedValueOnce(rows);
  return query;
}

function buildThreadSummaryRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 17,
    conversationCount: 1,
    lastActivityAt: '2026-04-24T12:02:00.000Z',
    ...overrides,
  };
}

function buildThreadSummaryQuery<T>(rows: T[]) {
  const query = {
    whereIn: jest.fn(),
    whereNull: jest.fn(),
    select: jest.fn(),
    groupBy: jest.fn(),
  };
  query.whereIn.mockReturnValue(query);
  query.whereNull.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.groupBy.mockResolvedValue(rows);
  return query;
}

function buildSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    uuid: 'source-1',
    sessionId: 17,
    adapter: 'lifecycle_environment',
    status: 'failed',
    input: {},
    sandboxRequirements: { filesystem: 'persistent' },
    error: { message: 'Source failed' },
    preparedAt: '2026-04-24T12:00:00.000Z',
    cleanedUpAt: null,
    createdAt: '2026-04-24T12:00:00.000Z',
    updatedAt: '2026-04-24T12:00:00.000Z',
    ...overrides,
  };
}

function buildSandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 4,
    uuid: 'sandbox-1',
    sessionId: 17,
    generation: 2,
    provider: 'lifecycle_kubernetes',
    status: 'failed',
    capabilitySnapshot: {},
    providerState: {
      namespace: 'sample-namespace',
      podName: 'sample-pod',
      pvcName: 'sample-pvc',
    },
    suspendedAt: null,
    endedAt: null,
    error: canonicalFailure,
    createdAt: '2026-04-24T12:04:00.000Z',
    updatedAt: '2026-04-24T12:04:00.000Z',
    ...overrides,
  };
}

function mockSingleSessionRelations(
  source: unknown | null,
  sandboxes: unknown[],
  activeDefaultThreads: unknown[] = [],
  threadSummaryRows: unknown[] = activeDefaultThreads.length ? [buildThreadSummaryRow()] : []
) {
  const defaultThread = (activeDefaultThreads as Array<{ id?: number }>).find((thread) => thread.id === 9) || {
    id: 9,
    uuid: 'thread-1',
    sessionId: 17,
  };

  mockSourceQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue(source === null ? [] : [source]) });
  mockSandboxQuery.mockReturnValueOnce(buildOrderedQuery(sandboxes, 2));
  mockThreadQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([defaultThread]) });
  mockThreadQuery.mockReturnValueOnce(buildOrderedQuery(activeDefaultThreads, 1));
  mockThreadQuery.mockReturnValueOnce(buildThreadSummaryQuery(threadSummaryRows));
  mockSandboxExposureQuery.mockReturnValueOnce(buildOrderedQuery([], 1));
}

describe('AgentSessionReadService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadKnexRaw.mockResolvedValue({ rows: [] });
    mockAggregateSessionsUsage.mockResolvedValue(
      new Map([
        [
          17,
          {
            usageSummary: { totalTokens: 0 },
            usageByModel: [],
            usageCompleteness: {
              runCount: 0,
              reportedRunCount: 0,
              missingUsageRunCount: 0,
              complete: true,
            },
          },
        ],
      ])
    );
  });

  it('lists owned sessions with capped pagination and batched related reads', async () => {
    const session = buildSession();
    const source = {
      id: 3,
      uuid: 'source-1',
      sessionId: 17,
      adapter: 'lifecycle_environment',
      status: 'ready',
      input: {
        defaults: {
          provider: 'sample-provider',
          model: 'gpt-5.4',
        },
      },
      sandboxRequirements: { filesystem: 'persistent' },
      error: null,
      preparedAt: '2026-04-24T12:00:00.000Z',
      cleanedUpAt: null,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const sandbox = {
      id: 4,
      uuid: 'sandbox-1',
      sessionId: 17,
      generation: 1,
      provider: 'lifecycle_kubernetes',
      status: 'ready',
      capabilitySnapshot: {},
      providerState: {
        namespace: 'sample-namespace',
        podName: 'sample-pod',
        pvcName: 'sample-pvc',
        workspaceStorage: {
          size: '10Gi',
          accessMode: 'ReadWriteOnce',
          pvcName: 'sample-pvc',
          storageClass: 'sample-storage-class',
        },
        selectedServices: [
          {
            name: 'sample-service',
            repositoryFullName: 'example-org/example-repo',
            branch: 'main',
            deployableName: 'sample-service',
            deployUuid: 'deploy-1',
            repo: 'example-org/internal-repo',
            secretValue: 'do-not-return',
          },
        ],
        internalToken: 'do-not-return',
      },
      suspendedAt: null,
      endedAt: null,
      error: null,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const exposure = {
      id: 5,
      uuid: 'exposure-1',
      sandboxId: 4,
      kind: 'editor',
      status: 'ready',
      targetPort: null,
      url: '/api/agent-session/workspace-editor/session-1/',
      metadata: {},
      lastVerifiedAt: '2026-04-24T12:00:00.000Z',
      endedAt: null,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const defaultThread = {
      id: 9,
      uuid: 'thread-1',
      sessionId: 17,
      title: 'Investigate sample-service',
      isDefault: true,
      archivedAt: null,
      lastRunAt: '2026-04-24T12:06:00.000Z',
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:06:00.000Z',
    };

    const sessionQuery = buildPagedSessionQuery([session], 101);
    const sourceQuery = { whereIn: jest.fn().mockResolvedValue([source]) };
    const sandboxQuery = buildOrderedQuery([sandbox], 2);
    const defaultThreadQuery = { whereIn: jest.fn().mockResolvedValue([defaultThread]) };
    const activeDefaultThreadQuery = buildOrderedQuery([defaultThread], 1);
    const threadSummaryQuery = buildThreadSummaryQuery([
      buildThreadSummaryRow({
        conversationCount: 1,
        lastActivityAt: '2026-04-24T12:06:00.000Z',
      }),
    ]);
    const exposureQuery = buildOrderedQuery([exposure], 1);
    mockSessionQuery.mockReturnValueOnce(sessionQuery);
    mockSourceQuery.mockReturnValueOnce(sourceQuery);
    mockSandboxQuery.mockReturnValueOnce(sandboxQuery);
    mockThreadQuery
      .mockReturnValueOnce(defaultThreadQuery)
      .mockReturnValueOnce(activeDefaultThreadQuery)
      .mockReturnValueOnce(threadSummaryQuery);
    mockSandboxExposureQuery.mockReturnValueOnce(exposureQuery);

    const result = await AgentSessionReadService.listOwnedSessionRecords('sample-user', {
      page: 2,
      limit: 1000,
    });

    expect(DEFAULT_AGENT_SESSION_LIST_LIMIT).toBe(25);
    expect(MAX_AGENT_SESSION_LIST_LIMIT).toBe(100);
    expect(sessionQuery.page).toHaveBeenCalledWith(1, MAX_AGENT_SESSION_LIST_LIMIT);
    expect(result.metadata.pagination).toEqual({
      current: 2,
      total: 2,
      items: 101,
      limit: 100,
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].session.defaults.provider).toBe('sample-provider');
    expect(result.records[0].session.defaultThreadId).toBe('thread-1');
    expect(result.records[0].session.title).toBe('Investigate sample-service');
    expect(result.records[0].session.archivedAt).toBeNull();
    expect(result.records[0].session).not.toHaveProperty('endedAt');
    expect(result.records[0].conversationSummary).toEqual({
      activeTitle: 'Investigate sample-service',
      conversationCount: 1,
      lastActivityAt: '2026-04-24T12:06:00.000Z',
    });
    expect(result.records[0].usage).toEqual({
      usageSummary: { totalTokens: 0 },
      usageByModel: [],
      usageCompleteness: {
        runCount: 0,
        reportedRunCount: 0,
        missingUsageRunCount: 0,
        complete: true,
      },
    });
    expect(result.records[0].source.id).toBe('source-1');
    expect(result.records[0].sandbox.exposures).toEqual([
      expect.objectContaining({
        id: 'exposure-1',
        kind: 'editor',
      }),
    ]);
    expect(result.records[0].sandbox.providerState).toEqual({
      namespace: 'sample-namespace',
      podName: 'sample-pod',
      pvcName: 'sample-pvc',
      workspaceStorage: {
        size: '10Gi',
        accessMode: 'ReadWriteOnce',
        pvcName: 'sample-pvc',
      },
      selectedServices: [
        {
          name: 'sample-service',
          repositoryFullName: 'example-org/example-repo',
          branch: 'main',
          deployableName: 'sample-service',
          deployUuid: 'deploy-1',
        },
      ],
    });
    expect(JSON.stringify(result.records[0].sandbox.providerState)).not.toContain('do-not-return');
    expect(JSON.stringify(result.records[0].sandbox.providerState)).not.toContain('sample-storage-class');
    expect(JSON.stringify(result.records[0].sandbox.providerState)).not.toContain('example-org/internal-repo');
    expect(sourceQuery.whereIn).toHaveBeenCalledWith('sessionId', [17]);
    expect(sandboxQuery.whereIn).toHaveBeenCalledWith('sessionId', [17]);
    expect(activeDefaultThreadQuery.whereIn).toHaveBeenCalledWith('sessionId', [17]);
    expect(activeDefaultThreadQuery.where).toHaveBeenCalledWith({ isDefault: true });
    expect(activeDefaultThreadQuery.whereNull).toHaveBeenCalledWith('archivedAt');
    expect(threadSummaryQuery.whereIn).toHaveBeenCalledWith('sessionId', [17]);
    expect(threadSummaryQuery.whereNull).toHaveBeenCalledWith('archivedAt');
    expect(threadSummaryQuery.select).toHaveBeenCalledWith('sessionId', expect.anything(), expect.anything());
    expect(threadSummaryQuery.groupBy).toHaveBeenCalledWith('sessionId');
    expect(exposureQuery.whereIn).toHaveBeenCalledWith('sandboxId', [4]);
    expect(mockAggregateSessionsUsage).toHaveBeenCalledTimes(1);
    expect(mockAggregateSessionsUsage).toHaveBeenCalledWith([17]);
  });

  it('summarizes multiple non-archived conversations from a batched thread read', async () => {
    const session = buildSession();
    const source = buildSource({ status: 'ready', error: null });
    const defaultThread = {
      id: 9,
      uuid: 'thread-1',
      sessionId: 17,
      title: 'Primary investigation',
      isDefault: true,
      archivedAt: null,
      lastRunAt: '2026-04-24T12:10:00.000Z',
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:09:00.000Z',
    };
    mockSingleSessionRelations(
      source,
      [],
      [defaultThread],
      [
        buildThreadSummaryRow({
          conversationCount: 2,
          lastActivityAt: '2026-04-24 12:20:00',
        }),
      ]
    );

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.conversationSummary).toEqual({
      activeTitle: 'Primary investigation',
      conversationCount: 2,
      lastActivityAt: '2026-04-24T12:20:00.000Z',
    });
  });

  it('uses newer session activity when it is later than conversation activity', async () => {
    const session = buildSession({
      lastActivity: '2026-04-24T12:30:00.000Z',
      updatedAt: '2026-04-24T12:25:00.000Z',
    });
    const source = buildSource({ status: 'ready', error: null });
    const defaultThread = {
      id: 9,
      uuid: 'thread-1',
      sessionId: 17,
      title: 'Primary investigation',
      isDefault: true,
      archivedAt: null,
      lastRunAt: '2026-04-24T12:10:00.000Z',
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:10:00.000Z',
    };
    mockSingleSessionRelations(
      source,
      [],
      [defaultThread],
      [
        buildThreadSummaryRow({
          conversationCount: 1,
          lastActivityAt: '2026-04-24T12:10:00.000Z',
        }),
      ]
    );

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.conversationSummary.lastActivityAt).toBe('2026-04-24T12:30:00.000Z');
  });

  it('returns null active title when the default conversation title is missing', async () => {
    const session = buildSession();
    const source = buildSource({ status: 'ready', error: null });
    const defaultThread = {
      id: 9,
      uuid: 'thread-1',
      sessionId: 17,
      title: null,
      isDefault: true,
      archivedAt: null,
      lastRunAt: null,
      createdAt: '2026-04-24T12:01:00.000Z',
      updatedAt: '2026-04-24T12:02:00.000Z',
    };
    mockSingleSessionRelations(source, [], [defaultThread]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.conversationSummary).toEqual({
      activeTitle: null,
      conversationCount: 1,
      lastActivityAt: '2026-04-24T12:05:00.000Z',
    });
  });

  it('returns null active title when the default conversation title is generic', async () => {
    const session = buildSession();
    const source = buildSource({ status: 'ready', error: null });
    const defaultThread = {
      id: 9,
      uuid: 'thread-1',
      sessionId: 17,
      title: 'Default thread',
      isDefault: true,
      archivedAt: null,
      lastRunAt: null,
      createdAt: '2026-04-24T12:01:00.000Z',
      updatedAt: '2026-04-24T12:02:00.000Z',
    };
    mockSingleSessionRelations(source, [], [defaultThread]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.conversationSummary).toEqual({
      activeTitle: null,
      conversationCount: 1,
      lastActivityAt: '2026-04-24T12:05:00.000Z',
    });
  });

  it('serializes archived sessions with the archived status and archive timestamp', async () => {
    const session = buildSession({
      status: 'archived',
      workspaceStatus: 'none',
      archivedAt: '2026-04-24T13:00:00.000Z',
    });
    const source = buildSource({ status: 'cleaned_up', error: null, cleanedUpAt: '2026-04-24T13:00:00.000Z' });
    mockSingleSessionRelations(source, []);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.status).toBe('archived');
    expect(record.session.archivedAt).toBe('2026-04-24T13:00:00.000Z');
    expect(record.session).not.toHaveProperty('endedAt');
  });

  it('derives the session title from the first user message when no thread is titled', async () => {
    const session = buildSession();
    const source = buildSource({ status: 'ready', error: null });
    mockThreadKnexRaw.mockResolvedValue({
      rows: [
        {
          sessionId: 17,
          parts: [
            { type: 'reasoning', text: 'ignored' },
            { type: 'text', text: '  Fix the login bug\nin the auth service  ' },
          ],
        },
      ],
    });
    mockSingleSessionRelations(source, []);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.title).toBe('Fix the login bug in the auth service');
  });

  it('truncates long first-user-message titles to 80 characters with an ellipsis', async () => {
    const session = buildSession();
    const source = buildSource({ status: 'ready', error: null });
    mockThreadKnexRaw.mockResolvedValue({
      rows: [{ sessionId: 17, parts: [{ type: 'text', text: 'a'.repeat(200) }] }],
    });
    mockSingleSessionRelations(source, []);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.title).toHaveLength(80);
    expect(record.session.title!.endsWith('…')).toBe(true);
  });

  it('falls back to session activity when no conversations exist', async () => {
    const session = buildSession({
      defaultThreadId: null,
      lastActivity: '2026-04-24T12:03:00.000Z',
      updatedAt: '2026-04-24T12:02:00.000Z',
      createdAt: '2026-04-24T12:01:00.000Z',
    });
    const source = buildSource({ status: 'ready', error: null });
    const activeDefaultThreadQuery = buildOrderedQuery([], 1);
    const threadSummaryQuery = buildThreadSummaryQuery([]);

    mockSourceQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([source]) });
    mockSandboxQuery.mockReturnValueOnce(buildOrderedQuery([], 2));
    mockThreadQuery.mockReturnValueOnce(activeDefaultThreadQuery).mockReturnValueOnce(threadSummaryQuery);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.defaultThreadId).toBeNull();
    expect(record.conversationSummary).toEqual({
      activeTitle: null,
      conversationCount: 0,
      lastActivityAt: '2026-04-24T12:03:00.000Z',
    });
    expect(activeDefaultThreadQuery.whereNull).toHaveBeenCalledWith('archivedAt');
    expect(threadSummaryQuery.whereNull).toHaveBeenCalledWith('archivedAt');
  });

  it('keeps chat sessions ready when an on-demand workspace sandbox failed', async () => {
    const session = buildSession({
      sessionKind: 'chat',
      workspaceStatus: 'failed',
    });
    const source = {
      id: 3,
      uuid: 'source-1',
      sessionId: 17,
      adapter: 'blank_workspace',
      status: 'ready',
      input: {
        defaults: {
          provider: 'sample-provider',
          model: 'gpt-5.4',
        },
        sessionKind: 'chat',
      },
      sandboxRequirements: { filesystem: 'persistent' },
      error: null,
      preparedAt: '2026-04-24T12:00:00.000Z',
      cleanedUpAt: null,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const sandbox = {
      id: 4,
      uuid: 'sandbox-1',
      sessionId: 17,
      generation: 1,
      provider: 'lifecycle_kubernetes',
      status: 'failed',
      capabilitySnapshot: {},
      providerState: {
        namespace: 'chat-sample',
        podName: 'agent-sample',
        pvcName: 'agent-pvc-sample',
      },
      suspendedAt: null,
      endedAt: null,
      error: { message: 'Sandbox failed' },
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const defaultThread = { id: 9, uuid: 'thread-1', sessionId: 17 };

    mockSourceQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([source]) });
    mockSandboxQuery.mockReturnValueOnce(buildOrderedQuery([sandbox], 2));
    mockThreadQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([defaultThread]) });
    mockThreadQuery.mockReturnValueOnce(buildOrderedQuery([], 1));
    mockThreadQuery.mockReturnValueOnce(buildThreadSummaryQuery([]));
    mockSandboxExposureQuery.mockReturnValueOnce(buildOrderedQuery([], 1));

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.status).toBe('ready');
    expect(record.sandbox.status).toBe('failed');
    expect(record.sandbox.providerState).toEqual({
      namespace: 'chat-sample',
      podName: 'agent-sample',
      pvcName: 'agent-pvc-sample',
    });
    expect(record.sandbox.error).toEqual(
      expect.objectContaining({
        stage: 'connect_runtime',
        title: 'Workspace could not be opened',
        retryable: false,
        origin: 'legacy',
      })
    );
  });

  it('serializes canonical sandbox errors without Redis startup failure state', async () => {
    const session = buildSession({
      workspaceStatus: 'failed',
    });
    const source = {
      id: 3,
      uuid: 'source-1',
      sessionId: 17,
      adapter: 'lifecycle_environment',
      status: 'ready',
      input: {},
      sandboxRequirements: { filesystem: 'persistent' },
      error: null,
      preparedAt: '2026-04-24T12:00:00.000Z',
      cleanedUpAt: null,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const sandbox = {
      id: 4,
      uuid: 'sandbox-1',
      sessionId: 17,
      generation: 1,
      provider: 'lifecycle_kubernetes',
      status: 'failed',
      capabilitySnapshot: {},
      providerState: {},
      suspendedAt: null,
      endedAt: null,
      error: canonicalFailure,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const defaultThread = { id: 9, uuid: 'thread-1', sessionId: 17 };

    mockSourceQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([source]) });
    mockSandboxQuery.mockReturnValueOnce(buildOrderedQuery([sandbox], 2));
    mockThreadQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([defaultThread]) });
    mockThreadQuery.mockReturnValueOnce(buildOrderedQuery([], 1));
    mockThreadQuery.mockReturnValueOnce(buildThreadSummaryQuery([]));
    mockSandboxExposureQuery.mockReturnValueOnce(buildOrderedQuery([], 1));

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.status).toBe('error');
    expect(record.sandbox.status).toBe('failed');
    expect(record.sandbox.error).toEqual(canonicalFailure);
  });

  it('serializes failed environment summaries from the latest durable sandbox failure', async () => {
    const failure = {
      ...canonicalFailure,
      origin: 'agent_session',
    };
    const session = buildSession({
      status: 'error',
      chatStatus: AgentChatStatus.ERROR,
      sessionKind: AgentSessionKind.ENVIRONMENT,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    const source = buildSource();
    const sandbox = buildSandbox({ error: failure });
    const olderSandbox = buildSandbox({
      id: 2,
      uuid: 'sandbox-older',
      generation: 1,
      status: 'ready',
      error: null,
    });
    mockSingleSessionRelations(source, [sandbox, olderSandbox]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.status).toBe('error');
    expect(record.session.archivedAt).toBeNull();
    expect(record.source.status).toBe('failed');
    expect(record.sandbox.status).toBe('failed');
    expect(record.sandbox.providerState).toEqual({
      namespace: 'sample-namespace',
      podName: 'sample-pod',
      pvcName: 'sample-pvc',
    });
    expect(record.sandbox.error).toEqual(failure);
  });

  it('serializes failed sandbox summaries with the same durable failure shape', async () => {
    const failure = {
      ...canonicalFailure,
      origin: 'sandbox_launch',
    };
    const session = buildSession({
      status: 'error',
      chatStatus: AgentChatStatus.ERROR,
      sessionKind: AgentSessionKind.SANDBOX,
      buildKind: 'sandbox',
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    const source = buildSource({
      adapter: 'lifecycle_fork',
    });
    const sandbox = buildSandbox({ error: failure });
    mockSingleSessionRelations(source, [sandbox]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.status).toBe('error');
    expect(record.session.archivedAt).toBeNull();
    expect(record.source.adapter).toBe('lifecycle_fork');
    expect(record.source.status).toBe('failed');
    expect(record.sandbox.status).toBe('failed');
    expect(record.sandbox.error).toEqual(failure);
    expect(record.sandbox.error).toEqual(
      expect.objectContaining({
        stage: 'connect_runtime',
        title: 'Session workspace pod failed to start',
        message: 'init-workspace: ImagePullBackOff',
        retryable: false,
        origin: 'sandbox_launch',
      })
    );
  });

  it('serializes classified durable failures with safe provider-state breadcrumbs only', async () => {
    const failure = {
      stage: 'attach_services',
      title: 'Attached services failed to start',
      message: 'service attach failed',
      recordedAt: '2026-04-24T12:04:00.000Z',
      retryable: false,
      origin: 'agent_session',
    };
    const session = buildSession({
      status: 'error',
      chatStatus: AgentChatStatus.ERROR,
      sessionKind: AgentSessionKind.ENVIRONMENT,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    const source = buildSource();
    const sandbox = buildSandbox({
      error: failure,
      providerState: {
        namespace: 'sample-namespace',
        podName: 'sample-pod',
        pvcName: 'sample-pvc',
        selectedServices: [
          {
            name: 'sample-service',
            repo: 'example-org/example-repo',
            branch: 'feature/sample-change',
          },
        ],
        workspaceStorage: {
          pvcName: 'sample-pvc',
          storageClass: 'sample-storage-class',
        },
        rawProviderOutput: 'do-not-return',
      },
    });
    mockSingleSessionRelations(source, [sandbox]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.source.status).toBe('failed');
    expect(record.sandbox.status).toBe('failed');
    expect(record.sandbox.error).toEqual(failure);
    expect(record.sandbox.error).toEqual(
      expect.objectContaining({
        stage: 'attach_services',
        title: 'Attached services failed to start',
        message: 'service attach failed',
        retryable: false,
        origin: 'agent_session',
      })
    );
    expect(record.sandbox.providerState).toEqual({
      namespace: 'sample-namespace',
      podName: 'sample-pod',
      pvcName: 'sample-pvc',
      selectedServices: [
        {
          name: 'sample-service',
          branch: 'feature/sample-change',
        },
      ],
      workspaceStorage: {
        pvcName: 'sample-pvc',
      },
    });
    expect(JSON.stringify(record.sandbox.providerState)).not.toContain('do-not-return');
    expect(JSON.stringify(record.sandbox.providerState)).not.toContain('sample-storage-class');
    expect(JSON.stringify(record.sandbox.providerState)).not.toContain('example-org/example-repo');
  });

  it('marks non-chat failed workspaces unavailable', async () => {
    const session = buildSession({
      sessionKind: 'environment',
      workspaceStatus: 'failed',
    });
    const source = {
      id: 3,
      uuid: 'source-1',
      sessionId: 17,
      adapter: 'lifecycle_environment',
      status: 'ready',
      input: {},
      sandboxRequirements: { filesystem: 'persistent' },
      error: null,
      preparedAt: '2026-04-24T12:00:00.000Z',
      cleanedUpAt: null,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const defaultThread = { id: 9, uuid: 'thread-1', sessionId: 17 };

    mockSourceQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([source]) });
    mockSandboxQuery.mockReturnValueOnce(buildOrderedQuery([], 2));
    mockThreadQuery.mockReturnValueOnce({ whereIn: jest.fn().mockResolvedValue([defaultThread]) });
    mockThreadQuery.mockReturnValueOnce(buildOrderedQuery([], 1));
    mockThreadQuery.mockReturnValueOnce(buildThreadSummaryQuery([]));

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.status).toBe('error');
    expect(record.sandbox.status).toBe('failed');
    expect(record.sandbox.providerState).toEqual({});
    expect(record.sandbox.error).toEqual(
      expect.objectContaining({
        stage: 'connect_runtime',
        title: 'Workspace could not be opened',
        retryable: false,
        origin: 'legacy',
      })
    );
  });

  it('returns an empty list without issuing relation queries', async () => {
    await expect(AgentSessionReadService.listSessionRecords([])).resolves.toEqual([]);

    expect(mockSourceQuery).not.toHaveBeenCalled();
    expect(mockSandboxQuery).not.toHaveBeenCalled();
    expect(mockThreadQuery).not.toHaveBeenCalled();
    expect(mockAggregateSessionsUsage).not.toHaveBeenCalled();
  });

  it('returns null for an unowned session and delegates an owned session to serialization', async () => {
    const findOne = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(buildSession());
    mockSessionQuery.mockReturnValue({ findOne });
    const serialize = jest.spyOn(AgentSessionReadService, 'serializeSessionRecord').mockResolvedValue({ id: 'record' });

    await expect(AgentSessionReadService.getOwnedSessionRecord('missing', 'sample-user')).resolves.toBeNull();
    await expect(AgentSessionReadService.getOwnedSessionRecord('session-1', 'sample-user')).resolves.toEqual({
      id: 'record',
    });

    expect(findOne).toHaveBeenNthCalledWith(1, { uuid: 'missing', userId: 'sample-user' });
    expect(findOne).toHaveBeenNthCalledWith(2, { uuid: 'session-1', userId: 'sample-user' });
    expect(serialize).toHaveBeenCalledTimes(1);
    serialize.mockRestore();
  });

  it('serializes one session by delegating to the batched relation loader', async () => {
    const session = buildSession();
    const list = jest.spyOn(AgentSessionReadService, 'listSessionRecords').mockResolvedValue([{ id: 'record' }] as any);

    await expect(AgentSessionReadService.serializeSessionRecord(session as any)).resolves.toEqual({ id: 'record' });
    expect(list).toHaveBeenCalledWith([session]);

    list.mockRestore();
  });

  it('rejects a session whose required source relation is missing', async () => {
    const session = buildSession();
    mockSingleSessionRelations(null, [buildSandbox()]);

    await expect(AgentSessionReadService.listSessionRecords([session] as any)).rejects.toThrow(
      'Agent session source missing for session session-1'
    );
  });

  it('serializes malformed sandbox provider state as an empty public object', async () => {
    const session = buildSession();
    mockSingleSessionRelations(buildSource(), [
      buildSandbox({ status: 'ready', error: null, providerState: 'invalid' }),
    ]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.sandbox.providerState).toEqual({});
    expect(record.sandbox.error).toBeNull();
  });

  it('normalizes Date activity, ignores an invalid Date, and clamps a non-finite conversation count', async () => {
    const session = buildSession({ lastActivity: new Date('2026-04-24T12:10:00.000Z') });
    const defaultThread = { id: 9, uuid: 'thread-1', sessionId: 17, title: 'Useful title' };
    mockSingleSessionRelations(
      buildSource(),
      [],
      [defaultThread],
      [buildThreadSummaryRow({ conversationCount: 'not-a-number', lastActivityAt: new Date(Number.NaN) })]
    );

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.conversationSummary).toEqual({
      activeTitle: 'Useful title',
      conversationCount: 0,
      lastActivityAt: '2026-04-24T12:10:00.000Z',
    });
  });

  it('ignores blank timestamps and message parts that cannot produce a title', async () => {
    const session = buildSession({ lastActivity: '   ', updatedAt: null, createdAt: null });
    mockThreadKnexRaw.mockResolvedValueOnce({
      rows: [
        {
          sessionId: 17,
          parts: [{ type: 'image', image: 'ignored' }, { type: 'text', text: '   ' }, null],
        },
      ],
    });
    mockSingleSessionRelations(buildSource(), []);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.title).toBeNull();
    expect(record.conversationSummary.lastActivityAt).toBeNull();
  });

  it('adds the owning session id to serialized thread output', async () => {
    (AgentThreadService.serializeThread as jest.Mock).mockReturnValue({ id: 'thread-1', title: 'Work' });

    await expect(
      AgentSessionReadService.serializeThread({ uuid: 'thread-1' } as any, buildSession() as any)
    ).resolves.toEqual({
      id: 'thread-1',
      title: 'Work',
      session: { id: 'session-1' },
    });
    expect(AgentThreadService.serializeThread).toHaveBeenCalledWith({ uuid: 'thread-1' }, 'session-1');
  });

  it('defaults invalid pagination and includes archived rows only when explicitly requested', async () => {
    const sessionQuery = buildPagedSessionQuery([], 0);
    mockSessionQuery.mockReturnValueOnce(sessionQuery);
    const list = jest.spyOn(AgentSessionReadService, 'listSessionRecords').mockResolvedValue([]);

    const result = await AgentSessionReadService.listOwnedSessionRecords('sample-user', {
      page: Number.NaN,
      limit: -2,
      includeArchived: true,
    });

    expect(sessionQuery.where).toHaveBeenCalledWith({ userId: 'sample-user' });
    expect(sessionQuery.whereIn).not.toHaveBeenCalled();
    expect(sessionQuery.page).toHaveBeenCalledWith(0, DEFAULT_AGENT_SESSION_LIST_LIMIT);
    expect(result).toEqual({
      records: [],
      metadata: {
        pagination: {
          current: 1,
          total: 1,
          items: 0,
          limit: DEFAULT_AGENT_SESSION_LIST_LIMIT,
        },
      },
    });
    list.mockRestore();
  });

  it('projects only safe nonblank provider fields and uses empty-session relation fallbacks', async () => {
    const session = buildSession({ workspaceRepos: [], selectedServices: [] });
    const source = buildSource({
      status: 'ready',
      error: null,
      input: {
        defaults: { provider: '   ' },
        repo: 'stale/repository',
        branch: 'stale-branch',
      },
    });
    const sandbox = buildSandbox({
      status: 'ready',
      error: null,
      providerState: {
        namespace: '  projected-namespace  ',
        podName: '   ',
        pvcName: '',
        workspaceStorage: {
          size: ' ',
          accessMode: ' ReadWriteMany ',
          pvcName: '',
        },
        selectedServices: [
          {
            name: ' ',
            repositoryFullName: ' Example/API ',
            branch: '',
            deployableName: ' api ',
            deployUuid: ' ',
          },
          { name: ' ', repositoryFullName: ' ' },
        ],
      },
    });
    mockAggregateSessionsUsage.mockResolvedValueOnce(new Map());
    mockSingleSessionRelations(source, [sandbox]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.session.defaults.provider).toBeNull();
    expect(record.source.input).toEqual(
      expect.objectContaining({
        repo: null,
        branch: null,
        primaryRepo: null,
        primaryBranch: null,
        workspaceRepos: [],
        selectedServices: [],
        services: [],
      })
    );
    expect(record.sandbox.providerState).toEqual({
      namespace: 'projected-namespace',
      workspaceStorage: { accessMode: 'ReadWriteMany' },
      selectedServices: [{ repositoryFullName: 'Example/API', deployableName: 'api' }],
    });
    expect(record.sandbox.error).toBeNull();
    expect(record.usage).toEqual({
      usageSummary: { totalTokens: 0 },
      usageByModel: [],
      usageCompleteness: {
        runCount: 0,
        reportedRunCount: 0,
        missingUsageRunCount: 0,
        complete: true,
      },
    });
    expect(mockAggregateRuns).toHaveBeenCalledWith([]);
  });

  it('selects the explicitly primary repository and omits empty nested provider state', async () => {
    const session = buildSession({
      workspaceRepos: [
        { repo: 'example-org/secondary', branch: 'secondary-branch', primary: false },
        { repo: 'example-org/primary', branch: 'primary-branch', primary: true },
      ],
    });
    const sandbox = buildSandbox({
      status: 'ready',
      error: null,
      providerState: {
        namespace: 'sample-namespace',
        workspaceStorage: { size: ' ', accessMode: '', pvcName: '   ' },
        selectedServices: [{ name: ' ', repositoryFullName: '', branch: '   ' }],
      },
    });
    mockSingleSessionRelations(buildSource({ status: 'ready', error: null }), [sandbox]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.source.input).toEqual(
      expect.objectContaining({
        repo: 'example-org/primary',
        branch: 'primary-branch',
        primaryRepo: 'example-org/primary',
        primaryBranch: 'primary-branch',
      })
    );
    expect(record.sandbox.providerState).toEqual({ namespace: 'sample-namespace' });
  });

  it('projects the configured retention deadline for a suspended disposable workspace', async () => {
    const session = buildSession({
      keepWorkspace: false,
      updatedAt: '2026-04-24T12:05:00.000Z',
    });
    const sandbox = buildSandbox({ status: 'suspended', error: null });
    mockSingleSessionRelations(buildSource({ status: 'ready', error: null }), [sandbox]);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.sandbox.status).toBe('suspended');
    expect(record.sandbox.retainedUntil).toBe('2026-04-25T12:05:00.000Z');
    expect(record.sandbox.error).toBeNull();
  });

  it('omits a nonblank but unparseable activity timestamp', async () => {
    const session = buildSession({ lastActivity: 'not-a-date', updatedAt: null, createdAt: null });
    mockSingleSessionRelations(buildSource(), []);

    const [record] = await AgentSessionReadService.listSessionRecords([session] as any);

    expect(record.conversationSummary.lastActivityAt).toBeNull();
  });
});
