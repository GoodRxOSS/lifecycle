/**
 * Copyright 2026 Contributors
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

var mockReadNamespace: jest.Mock;
var mockCreateNamespace: jest.Mock;
var mockPatchNamespace: jest.Mock;
var mockGetAllConfigs: jest.Mock;
var mockGetLabels: jest.Mock;
var mockShellPromise: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');

  mockReadNamespace = jest.fn();
  mockCreateNamespace = jest.fn();
  mockPatchNamespace = jest.fn();

  const coreClient = {
    readNamespace: mockReadNamespace,
    createNamespace: mockCreateNamespace,
    patchNamespace: mockPatchNamespace,
  };

  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockImplementation((client: unknown) => {
        if (client === actual.CoreV1Api) {
          return coreClient;
        }

        return {};
      }),
    })),
  };
});

jest.mock('server/services/globalConfig', () => {
  mockGetAllConfigs = jest.fn();
  mockGetLabels = jest.fn();

  return {
    __esModule: true,
    default: {
      getInstance: jest.fn(() => ({
        getAllConfigs: mockGetAllConfigs,
        getLabels: mockGetLabels,
      })),
    },
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('server/lib/shell', () => {
  mockShellPromise = jest.fn();

  return {
    shellPromise: (...args: unknown[]) => mockShellPromise(...args),
  };
});

import { createOrUpdateNamespace, deleteBuild as deleteKubernetesBuild, deleteNamespace } from '../kubernetes';

describe('deleteBuild cleanup contract', () => {
  beforeEach(() => {
    mockShellPromise.mockReset();
  });

  it('treats resources in an already-absent namespace as cleaned up', async () => {
    mockShellPromise.mockRejectedValueOnce(new Error('Error from server (NotFound): namespaces "env-gone" not found'));

    await expect(deleteKubernetesBuild({ uuid: 'gone', namespace: 'env-gone' } as any)).resolves.toBeUndefined();
    expect(mockShellPromise).toHaveBeenCalledTimes(1);
  });

  it('propagates other resource-deletion failures so teardown can retry', async () => {
    const failure = new Error('unable to connect to the server');
    mockShellPromise.mockRejectedValueOnce(failure);

    await expect(deleteKubernetesBuild({ uuid: 'retry', namespace: 'env-retry' } as any)).rejects.toBe(failure);
  });
});

describe('deleteNamespace cleanup contract', () => {
  beforeEach(() => {
    mockShellPromise.mockReset();
  });

  it('treats an already-absent namespace as a successful idempotent cleanup', async () => {
    mockShellPromise.mockRejectedValueOnce(new Error('Error from server (NotFound): namespaces "env-gone" not found'));

    await expect(deleteNamespace('env-gone')).resolves.toBeUndefined();
  });

  it('propagates other kubectl failures so the teardown can retry', async () => {
    const failure = new Error('unable to connect to the server');
    mockShellPromise.mockRejectedValueOnce(failure);

    await expect(deleteNamespace('env-retry')).rejects.toBe(failure);
  });
});

describe('createOrUpdateNamespace metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadNamespace.mockReset();
    mockCreateNamespace.mockReset();
    mockPatchNamespace.mockReset();
    mockGetAllConfigs.mockReset();
    mockGetLabels.mockReset();
    mockShellPromise.mockReset();
    jest.useFakeTimers().setSystemTime(new Date('2026-04-16T12:00:00.000Z'));
    mockGetAllConfigs.mockResolvedValue({
      ttl_cleanup: {
        inactivityDays: 7,
      },
    });
    mockGetLabels.mockResolvedValue({
      keep: ['keep-env'],
    });
    mockShellPromise.mockResolvedValue('Active');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('adds PR and repo labels when creating a namespace', async () => {
    mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
    mockCreateNamespace.mockResolvedValue({});

    await createOrUpdateNamespace({
      name: 'env-abc123',
      buildUUID: 'abc123',
      staticEnv: false,
      repo: 'example-org/example-repo',
      pullRequestNumber: 2487,
      author: 'example-author',
    });

    expect(mockCreateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'env-abc123',
          labels: expect.objectContaining({
            'lfc/uuid': 'abc123',
            'lfc/type': 'ephemeral',
            'lfc/org': 'example-org',
            'lfc/repo': 'example-repo',
            'lfc/pull-request': '2487',
            'lfc/author': 'example-author',
          }),
        }),
      })
    );
  });

  it('adds TTL labels immediately for build-backed namespaces', async () => {
    mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
    mockCreateNamespace.mockResolvedValue({});

    await createOrUpdateNamespace({
      name: 'env-build123',
      buildUUID: 'build123',
      staticEnv: false,
      pullRequest: {
        fullName: 'example-org/example-repo',
        pullRequestNumber: 42,
        githubLogin: 'example-author',
        labels: ['deploy-env'],
      },
    });

    expect(mockCreateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'env-build123',
          labels: expect.objectContaining({
            'lfc/uuid': 'build123',
            'lfc/type': 'ephemeral',
            'lfc/ttl-enable': 'true',
            'lfc/ttl-createdAtUnix': '1776340800000',
            'lfc/ttl-createdAt': '2026-04-16',
            'lfc/ttl-expireAtUnix': '1776945600000',
            'lfc/ttl-expireAt': '2026-04-23',
            'lfc/org': 'example-org',
            'lfc/repo': 'example-repo',
            'lfc/pull-request': '42',
            'lfc/author': 'example-author',
          }),
        }),
      })
    );
  });

  it('disables TTL for build-backed namespaces when the pull request has the keep label', async () => {
    mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
    mockCreateNamespace.mockResolvedValue({});

    await createOrUpdateNamespace({
      name: 'env-keep123',
      buildUUID: 'keep123',
      staticEnv: false,
      pullRequest: {
        fullName: 'example-org/example-repo',
        pullRequestNumber: 99,
        githubLogin: 'example-author',
        labels: ['keep-env'],
      },
    });

    expect(mockCreateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          labels: expect.objectContaining({
            'lfc/uuid': 'keep123',
            'lfc/type': 'ephemeral',
            'lfc/ttl-enable': 'false',
          }),
        }),
      })
    );
    expect(mockCreateNamespace.mock.calls[0][0].metadata.labels).not.toHaveProperty('lfc/ttl-expireAtUnix');
  });

  it('waits for the namespace to become active when requested', async () => {
    mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
    mockCreateNamespace.mockResolvedValue({});

    await createOrUpdateNamespace({
      name: 'env-wait123',
      buildUUID: 'wait123',
      staticEnv: false,
      waitForReady: true,
    });

    expect(mockShellPromise).toHaveBeenCalledWith("kubectl get namespace env-wait123 -o jsonpath='{.status.phase}'");
  });

  it('patches PR and repo labels onto an existing namespace', async () => {
    mockReadNamespace
      .mockResolvedValueOnce({ body: { metadata: { name: 'env-abc123', labels: {} } } })
      .mockResolvedValueOnce({ body: { metadata: { name: 'env-abc123', labels: {} } } });
    mockPatchNamespace.mockResolvedValue({});

    await createOrUpdateNamespace({
      name: 'env-abc123',
      buildUUID: 'abc123',
      staticEnv: false,
      repo: 'example-org/example-repo',
      pullRequestNumber: 2487,
      author: 'example-author',
    });

    expect(mockPatchNamespace).toHaveBeenCalledWith(
      'env-abc123',
      expect.arrayContaining([
        {
          op: 'add',
          path: '/metadata/labels/lfc~1org',
          value: 'example-org',
        },
        {
          op: 'add',
          path: '/metadata/labels/lfc~1repo',
          value: 'example-repo',
        },
        {
          op: 'add',
          path: '/metadata/labels/lfc~1pull-request',
          value: '2487',
        },
        {
          op: 'add',
          path: '/metadata/labels/lfc~1author',
          value: 'example-author',
        },
      ]),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        headers: { 'Content-Type': 'application/json-patch+json' },
      }
    );
  });

  it('sanitizes bot authors before writing lfc/author', async () => {
    mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
    mockCreateNamespace.mockResolvedValue({});

    await createOrUpdateNamespace({
      name: 'env-bot123',
      buildUUID: 'bot123',
      staticEnv: false,
      repo: 'example-org/example-repo',
      pullRequestNumber: 77,
      author: 'automation[bot]',
    });

    expect(mockCreateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          labels: expect.objectContaining({
            'lfc/author': 'automation-bot',
          }),
        }),
      })
    );
  });

  it('truncates long repository names to a Kubernetes-safe lfc/repo label', async () => {
    mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
    mockCreateNamespace.mockResolvedValue({});

    const longRepoName = 'example-repository-name-that-exceeds-the-kubernetes-label-limit-by-a-lot';

    await createOrUpdateNamespace({
      name: 'env-longrepo',
      buildUUID: 'longrepo',
      staticEnv: false,
      repo: `example-org/${longRepoName}`,
      pullRequestNumber: 91,
      author: 'example-author',
    });

    expect(mockCreateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          labels: expect.objectContaining({
            'lfc/repo': 'example-repository-name-that-exceeds-the-kubernetes-label-limit',
          }),
        }),
      })
    );
  });
});
