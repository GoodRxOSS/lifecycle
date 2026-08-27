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
const mockUpdatePullRequestLabels = jest.fn();
const mockCreateOrUpdatePullRequestComment = jest.fn();
const mockEnqueueBuildDeletion = jest.fn();
const mockBuildQuery = jest.fn();
const mockMetricsIncrement = jest.fn();
const mockQueueAdd = jest.fn();

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
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));

jest.mock('server/lib/github', () => ({
  getPullRequestLabels: (...args: any[]) => mockGetPullRequestLabels(...args),
  updatePullRequestLabels: (...args: any[]) => mockUpdatePullRequestLabels(...args),
  createOrUpdatePullRequestComment: (...args: any[]) => mockCreateOrUpdatePullRequestComment(...args),
}));

jest.mock('server/lib/utils', () => ({
  getKeepLabel: jest.fn(() => Promise.resolve('sample-keep')),
  getDisabledLabel: jest.fn(() => Promise.resolve('sample-disabled')),
  getDeployLabel: jest.fn(() => Promise.resolve('sample-deploy')),
  parsePullRequestLabels: (labels?: string[] | string | null): string[] => {
    if (!labels) return [];
    if (Array.isArray(labels)) return labels;

    try {
      const parsed = JSON.parse(labels);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
}));

jest.mock('server/lib/metrics', () =>
  jest.fn().mockImplementation(() => ({
    increment: mockMetricsIncrement,
  }))
);

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
    })),
  },
}));

import TTLCleanupService from '../ttlCleanup';

describe('TTLCleanupService', () => {
  const expiredTimestamp = String(Date.now() - 60 * 60 * 1000);

  const buildService = () =>
    new TTLCleanupService(
      {
        models: {
          Build: {
            query: mockBuildQuery,
          },
        },
        services: {
          BuildService: {
            enqueueBuildDeletion: (...args: any[]) => mockEnqueueBuildDeletion(...args),
          },
        },
      } as any,
      {} as any,
      {} as any,
      {
        registerQueue: jest.fn(() => ({
          add: (...args: any[]) => mockQueueAdd(...args),
        })),
      } as any
    );

  const mockNamespaces = (items: any[]) => {
    mockListNamespace.mockResolvedValue({
      body: {
        items,
      },
    });
  };

  const mockExpiredNamespace = (name = 'env-sample-123456') => {
    mockListNamespace.mockResolvedValue({
      body: {
        items: [
          {
            metadata: {
              name,
              labels: {
                'lfc/ttl-enable': 'true',
                'lfc/ttl-expireAtUnix': expiredTimestamp,
                'lfc/uuid': name.replace('env-', ''),
              },
            },
          },
        ],
      },
    });
  };

  const mockBuildLookup = (build: any) => {
    const query = {
      findOne: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue(build),
    };
    mockBuildQuery.mockReturnValue(query);
    return query;
  };

  const buildQuery = (build: any) => ({
    findOne: jest.fn().mockReturnThis(),
    withGraphFetched: jest.fn().mockResolvedValue(build),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConfigs.mockResolvedValue({
      ttl_cleanup: {
        enabled: true,
        dryRun: false,
        inactivityDays: 7,
        checkIntervalMinutes: 60,
      },
    });
  });

  it('enqueues existing delete queue cleanup for expired namespaces tied to closed pull requests', async () => {
    mockExpiredNamespace();
    const build = {
      id: 123,
      uuid: 'sample-123456',
      status: 'error',
      isStatic: false,
      pullRequest: {
        status: 'closed',
        pullRequestNumber: 42,
        fullName: 'ExampleOrg/sample-service',
        labels: [],
        repository: {
          githubInstallationId: 1001,
        },
      },
    };
    mockBuildLookup(build);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(build, 'ttl_closed_pull_request');
    expect(mockGetPullRequestLabels).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  it('keeps the label and comment flow for expired namespaces tied to open pull requests', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    mockExpiredNamespace('env-open-sample-654321');
    mockBuildLookup({
      id: 456,
      uuid: 'open-sample-654321',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 77,
        fullName: 'ExampleOrg/open-service',
        labels: JSON.stringify(['sample-deploy']),
        repository: {
          githubInstallationId: 2002,
        },
        $query: jest.fn(() => ({
          patch,
        })),
      },
    });
    mockGetPullRequestLabels.mockResolvedValue(['sample-deploy']);
    mockUpdatePullRequestLabels.mockResolvedValue(undefined);
    mockCreateOrUpdatePullRequestComment.mockResolvedValue(undefined);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).toHaveBeenCalledWith({
      installationId: 2002,
      pullRequestNumber: 77,
      fullName: 'ExampleOrg/open-service',
      labels: ['sample-disabled'],
    });
    expect(mockCreateOrUpdatePullRequestComment).toHaveBeenCalledWith({
      installationId: 2002,
      pullRequestNumber: 77,
      fullName: 'ExampleOrg/open-service',
      message: 'Tearing down lifecycle env since no activity in the past 7 days.',
    });
    expect(patch).toHaveBeenCalledWith({
      labels: JSON.stringify(['sample-disabled']),
    });
    expect(mockMetricsIncrement).toHaveBeenCalledWith('total', { dry_run: 'false' });
  });

  it('does not scan namespaces when TTL cleanup is disabled', async () => {
    mockGetAllConfigs.mockResolvedValue({ ttl_cleanup: { enabled: false } });

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockListNamespace).not.toHaveBeenCalled();
    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
  });

  it('honors a manual dry-run request without mutating the stale environment', async () => {
    const patch = jest.fn();
    mockExpiredNamespace('env-dry-run-123456');
    mockBuildLookup({
      id: 1,
      uuid: 'dry-run-123456',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 8,
        fullName: 'ExampleOrg/dry-run',
        labels: JSON.stringify(['sample-deploy']),
        repository: { githubInstallationId: 3 },
        $query: jest.fn(() => ({ patch })),
      },
    });
    mockGetPullRequestLabels.mockResolvedValue(['sample-deploy']);

    await buildService().processTTLCleanupQueue({ data: { dryRun: true } } as any);

    expect(mockGetPullRequestLabels).toHaveBeenCalledTimes(1);
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(mockMetricsIncrement).not.toHaveBeenCalled();
  });

  it('isolates a failed stale environment and continues cleaning the remaining environments', async () => {
    const firstBuild = {
      uuid: 'missing-id-123456',
      status: 'error',
      isStatic: false,
      pullRequest: {
        status: 'closed',
        pullRequestNumber: 10,
        fullName: 'ExampleOrg/first',
        labels: [],
        repository: { githubInstallationId: 1 },
      },
    };
    const secondBuild = {
      id: 22,
      uuid: 'healthy-123456',
      status: 'error',
      isStatic: false,
      pullRequest: {
        status: 'closed',
        pullRequestNumber: 11,
        fullName: 'ExampleOrg/second',
        labels: [],
        repository: { githubInstallationId: 2 },
      },
    };
    mockNamespaces([
      {
        metadata: {
          name: 'env-missing-id-123456',
          labels: { 'lfc/ttl-expireAtUnix': expiredTimestamp, 'lfc/uuid': firstBuild.uuid },
        },
      },
      {
        metadata: {
          name: 'env-healthy-123456',
          labels: { 'lfc/ttl-expireAtUnix': expiredTimestamp, 'lfc/uuid': secondBuild.uuid },
        },
      },
    ]);
    mockBuildQuery.mockReturnValueOnce(buildQuery(firstBuild)).mockReturnValueOnce(buildQuery(secondBuild));

    await expect(buildService().processTTLCleanupQueue({ data: {} } as any)).resolves.toBeUndefined();

    expect(mockEnqueueBuildDeletion).toHaveBeenCalledTimes(1);
    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(secondBuild, 'ttl_closed_pull_request');
  });

  it('propagates namespace scan failures after logging the failed job', async () => {
    const error = new Error('cluster unavailable');
    mockListNamespace.mockRejectedValue(error);

    await expect(buildService().processTTLCleanupQueue({ data: {} } as any)).rejects.toBe(error);

    expect(mockBuildQuery).not.toHaveBeenCalled();
  });

  it('skips namespaces that are not eligible for TTL lookup', async () => {
    mockNamespaces([
      {},
      { metadata: { name: 'kube-system', labels: { 'lfc/ttl-expireAtUnix': expiredTimestamp } } },
      { metadata: { name: 'env-no-expiration', labels: {} } },
      { metadata: { name: 'env-invalid-expiration', labels: { 'lfc/ttl-expireAtUnix': 'not-a-number' } } },
      {
        metadata: {
          name: 'env-future-expiration',
          labels: { 'lfc/ttl-expireAtUnix': String(Date.now() + 60_000) },
        },
      },
    ]);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockBuildQuery).not.toHaveBeenCalled();
    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
  });

  it('derives a missing build UUID from the namespace name', async () => {
    const build = {
      id: 41,
      uuid: 'derived-123456',
      status: 'error',
      isStatic: false,
      pullRequest: {
        status: 'closed',
        pullRequestNumber: 42,
        fullName: 'ExampleOrg/derived',
        labels: [],
        repository: { githubInstallationId: 1001 },
      },
    };
    mockNamespaces([
      {
        metadata: {
          name: 'env-derived-123456',
          labels: { 'lfc/ttl-expireAtUnix': expiredTimestamp },
        },
      },
    ]);
    const query = mockBuildLookup(build);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'derived-123456' });
    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(build, 'ttl_closed_pull_request');
  });

  it.each([
    ['missing build', undefined],
    ['already torn down build', { status: 'torn_down', isStatic: false }],
    ['pending build', { status: 'pending', isStatic: false }],
    ['static build', { status: 'deployed', isStatic: true }],
  ])('skips an expired namespace with a %s', async (_description, build) => {
    mockExpiredNamespace();
    mockBuildLookup(build);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockGetPullRequestLabels).not.toHaveBeenCalled();
    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
  });

  it('skips repositories excluded by configuration before fetching GitHub labels', async () => {
    mockGetAllConfigs.mockResolvedValue({
      ttl_cleanup: {
        enabled: true,
        inactivityDays: 7,
        excludedRepositories: ['ExampleOrg/excluded'],
      },
    });
    mockExpiredNamespace();
    mockBuildLookup({
      id: 1,
      uuid: 'sample-123456',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 1,
        fullName: 'ExampleOrg/excluded',
        labels: [],
        repository: { githubInstallationId: 1 },
      },
    });

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockGetPullRequestLabels).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
  });

  it('synchronizes GitHub label drift to the database and honors the current keep label', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    mockExpiredNamespace();
    mockBuildLookup({
      id: 1,
      uuid: 'sample-123456',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 1,
        fullName: 'ExampleOrg/kept',
        labels: JSON.stringify(['outdated']),
        repository: { githubInstallationId: 1 },
        $query: jest.fn(() => ({ patch })),
      },
    });
    mockGetPullRequestLabels.mockResolvedValue(['sample-keep', 'current']);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(patch).toHaveBeenCalledWith({ labels: JSON.stringify(['current', 'sample-keep']) });
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  it('falls back to persisted labels when GitHub label lookup fails', async () => {
    const patch = jest.fn();
    mockExpiredNamespace();
    mockBuildLookup({
      id: 1,
      uuid: 'sample-123456',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 1,
        fullName: 'ExampleOrg/disabled',
        labels: JSON.stringify(['sample-disabled']),
        repository: { githubInstallationId: 1 },
        $query: jest.fn(() => ({ patch })),
      },
    });
    mockGetPullRequestLabels.mockRejectedValue(new Error('GitHub unavailable'));

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(patch).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  it('contains GitHub cleanup failures without persisting or reporting success', async () => {
    const patch = jest.fn();
    mockExpiredNamespace();
    mockBuildLookup({
      id: 1,
      uuid: 'sample-123456',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 1,
        fullName: 'ExampleOrg/failing',
        labels: JSON.stringify(['sample-deploy']),
        repository: { githubInstallationId: 1 },
        $query: jest.fn(() => ({ patch })),
      },
    });
    mockGetPullRequestLabels.mockResolvedValue(['sample-deploy']);
    mockUpdatePullRequestLabels.mockRejectedValue(new Error('GitHub update failed'));

    await expect(buildService().processTTLCleanupQueue({ data: {} } as any)).resolves.toBeUndefined();

    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(mockMetricsIncrement).not.toHaveBeenCalled();
  });

  it('renders configured cleanup placeholders using the active label names', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    mockGetAllConfigs.mockResolvedValue({
      ttl_cleanup: {
        enabled: true,
        inactivityDays: 9,
        commentTemplate:
          'Idle {inactivityDays}/{inactivityDays}; use lifecycle-keep!, lifecycle-deploy!, or lifecycle-disabled!.',
      },
    });
    mockExpiredNamespace();
    mockBuildLookup({
      id: 1,
      uuid: 'sample-123456',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 1,
        fullName: 'ExampleOrg/template',
        labels: JSON.stringify(['sample-deploy']),
        repository: { githubInstallationId: 1 },
        $query: jest.fn(() => ({ patch })),
      },
    });
    mockGetPullRequestLabels.mockResolvedValue(['sample-deploy']);
    mockUpdatePullRequestLabels.mockResolvedValue(undefined);
    mockCreateOrUpdatePullRequestComment.mockResolvedValue(undefined);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockCreateOrUpdatePullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Idle 9/9; use sample-keep, sample-deploy, or sample-disabled.',
      })
    );
  });

  it('does not schedule the recurring job when TTL cleanup is disabled', async () => {
    mockGetAllConfigs.mockResolvedValue({});

    await buildService().setupTTLCleanupJob();

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('schedules the recurring job at the configured interval', async () => {
    mockGetAllConfigs.mockResolvedValue({
      ttl_cleanup: { enabled: true, checkIntervalMinutes: 15 },
    });
    mockQueueAdd.mockResolvedValue(undefined);

    await buildService().setupTTLCleanupJob();

    expect(mockQueueAdd).toHaveBeenCalledWith('ttl-cleanup', {}, { repeat: { every: 15 * 60 * 1000 } });
  });
});
