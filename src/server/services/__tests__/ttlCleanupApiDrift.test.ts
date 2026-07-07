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

const mockListNamespace = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockGetPullRequestLabels = jest.fn();
const mockEnqueueBuildDeletion = jest.fn();
const mockBuildQuery = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: jest.fn(),
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(() => ({
      listNamespace: (...args: any[]) => mockListNamespace(...args),
    })),
  })),
}));
jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn() },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));
jest.mock('server/lib/github', () => ({
  getPullRequestLabels: (...args: any[]) => mockGetPullRequestLabels(...args),
  updatePullRequestLabels: jest.fn(),
  createOrUpdatePullRequestComment: jest.fn(),
}));
jest.mock('server/lib/utils', () => ({
  getKeepLabel: jest.fn(() => Promise.resolve('sample-keep')),
  getDisabledLabel: jest.fn(() => Promise.resolve('sample-disabled')),
  getDeployLabel: jest.fn(() => Promise.resolve('sample-deploy')),
  parsePullRequestLabels: () => [],
}));
jest.mock('server/lib/metrics', () => jest.fn().mockImplementation(() => ({ increment: jest.fn() })));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(() => ({ getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args) })) },
}));

import TTLCleanupService from '../ttlCleanup';

const expiredTimestamp = String(Date.now() - 60 * 60 * 1000);

const service = () =>
  new TTLCleanupService(
    {
      models: { Build: { query: mockBuildQuery } },
      services: {
        BuildService: {
          enqueueBuildDeletion: (...args: any[]) => mockEnqueueBuildDeletion(...args),
          deleteQueue: { add: jest.fn() },
        },
      },
    } as any,
    {} as any,
    {} as any,
    { registerQueue: jest.fn(() => ({ add: jest.fn() })) } as any
  );

const expiredNamespace = (uuid: string) => ({
  body: {
    items: [
      {
        metadata: {
          name: `env-${uuid}`,
          labels: {
            'lfc/ttl-enable': 'true',
            'lfc/ttl-expireAtUnix': expiredTimestamp,
            'lfc/uuid': uuid,
          },
        },
      },
    ],
  },
});

const buildLookup = (build: any) => {
  mockBuildQuery.mockReturnValue({
    findOne: jest.fn().mockReturnThis(),
    withGraphFetched: jest.fn().mockResolvedValue(build),
  });
};

const runCleanup = () =>
  service().processTTLCleanupQueue({ data: {} } as any);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllConfigs.mockResolvedValue({
    ttl_cleanup: { enabled: true, inactivityDays: 14, dryRun: false, excludedRepositories: [] },
    labels: {},
  });
});

describe('TTL scanner drift repair for API environments (5A)', () => {
  it('enqueues deletion for a labeled PR-less API build that has no lease', async () => {
    mockListNamespace.mockResolvedValue(expiredNamespace('drifty-env-123456'));
    const build = {
      id: 3,
      uuid: 'drifty-env-123456',
      status: 'deployed',
      isStatic: false,
      triggerType: 'api',
      expiresAt: null,
      pullRequest: null,
    };
    buildLookup(build);

    await runCleanup();

    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(build, 'ttl_namespace_drift');
  });

  it('leaves leased API environments to the expiry sweep', async () => {
    mockListNamespace.mockResolvedValue(expiredNamespace('leased-env-123456'));
    buildLookup({
      id: 4,
      uuid: 'leased-env-123456',
      status: 'deployed',
      isStatic: false,
      triggerType: 'api',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      pullRequest: null,
    });

    await runCleanup();

    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
  });

  it('keeps skipping PR-less non-API builds (legacy behavior)', async () => {
    mockListNamespace.mockResolvedValue(expiredNamespace('legacy-env-123456'));
    buildLookup({
      id: 5,
      uuid: 'legacy-env-123456',
      status: 'deployed',
      isStatic: false,
      triggerType: 'github_pr',
      expiresAt: null,
      pullRequest: null,
    });

    await runCleanup();

    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
  });
});
