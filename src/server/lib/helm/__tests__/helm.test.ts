/**
 * Copyright 2025 GoodRx, Inc.
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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import { constructHelmDeploysBuildMetaData, grpcMapping } from 'server/lib/helm';
import { Deploy } from 'server/models';
import GlobalConfigService from 'server/services/globalConfig';

jest.mock('server/lib/envVariables', () => ({
  EnvironmentVariables: class {},
}));

jest.mock('server/services/globalConfig');

describe('Helm tests', () => {
  test('constructHelmDeploysBuildMetaData should return the correct metadata', async () => {
    const deploys = [
      {
        build: {
          uuid: '123',
          pullRequest: {
            branchName: 'feature/branch',
            fullName: 'user/repo',
            latestCommit: 'abc123',
          },
        },
      },
    ] as Partial<Deploy[]>;

    const expectedMetadata = {
      uuid: '123',
      branchName: 'feature/branch',
      fullName: 'user/repo',
      sha: 'abc123',
      error: '',
    };

    const metadata = await constructHelmDeploysBuildMetaData(deploys);
    expect(metadata).toEqual(expectedMetadata);
  });

  test('constructHelmDeploysBuildMetaData should handle missing build or pull request', async () => {
    const deploys = [
      {
        build: null,
        $fetchGraph: jest.fn(),
      },
    ];
    const metadata = await constructHelmDeploysBuildMetaData(deploys);
    expect(metadata).toEqual({ branchName: '', fullName: '', sha: '', uuid: '', error: 'no_related_build_found' });
  });

  describe('grpcMapping', () => {
    const mockDeploy = {
      uuid: 'test-deploy-uuid',
      deployable: {
        buildUUID: 'test-build-uuid',
        port: 8080,
      },
    } as unknown as Deploy;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('should create single ambassador mapping when altGrpc is empty', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        domainDefaults: {
          grpc: 'grpc.example.com',
          altGrpc: [],
        },
      });

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
      });

      const result = await grpcMapping(mockDeploy);

      expect(result).toEqual([
        'ambassadorMappings[0].name=test-deploy-uuid-0',
        'ambassadorMappings[0].env=lifecycle-test-build-uuid',
        'ambassadorMappings[0].service=test-deploy-uuid',
        'ambassadorMappings[0].version=test-deploy-uuid',
        'ambassadorMappings[0].host=test-deploy-uuid.grpc.example.com:443',
        'ambassadorMappings[0].port=8080',
      ]);
    });

    test('should create single ambassador mapping when altGrpc is undefined', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        domainDefaults: {
          grpc: 'grpc.example.com',
        },
      });

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
      });

      const result = await grpcMapping(mockDeploy);

      expect(result).toEqual([
        'ambassadorMappings[0].name=test-deploy-uuid-0',
        'ambassadorMappings[0].env=lifecycle-test-build-uuid',
        'ambassadorMappings[0].service=test-deploy-uuid',
        'ambassadorMappings[0].version=test-deploy-uuid',
        'ambassadorMappings[0].host=test-deploy-uuid.grpc.example.com:443',
        'ambassadorMappings[0].port=8080',
      ]);
    });

    test('should create multiple ambassador mappings when altGrpc has values', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        domainDefaults: {
          grpc: 'grpc.example.com',
          altGrpc: ['grpc-alt.example.com'],
        },
      });

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
      });

      const result = await grpcMapping(mockDeploy);

      expect(result).toEqual([
        'ambassadorMappings[0].name=test-deploy-uuid-0',
        'ambassadorMappings[0].env=lifecycle-test-build-uuid',
        'ambassadorMappings[0].service=test-deploy-uuid',
        'ambassadorMappings[0].version=test-deploy-uuid',
        'ambassadorMappings[0].host=test-deploy-uuid.grpc.example.com:443',
        'ambassadorMappings[0].port=8080',
        'ambassadorMappings[1].name=test-deploy-uuid-1',
        'ambassadorMappings[1].env=lifecycle-test-build-uuid',
        'ambassadorMappings[1].service=test-deploy-uuid',
        'ambassadorMappings[1].version=test-deploy-uuid',
        'ambassadorMappings[1].host=test-deploy-uuid.grpc-alt.example.com:443',
        'ambassadorMappings[1].port=8080',
      ]);
    });
  });
});
