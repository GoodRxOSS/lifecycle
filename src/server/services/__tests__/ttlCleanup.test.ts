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
const mockDeleteQueueAdd = jest.fn();
const mockBuildQuery = jest.fn();
const mockExtractContextForQueue = jest.fn();
const mockMetricsIncrement = jest.fn();

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
  extractContextForQueue: (...args: any[]) => mockExtractContextForQueue(...args),
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
            deleteQueue: {
              add: mockDeleteQueueAdd,
            },
          },
        },
      } as any,
      {} as any,
      {} as any,
      {
        registerQueue: jest.fn(() => ({
          add: jest.fn(),
        })),
      } as any
    );

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

  beforeEach(() => {
    jest.clearAllMocks();
    mockExtractContextForQueue.mockReturnValue({ correlationId: 'ttl-test-correlation' });
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
    mockBuildLookup({
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
    });

    await buildService().processTTLCleanupQueue({ data: {} } as any);

    expect(mockDeleteQueueAdd).toHaveBeenCalledWith('delete', {
      buildId: 123,
      buildUuid: 'sample-123456',
      correlationId: 'ttl-test-correlation',
    });
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

    expect(mockDeleteQueueAdd).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).toHaveBeenCalledWith({
      installationId: 2002,
      pullRequestNumber: 77,
      fullName: 'ExampleOrg/open-service',
      labels: ['sample-disabled'],
    });
    expect(mockCreateOrUpdatePullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 2002,
        pullRequestNumber: 77,
        fullName: 'ExampleOrg/open-service',
      })
    );
    expect(patch).toHaveBeenCalledWith({
      labels: JSON.stringify(['sample-disabled']),
    });
  });
});
