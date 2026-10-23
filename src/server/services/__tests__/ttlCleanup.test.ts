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
const mockAgentSessionFirst = jest.fn();

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
          AgentSession: {
            query: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              whereIn: jest.fn().mockReturnThis(),
              first: mockAgentSessionFirst,
            })),
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
    mockAgentSessionFirst.mockResolvedValue(undefined);
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

  it('disables expired open pull requests and enqueues teardown without waiting for the label webhook', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    mockExpiredNamespace('env-open-sample-654321');
    const build = {
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
    };
    mockBuildLookup(build);
    mockGetPullRequestLabels.mockResolvedValue(['sample-deploy']);
    mockUpdatePullRequestLabels.mockResolvedValue(undefined);
    mockCreateOrUpdatePullRequestComment.mockResolvedValue(undefined);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockListNamespace).toHaveBeenCalledWith(undefined, undefined, undefined, undefined, 'lfc/ttl-enable!=false');
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
      deployOnUpdate: false,
    });
    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(build, 'deploy_disabled');
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(mockEnqueueBuildDeletion.mock.invocationCallOrder[0]);
    expect(mockMetricsIncrement).toHaveBeenCalledWith('total', { dry_run: 'false' });
  });

  it('tears down an expired environment whose pull request already carries the disabled label', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    mockExpiredNamespace('env-missed-webhook-123456');
    const build = {
      id: 457,
      uuid: 'missed-webhook-123456',
      status: 'error',
      isStatic: false,
      pullRequest: {
        status: 'open',
        deployOnUpdate: true,
        pullRequestNumber: 78,
        fullName: 'ExampleOrg/missed-webhook',
        labels: JSON.stringify(['sample-disabled']),
        repository: { githubInstallationId: 2002 },
        $query: jest.fn(() => ({ patch })),
      },
    };
    mockBuildLookup(build);
    mockGetPullRequestLabels.mockResolvedValue(['sample-disabled']);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(patch).toHaveBeenCalledWith({ labels: JSON.stringify(['sample-disabled']), deployOnUpdate: false });
    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(build, 'deploy_disabled');
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  it('enqueues teardown for an expired sandbox without touching the base pull request', async () => {
    mockNamespaces([
      {
        metadata: {
          name: 'sbx-sample-123456',
          labels: {
            'lfc/ttl-enable': 'true',
            'lfc/ttl-expireAtUnix': expiredTimestamp,
            'lfc/uuid': 'sbx-sample-123456',
          },
        },
      },
    ]);
    const build = {
      id: 88,
      uuid: 'sample-123456',
      kind: 'sandbox',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 5,
        fullName: 'ExampleOrg/base',
        labels: JSON.stringify(['sample-deploy']),
        repository: { githubInstallationId: 1 },
      },
    };
    const query = mockBuildLookup(build);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'sample-123456' });
    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(build, 'ttl_sandbox_expired');
    expect(mockGetPullRequestLabels).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  it('derives the build UUID from a sandbox namespace name', async () => {
    mockNamespaces([
      {
        metadata: {
          name: 'sbx-derived-123456',
          labels: { 'lfc/ttl-expireAtUnix': expiredTimestamp },
        },
      },
    ]);
    const query = mockBuildLookup({
      id: 89,
      uuid: 'derived-123456',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'closed',
        pullRequestNumber: 6,
        fullName: 'ExampleOrg/closed',
        labels: [],
        repository: { githubInstallationId: 1 },
      },
    });

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'derived-123456' });
    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(expect.anything(), 'ttl_closed_pull_request');
  });

  it.each([
    ['backs a live agent session', { id: 7 }, []],
    ['belongs to an excluded repository', undefined, ['ExampleOrg/base']],
  ])('keeps an expired sandbox that %s', async (_description, liveSession, excludedRepositories) => {
    mockGetAllConfigs.mockResolvedValue({
      ttl_cleanup: { enabled: true, inactivityDays: 7, excludedRepositories },
    });
    mockAgentSessionFirst.mockResolvedValue(liveSession);
    mockNamespaces([
      {
        metadata: {
          name: 'sbx-busy-123456',
          labels: { 'lfc/ttl-enable': 'true', 'lfc/ttl-expireAtUnix': expiredTimestamp, 'lfc/uuid': 'sbx-busy-123456' },
        },
      },
    ]);
    mockBuildLookup({
      id: 92,
      uuid: 'busy-123456',
      kind: 'sandbox',
      status: 'deployed',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 5,
        fullName: 'ExampleOrg/base',
        labels: [],
        repository: { githubInstallationId: 1 },
      },
    });

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
  });

  it('leaves a disabled environment alone when its pull request is re-enabled before teardown', async () => {
    const patch = jest.fn();
    mockExpiredNamespace('env-reenabled-123456');
    mockBuildLookup({
      id: 93,
      uuid: 'reenabled-123456',
      status: 'error',
      isStatic: false,
      pullRequest: {
        status: 'open',
        pullRequestNumber: 79,
        fullName: 'ExampleOrg/reenabled',
        labels: JSON.stringify(['sample-disabled']),
        repository: { githubInstallationId: 2002 },
        $query: jest.fn(() => ({ patch })),
      },
    });
    mockGetPullRequestLabels.mockResolvedValueOnce(['sample-disabled']).mockResolvedValueOnce(['sample-deploy']);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(patch).not.toHaveBeenCalled();
    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
  });

  it('expires a namespace with no TTL labels from its last activity', async () => {
    const lastActivity = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    mockNamespaces([
      {
        metadata: {
          name: 'env-unlabeled-123456',
          creationTimestamp: lastActivity,
          labels: {},
        },
      },
    ]);
    const build = {
      id: 90,
      uuid: 'unlabeled-123456',
      status: 'error',
      isStatic: false,
      updatedAt: lastActivity,
      pullRequest: {
        status: 'closed',
        pullRequestNumber: 7,
        fullName: 'ExampleOrg/unlabeled',
        labels: [],
        repository: { githubInstallationId: 1 },
      },
    };
    const query = mockBuildLookup(build);

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'unlabeled-123456' });
    expect(mockEnqueueBuildDeletion).toHaveBeenCalledWith(build, 'ttl_closed_pull_request');
  });

  it('keeps a namespace with no TTL labels while its build was active within the TTL window', async () => {
    mockNamespaces([
      {
        metadata: {
          name: 'env-unlabeled-recent-123456',
          creationTimestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          labels: {},
        },
      },
    ]);
    mockBuildLookup({
      id: 91,
      uuid: 'unlabeled-recent-123456',
      status: 'deployed',
      isStatic: false,
      updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      pullRequest: {
        status: 'closed',
        pullRequestNumber: 8,
        fullName: 'ExampleOrg/recent',
        labels: [],
        repository: { githubInstallationId: 1 },
      },
    });

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
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
      { metadata: { name: 'env-no-expiration', labels: { 'lfc/ttl-enable': 'true' } } },
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

  it('does not tear down a disabled environment when GitHub labels cannot be confirmed', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    mockExpiredNamespace();
    const build = {
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
    };
    mockBuildLookup(build);
    mockGetPullRequestLabels.mockRejectedValue(new Error('GitHub unavailable'));

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(patch).not.toHaveBeenCalled();
    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalledWith(build, expect.anything());
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
    expect(mockEnqueueBuildDeletion).not.toHaveBeenCalled();
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
