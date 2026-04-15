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

const mockDeployQuery = jest.fn();
const mockGenerateManifest = jest.fn();
const mockApplyManifests = jest.fn();
const mockWaitForPodReady = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockQueueAdd = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('server/lib/tracer', () => ({
  Tracer: {
    getInstance: jest.fn(() => ({
      initialize: jest.fn(),
    })),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  withLogContext: jest.fn((ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));

jest.mock('server/models', () => ({
  Build: class {},
  Deploy: {
    query: () => mockDeployQuery(),
  },
  Environment: class {},
  Service: class {},
  BuildServiceOverride: class {},
}));

jest.mock('server/lib/kubernetes', () => ({
  generateManifest: (...args: any[]) => mockGenerateManifest(...args),
  applyManifests: (...args: any[]) => mockApplyManifests(...args),
  waitForPodReady: (...args: any[]) => mockWaitForPodReady(...args),
  createOrUpdateNamespace: jest.fn(),
  createOrUpdateServiceAccount: jest.fn(),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
    })),
  },
}));

jest.mock('server/lib/fastly', () =>
  jest.fn().mockImplementation(() => ({
    getServiceDashboardUrl: jest.fn(),
  }))
);

import BuildService from '../build';
import { DeployStatus, DeployTypes } from 'shared/constants';

describe('BuildService failure boundaries', () => {
  let buildService: BuildService;
  let recordDeployFailure: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    recordDeployFailure = jest.fn();
    const queueManager = {
      registerQueue: jest.fn(() => ({
        add: mockQueueAdd,
        process: jest.fn(),
        on: jest.fn(),
      })),
    };
    buildService = new BuildService(
      {
        services: {
          Deploy: {
            recordDeployFailure,
          },
        },
      } as any,
      {} as any,
      {} as any,
      queueManager as any
    );
    (buildService as any).ingressService = {
      ingressManifestQueue: {
        add: mockQueueAdd,
      },
    };
    mockGetAllConfigs.mockResolvedValue({ serviceAccount: { name: 'sample-service-account' } });
  });

  test('classic manifest failures stay build-scoped when no deploy can be identified', async () => {
    const deploys = [
      {
        id: 1,
        active: true,
        uuid: 'sample-api',
        status: DeployStatus.BUILT,
        service: { type: DeployTypes.GITHUB, name: 'sample-api' },
      },
      {
        id: 2,
        active: true,
        uuid: 'sample-worker',
        status: DeployStatus.BUILT,
        service: { type: DeployTypes.DOCKER, name: 'sample-worker' },
      },
    ];
    const query = {
      where: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue(deploys),
    };
    const rolloutError = new Error('Pods for build not ready after 15 minutes');
    mockDeployQuery.mockReturnValue(query);
    mockGenerateManifest.mockReturnValue('apiVersion: apps/v1\nkind: Deployment\n');
    mockApplyManifests.mockResolvedValue([]);
    mockWaitForPodReady.mockRejectedValue(rolloutError);

    await expect(
      buildService.generateAndApplyManifests({
        build: {
          id: 123,
          uuid: 'sample-build',
          runUUID: 'run-1',
          namespace: 'sample-namespace',
          enableFullYaml: false,
          $query: jest.fn(() => ({
            patch: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
        githubRepositoryId: null,
        namespace: 'sample-namespace',
      })
    ).rejects.toThrow(rolloutError);

    expect(recordDeployFailure).not.toHaveBeenCalled();
  });
});
