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

const mockEnrichSessions = jest.fn();
const mockSessionQuery = jest.fn();
const mockThreadQuery = jest.fn();
const mockPendingActionQuery = jest.fn();

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    enrichSessions: (...args: unknown[]) => mockEnrichSessions(...args),
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockSessionQuery(...args),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockThreadQuery(...args),
  },
}));

jest.mock('server/models/AgentPendingAction', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockPendingActionQuery(...args),
  },
}));

import AgentAdminService from '../AdminService';

describe('AgentAdminService.listSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses internal numeric session ids for thread and approval queries while returning public uuids', async () => {
    const rawSessions = [
      {
        id: 101,
        uuid: 'eda50b6f-f421-42c4-8d7e-7b38d1c7c362',
        buildUuid: 'sample-build-1',
        buildKind: 'environment',
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        podName: 'agent-eda50b6f',
        namespace: 'env-sample',
        pvcName: 'sample-pvc',
        model: 'claude-sonnet-4-5',
        status: 'active',
        selectedServices: [],
        workspaceRepos: [],
        devModeSnapshots: {},
      },
      {
        id: 202,
        uuid: '3e81553b-b8d4-4d2b-88d0-8d5775bcffde',
        buildUuid: 'sample-build-2',
        buildKind: 'environment',
        userId: 'sample-user-2',
        ownerGithubUsername: 'sample-user-2',
        podName: 'agent-3e81553b',
        namespace: 'env-sample',
        pvcName: 'sample-pvc-2',
        model: 'claude-sonnet-4-5',
        status: 'starting',
        selectedServices: [],
        workspaceRepos: [],
        devModeSnapshots: {},
      },
    ];

    const sessionQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest
        .fn()
        .mockImplementationOnce(() => sessionQueryBuilder)
        .mockImplementationOnce(() => Promise.resolve(rawSessions)),
    };
    mockSessionQuery.mockReturnValue(sessionQueryBuilder);

    mockEnrichSessions.mockResolvedValue([
      {
        ...rawSessions[0],
        id: rawSessions[0].uuid,
        repo: 'example-org/example-repo',
        primaryRepo: 'example-org/example-repo',
        services: [],
      },
      {
        ...rawSessions[1],
        id: rawSessions[1].uuid,
        repo: 'example-org/example-repo',
        primaryRepo: 'example-org/example-repo',
        services: [],
      },
    ]);

    const threadWhereIn = jest.fn().mockReturnThis();
    const threadSelect = jest.fn().mockResolvedValue([
      { sessionId: 101, lastRunAt: '2026-04-05T18:00:00.000Z' },
      { sessionId: 202, lastRunAt: '2026-04-05T19:00:00.000Z' },
    ]);
    mockThreadQuery.mockReturnValue({
      whereIn: threadWhereIn,
      select: threadSelect,
    });

    const pendingWhereIn = jest.fn().mockReturnThis();
    const pendingWhere = jest.fn().mockReturnThis();
    const pendingSelect = jest.fn().mockResolvedValue([{ sessionId: 202 }]);
    mockPendingActionQuery.mockReturnValue({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereIn: pendingWhereIn,
      where: pendingWhere,
      select: pendingSelect,
    });

    const result = await AgentAdminService.listSessions({});

    expect(threadWhereIn).toHaveBeenCalledWith('sessionId', [101, 202]);
    expect(pendingWhereIn).toHaveBeenCalledWith('thread.sessionId', [101, 202]);
    expect(result.data).toEqual([
      expect.objectContaining({
        id: 'eda50b6f-f421-42c4-8d7e-7b38d1c7c362',
        threadCount: 1,
        pendingActionsCount: 0,
        lastRunAt: '2026-04-05T18:00:00.000Z',
      }),
      expect.objectContaining({
        id: '3e81553b-b8d4-4d2b-88d0-8d5775bcffde',
        threadCount: 1,
        pendingActionsCount: 1,
        lastRunAt: '2026-04-05T19:00:00.000Z',
      }),
    ]);
  });
});
