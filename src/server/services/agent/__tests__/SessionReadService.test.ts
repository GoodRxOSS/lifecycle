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

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
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

jest.mock('server/lib/dependencies', () => ({}));

import AgentSession from 'server/models/AgentSession';
import AgentSource from 'server/models/AgentSource';
import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentThread from 'server/models/AgentThread';
import AgentSessionReadService from '../SessionReadService';

const mockSessionQuery = AgentSession.query as jest.Mock;
const mockSourceQuery = AgentSource.query as jest.Mock;
const mockSandboxQuery = AgentSandbox.query as jest.Mock;
const mockSandboxExposureQuery = AgentSandboxExposure.query as jest.Mock;
const mockThreadQuery = AgentThread.query as jest.Mock;

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
    endedAt: null,
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

describe('AgentSessionReadService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists owned sessions with capped pagination and batched related reads', async () => {
    const session = buildSession();
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
      status: 'ready',
      capabilitySnapshot: {},
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
    const defaultThread = { id: 9, uuid: 'thread-1', sessionId: 17 };

    const sessionQuery = buildPagedSessionQuery([session], 101);
    const sourceQuery = { whereIn: jest.fn().mockResolvedValue([source]) };
    const sandboxQuery = buildOrderedQuery([sandbox], 2);
    const defaultThreadQuery = { whereIn: jest.fn().mockResolvedValue([defaultThread]) };
    const fallbackThreadQuery = buildOrderedQuery([], 1);
    const exposureQuery = buildOrderedQuery([exposure], 1);
    mockSessionQuery.mockReturnValueOnce(sessionQuery);
    mockSourceQuery.mockReturnValueOnce(sourceQuery);
    mockSandboxQuery.mockReturnValueOnce(sandboxQuery);
    mockThreadQuery.mockReturnValueOnce(defaultThreadQuery).mockReturnValueOnce(fallbackThreadQuery);
    mockSandboxExposureQuery.mockReturnValueOnce(exposureQuery);

    const result = await AgentSessionReadService.listOwnedSessionRecords('sample-user', {
      page: 2,
      limit: 1000,
    });

    expect(sessionQuery.page).toHaveBeenCalledWith(1, 100);
    expect(result.metadata.pagination).toEqual({
      current: 2,
      total: 2,
      items: 101,
      limit: 100,
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].session.defaultThreadId).toBe('thread-1');
    expect(result.records[0].source.id).toBe('source-1');
    expect(result.records[0].sandbox.exposures).toEqual([
      expect.objectContaining({
        id: 'exposure-1',
        kind: 'editor',
      }),
    ]);
    expect(sourceQuery.whereIn).toHaveBeenCalledWith('sessionId', [17]);
    expect(sandboxQuery.whereIn).toHaveBeenCalledWith('sessionId', [17]);
    expect(exposureQuery.whereIn).toHaveBeenCalledWith('sandboxId', [4]);
  });
});
