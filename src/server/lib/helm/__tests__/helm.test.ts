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

import {
  constructHelmDeploysBuildMetaData,
  grpcMapping,
  helmOrgAppDeployStep,
  uninstallHelmReleases,
} from 'server/lib/helm';
import type { Deploy } from 'server/models';
import GlobalConfigService from 'server/services/globalConfig';

const mockDeployQuery = jest.fn();
const mockShellPromise = jest.fn();

jest.mock('server/lib/envVariables', () => ({
  EnvironmentVariables: class {},
}));

jest.mock('server/services/globalConfig');
jest.mock('server/models/Deploy', () => ({
  __esModule: true,
  default: {
    query: () => mockDeployQuery(),
  },
}));
jest.mock('server/lib/shell', () => ({
  shellPromise: (...args: unknown[]) => mockShellPromise(...args),
}));
jest.mock('server/lib/helm/utils', () => {
  const originalModule = jest.requireActual('server/lib/helm/utils');
  return {
    ...originalModule,
    renderTemplate: jest.fn().mockImplementation(async (_build, values) => values || []),
  };
});

describe('Helm tests', () => {
  test('does not eager-load the removed Deploy.service relation during uninstall', async () => {
    const withGraphFetched = jest.fn().mockResolvedValue([]);
    const where = jest.fn(() => ({ withGraphFetched }));
    mockDeployQuery.mockReturnValue({ where });

    await uninstallHelmReleases({ id: 42, namespace: 'env-build-uuid' } as any);

    expect(withGraphFetched).toHaveBeenCalledWith({ build: true, deployable: true });
    expect(withGraphFetched.mock.calls[0][0]).not.toHaveProperty('service');
  });

  test('treats an already-absent Helm release as successful idempotent cleanup', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    const deploy = {
      uuid: 'app-build-uuid',
      active: true,
      status: 'deployed',
      deployable: { helm: { chart: { name: 'app' } } },
      $query: jest.fn(() => ({ patch })),
    };
    const withGraphFetched = jest.fn().mockResolvedValue([deploy]);
    mockDeployQuery.mockReturnValue({ where: jest.fn(() => ({ withGraphFetched })) });
    mockShellPromise.mockRejectedValueOnce(new Error('uninstall: Release not loaded: release: not found'));

    await expect(uninstallHelmReleases({ id: 42, namespace: 'env-build-uuid' } as any)).resolves.toBeUndefined();
    expect(patch).toHaveBeenCalledWith({ statusMessage: 'Helm release not found, skipping uninstall.' });
  });

  test('propagates real Helm failures so teardown can retry', async () => {
    const failure = new Error('cluster unavailable');
    const patch = jest.fn().mockResolvedValue(undefined);
    const deploy = {
      uuid: 'app-build-uuid',
      active: true,
      status: 'deployed',
      deployable: { helm: { chart: { name: 'app' } } },
      $query: jest.fn(() => ({ patch })),
    };
    const withGraphFetched = jest.fn().mockResolvedValue([deploy]);
    mockDeployQuery.mockReturnValue({ where: jest.fn(() => ({ withGraphFetched })) });
    mockShellPromise.mockRejectedValueOnce(failure);

    await expect(uninstallHelmReleases({ id: 42, namespace: 'env-build-uuid' } as any)).rejects.toBe(failure);
    expect(patch).toHaveBeenCalledWith({ statusMessage: 'Failed to uninstall via Helm\ncluster unavailable' });
  });

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

  describe('helmOrgAppDeployStep', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('does not emit deployment.version when init image is present', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        lifecycleDefaults: {
          deployCluster: 'test-cluster',
          cfStepType: 'helm',
        },
        'lifecycle-app': {
          chart: {
            values: [],
          },
        },
        serviceDefaults: {
          defaultIPWhiteList: '[1.1.1.1/32]',
        },
        domainDefaults: {
          http: 'preview.lifecycle.com',
        },
      });
      const mockGetOrgChartName = jest.fn().mockResolvedValue('lifecycle-app');

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
        getOrgChartName: mockGetOrgChartName,
      });

      const deploy = {
        uuid: 'test-uuid',
        dockerImage: 'repo/app:tag',
        initDockerImage: 'repo/init:tag',
        env: {
          DB_HOST: 'postgres.internal',
        },
        initEnv: {
          INIT_DB_HOST: 'init-postgres.internal',
        },
        deployable: {
          buildUUID: 'build-123',
          port: 8080,
          helm: {
            chart: { name: 'lifecycle-app', values: [] },
            docker: {
              app: {},
              init: {},
            },
          },
        },
        build: {
          namespace: 'env-test',
          commentRuntimeEnv: {},
          isStatic: false,
        },
        $fetchGraph: jest.fn(),
      } as unknown as Deploy;

      const result = await helmOrgAppDeployStep(deploy);
      const customValues = result.arguments.custom_values as string[];

      expect(customValues).toContain('deployment.initImage=repo/init:tag');
      expect(customValues.some((value) => value.startsWith('deployment.version='))).toBe(false);
    });

    test('converts secret shorthand env entries for native-build org charts', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        lifecycleDefaults: {
          deployCluster: 'test-cluster',
          cfStepType: 'helm',
        },
        'lifecycle-app': {
          chart: {
            values: [],
          },
        },
        serviceDefaults: {
          defaultIPWhiteList: '[1.1.1.1/32]',
        },
        domainDefaults: {
          http: 'preview.lifecycle.com',
        },
      });
      const mockGetOrgChartName = jest.fn().mockResolvedValue('lifecycle-app');

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
        getOrgChartName: mockGetOrgChartName,
      });

      const deploy = {
        uuid: 'test-uuid',
        dockerImage: 'repo/app:tag',
        initDockerImage: 'repo/init:tag',
        env: {
          DB_URL: '{{aws:myapp/rds-credentials:url}}',
        },
        initEnv: {
          INIT_TOKEN: '{{aws:myapp/rds-credentials:init_token}}',
        },
        deployable: {
          name: 'mail-delivery-backend',
          buildUUID: 'build-123',
          port: 8080,
          builder: {
            engine: 'buildkit',
          },
          helm: {
            chart: { name: 'lifecycle-app', values: [] },
            docker: {
              app: {},
              init: {},
            },
          },
        },
        build: {
          namespace: 'env-test',
          commentRuntimeEnv: {},
          isStatic: false,
        },
        $fetchGraph: jest.fn(),
      } as unknown as Deploy;

      const result = await helmOrgAppDeployStep(deploy);
      const customValues = result.arguments.custom_values as string[];

      expect(customValues).toContain(
        'deployment.env.DB__URL.valueFrom.secretKeyRef.name="mail-delivery-backend-aws-secrets"'
      );
      expect(customValues).toContain('deployment.env.DB__URL.valueFrom.secretKeyRef.key="DB_URL"');
      expect(customValues).toContain(
        'deployment.initEnv.INIT__TOKEN.valueFrom.secretKeyRef.name=mail-delivery-backend-aws-secrets'
      );
      expect(customValues).toContain('deployment.initEnv.INIT__TOKEN.valueFrom.secretKeyRef.key=INIT_TOKEN');
    });

    test('keeps secret shorthand as a plain env value for non-native builders', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        lifecycleDefaults: {
          deployCluster: 'test-cluster',
          cfStepType: 'helm',
        },
        'lifecycle-app': {
          chart: {
            values: [],
          },
        },
        serviceDefaults: {
          defaultIPWhiteList: '[1.1.1.1/32]',
        },
        domainDefaults: {
          http: 'preview.lifecycle.com',
        },
      });
      const mockGetOrgChartName = jest.fn().mockResolvedValue('lifecycle-app');

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
        getOrgChartName: mockGetOrgChartName,
      });

      const deploy = {
        uuid: 'test-uuid',
        dockerImage: 'repo/app:tag',
        env: {
          DB_URL: '{{aws:myapp/rds-credentials:url}}',
        },
        deployable: {
          name: 'mail-delivery-backend',
          buildUUID: 'build-123',
          port: 8080,
          builder: {
            engine: 'ci',
          },
          helm: {
            chart: { name: 'lifecycle-app', values: [] },
            docker: {
              app: {},
            },
          },
        },
        build: {
          namespace: 'env-test',
          commentRuntimeEnv: {},
          isStatic: false,
        },
        $fetchGraph: jest.fn(),
      } as unknown as Deploy;

      const result = await helmOrgAppDeployStep(deploy);
      const customValues = result.arguments.custom_values as string[];

      expect(customValues).toContain('deployment.env.DB__URL="{{aws:myapp/rds-credentials:url}}"');
    });

    test('rejects Helm chart value secret refs for Codefresh deploys', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        lifecycleDefaults: {
          deployCluster: 'test-cluster',
          cfStepType: 'helm',
        },
        'lifecycle-app': {
          chart: {
            values: [],
          },
        },
        serviceDefaults: {
          defaultIPWhiteList: '[1.1.1.1/32]',
        },
        domainDefaults: {
          http: 'preview.lifecycle.com',
        },
      });
      const mockGetOrgChartName = jest.fn().mockResolvedValue('lifecycle-app');

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
        getOrgChartName: mockGetOrgChartName,
      });

      const deploy = {
        uuid: 'test-uuid',
        dockerImage: 'repo/app:tag',
        deployable: {
          name: 'sample-backend',
          buildUUID: 'build-123',
          port: 8080,
          helm: {
            chart: {
              name: 'lifecycle-app',
              values: ['auth.password={{aws:repo/example/database:POSTGRES_PASSWORD}}'],
            },
            docker: {
              app: {},
            },
          },
        },
        build: {
          namespace: 'env-test',
          commentRuntimeEnv: {},
          isStatic: false,
        },
        $fetchGraph: jest.fn(),
      } as unknown as Deploy;

      await expect(helmOrgAppDeployStep(deploy)).rejects.toThrow(
        'Codefresh Helm deploy path does not support helm.chart.values secret refs'
      );
    });

    test('emits gatewayApi values and suppresses legacy routing when gateway api is enabled', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        lifecycleDefaults: {
          cfStepType: 'helm',
        },
        'lifecycle-app': {
          chart: {
            values: [],
          },
        },
        serviceDefaults: {
          defaultIPWhiteList: '[1.1.1.1/32]',
        },
        domainDefaults: {
          http: 'preview.lifecycle.com',
          altHttp: ['preview-alt.lifecycle.com'],
          grpc: 'grpc.preview.lifecycle.com',
          altGrpc: ['grpc-alt.preview.lifecycle.com'],
        },
      });
      const mockGetOrgChartName = jest.fn().mockResolvedValue('lifecycle-app');

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
        getOrgChartName: mockGetOrgChartName,
      });

      const deploy = {
        uuid: 'test-uuid',
        dockerImage: 'repo/app:tag',
        deployable: {
          name: 'sample-backend',
          buildUUID: 'build-123',
          port: 8080,
          helm: {
            chart: {
              name: 'lifecycle-app',
              values: [],
            },
            grpc: true,
            gatewayApi: {
              enabled: true,
              gateway: 'external',
              gateways: {
                grpc: {
                  external: 'community-gateway-grpc',
                },
              },
            },
            docker: {
              app: {},
            },
          },
        },
        build: {
          namespace: 'env-test',
          commentRuntimeEnv: {},
          isStatic: false,
        },
        $fetchGraph: jest.fn(),
      } as unknown as Deploy;

      const result = await helmOrgAppDeployStep(deploy);
      const customValues = result.arguments.custom_values as string[];

      expect(customValues).toContain('gatewayApi.enabled=true');
      expect(customValues).toContain('gatewayApi.protocol=grpc');
      expect(customValues).toContain('gatewayApi.gateway=external');
      expect(customValues).toContain('gatewayApi.gateways.grpc.external=community-gateway-grpc');
      expect(customValues).toContain('gatewayApi.port=8080');
      expect(customValues).toContain('gatewayApi.hostnames[0]=test-uuid.grpc.preview.lifecycle.com');
      expect(customValues).toContain('gatewayApi.hostnames[1]=test-uuid.grpc-alt.preview.lifecycle.com');
      expect(customValues).toContain('gatewayApi.securityPolicy.enabled=true');
      expect(customValues).toContain('gatewayApi.securityPolicy.allowedCIDRs[0]=1.1.1.1/32');
      expect(customValues.some((value) => value.startsWith('ambassadorMappings['))).toBe(false);
      expect(customValues.some((value) => value.startsWith('ingress.'))).toBe(false);
    });

    test('rejects gateway api config without a target when routes are not provided', async () => {
      const mockGetAllConfigs = jest.fn().mockResolvedValue({
        lifecycleDefaults: {
          cfStepType: 'helm',
        },
        'lifecycle-app': {
          chart: {
            values: [],
          },
        },
        serviceDefaults: {
          defaultIPWhiteList: '[1.1.1.1/32]',
        },
        domainDefaults: {
          http: 'preview.lifecycle.com',
          grpc: 'grpc.preview.lifecycle.com',
        },
      });
      const mockGetOrgChartName = jest.fn().mockResolvedValue('lifecycle-app');

      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: mockGetAllConfigs,
        getOrgChartName: mockGetOrgChartName,
      });

      const deploy = {
        uuid: 'test-uuid',
        dockerImage: 'repo/app:tag',
        deployable: {
          name: 'sample-backend',
          buildUUID: 'build-123',
          port: 8080,
          helm: {
            chart: {
              name: 'lifecycle-app',
              values: [],
            },
            grpc: true,
            gatewayApi: {
              enabled: true,
              gateway: 'external',
            },
            docker: {
              app: {},
            },
          },
        },
        build: {
          namespace: 'env-test',
          commentRuntimeEnv: {},
          isStatic: false,
        },
        $fetchGraph: jest.fn(),
      } as unknown as Deploy;

      await expect(helmOrgAppDeployStep(deploy)).rejects.toThrow(
        'helm.gatewayApi requires gateway or gatewayName when routes are not provided'
      );
    });
  });
});
