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

  return {
    __esModule: true,
    default: {
      getInstance: jest.fn(() => ({
        getAllConfigs: mockGetAllConfigs,
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

import { createOrUpdateNamespace } from '../kubernetes';

describe('createOrUpdateNamespace metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-04-16T12:00:00.000Z'));
    mockGetAllConfigs.mockResolvedValue({
      ttl_cleanup: {
        inactivityDays: 7,
      },
    });
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
});
