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

import { shouldUseNativeHelm, createHelmContainer } from '../helm';
import { determineChartType, constructHelmCommand, ChartType, constructHelmCustomValues } from '../utils';
import Deploy from 'server/models/Deploy';
import GlobalConfigService from 'server/services/globalConfig';

jest.mock('server/services/globalConfig');
jest.mock('server/lib/kubernetes');
jest.mock('server/lib/helm/utils', () => {
  const originalModule = jest.requireActual('server/lib/helm/utils');
  return {
    ...originalModule,
    renderTemplate: jest.fn().mockImplementation(async (_build, values) => values),
  };
});

const mockGetAllConfigs = jest.fn();
const mockGetOrgChartName = jest.fn();

(GlobalConfigService.getInstance as jest.Mock) = jest.fn().mockReturnValue({
  getAllConfigs: mockGetAllConfigs,
  getOrgChartName: mockGetOrgChartName,
});

describe('Native Helm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('shouldUseNativeHelm', () => {
    it('should return true when deploymentMethod is explicitly set to native', async () => {
      const deploy = {
        deployable: {
          helm: {
            deploymentMethod: 'native',
          },
        },
      } as Deploy;

      const result = await shouldUseNativeHelm(deploy);
      expect(result).toBe(true);
    });

    it('should return false when deploymentMethod is explicitly set to ci', async () => {
      const deploy = {
        deployable: {
          helm: {
            deploymentMethod: 'ci',
          },
        },
      } as Deploy;

      const result = await shouldUseNativeHelm(deploy);
      expect(result).toBe(false);
    });

    it('should return true when global nativeHelm is enabled via deployable helm config', async () => {
      const deploy = {
        deployable: {
          helm: {
            nativeHelm: {
              enabled: true,
            },
          },
        },
      } as Deploy;

      const result = await shouldUseNativeHelm(deploy);
      expect(result).toBe(true);
    });

    it('should return false by default', async () => {
      const deploy = {
        deployable: {
          helm: {},
        },
      } as Deploy;

      const result = await shouldUseNativeHelm(deploy);
      expect(result).toBe(false);
    });
  });

  describe('determineChartType', () => {
    beforeEach(() => {
      mockGetOrgChartName.mockResolvedValue('my-org-chart');
    });

    it('should return ORG_CHART for org chart with docker config', async () => {
      const deploy = {
        deployable: {
          helm: {
            chart: { name: 'my-org-chart' },
            docker: { defaultTag: 'latest' },
          },
        },
      } as Deploy;

      const result = await determineChartType(deploy);
      expect(result).toBe(ChartType.ORG_CHART);
    });

    it('should return LOCAL for local chart', async () => {
      const deploy = {
        deployable: {
          helm: {
            chart: { name: 'local' },
          },
        },
      } as Deploy;

      const result = await determineChartType(deploy);
      expect(result).toBe(ChartType.LOCAL);
    });

    it('should return LOCAL for relative path chart', async () => {
      const deploy = {
        deployable: {
          helm: {
            chart: { name: './my-chart' },
          },
        },
      } as Deploy;

      const result = await determineChartType(deploy);
      expect(result).toBe(ChartType.LOCAL);
    });

    it('should return PUBLIC for external chart', async () => {
      const deploy = {
        deployable: {
          helm: {
            chart: { name: 'bitnami/postgresql' },
          },
        },
      } as Deploy;

      const result = await determineChartType(deploy);
      expect(result).toBe(ChartType.PUBLIC);
    });
  });

  describe('constructHelmCommand', () => {
    it('should construct basic helm command', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        undefined, // args
        undefined // chartRepoUrl
        // no defaultArgs
      );

      expect(result).toContain('helm upgrade --install my-release my-chart');
      expect(result).toContain('--namespace my-namespace');
      expect(result).toContain('--set "key=value"');
      expect(result).toContain('-f values.yaml');
      // Should not have any default args when none provided
      expect(result).not.toContain('--wait');
      expect(result).not.toContain('--timeout');
    });

    it('should handle local chart paths', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        [],
        [],
        ChartType.LOCAL,
        undefined, // args
        undefined // chartRepoUrl
        // no defaultArgs
      );

      expect(result).toContain('./my-chart');
    });

    it('should not double prefix local chart paths starting with ./', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        './helm/lc-apps',
        'my-release',
        'my-namespace',
        [],
        [],
        ChartType.LOCAL,
        undefined, // args
        undefined // chartRepoUrl
        // no defaultArgs
      );

      expect(result).toContain(' ./helm/lc-apps');
      expect(result).not.toContain('././helm/lc-apps');
    });

    it('should not double prefix value files starting with ./', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        './helm/lc-apps',
        'my-release',
        'my-namespace',
        [],
        ['./values/prod.yaml', 'values/dev.yaml'],
        ChartType.LOCAL,
        undefined, // args
        undefined // chartRepoUrl
        // no defaultArgs
      );

      expect(result).toContain('-f ./values/prod.yaml');
      expect(result).toContain('-f ./values/dev.yaml');
      expect(result).not.toContain('-f ././values/prod.yaml');
    });

    it('should handle multiple custom values and value files', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key1=value1', 'key2=value2'],
        ['values1.yaml', 'values2.yaml'],
        ChartType.PUBLIC,
        undefined, // args
        undefined // chartRepoUrl
        // no defaultArgs
      );

      expect(result).toContain('--set "key1=value1"');
      expect(result).toContain('--set "key2=value2"');
      expect(result).toContain('-f values1.yaml');
      expect(result).toContain('-f values2.yaml');
    });

    it('should use custom args from global_config when provided', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        '--force --timeout 60m0s --wait', // explicit args
        undefined // chartRepoUrl
        // defaultArgs not needed when args is provided
      );

      expect(result).toContain('helm upgrade --install my-release my-chart');
      expect(result).toContain('--namespace my-namespace');
      expect(result).toContain('--set "key=value"');
      expect(result).toContain('-f values.yaml');
      expect(result).toContain('--force --timeout 60m0s --wait');
      expect(result).not.toContain('--wait --timeout 30m');
    });

    it('should use defaultArgs from helmDefaults when no custom args provided', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        undefined, // args
        undefined, // chartRepoUrl
        '--wait --timeout 45m' // defaultArgs from helmDefaults
      );

      expect(result).toContain('--wait --timeout 45m');
      expect(result).not.toContain('--wait --timeout 30m');
    });

    it('should combine defaultArgs with explicit args', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        '--timeout 60m', // explicit args (overrides default timeout)
        undefined, // chartRepoUrl
        '--wait --timeout 30m' // defaultArgs
      );

      // Should have both defaultArgs and args, with args coming last
      expect(result).toContain('--wait --timeout 30m --timeout 60m');
      // The effective timeout will be 60m (last one wins)
    });

    it('should use only defaultArgs when no explicit args provided', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        undefined, // args
        undefined, // chartRepoUrl
        '--wait --timeout 45m' // defaultArgs from helmDefaults
      );

      expect(result).toContain('--wait --timeout 45m');
    });

    it('should work with no args at all', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC
        // no args, no chartRepoUrl, no defaultArgs
      );

      // Should not have any helm args
      expect(result).not.toContain('--wait');
      expect(result).not.toContain('--timeout');
    });

    it('should use only explicit args when no defaultArgs provided', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'my-chart',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        '--force --timeout 60m0s --wait', // explicit args
        undefined // chartRepoUrl
        // no defaultArgs
      );

      expect(result).toContain('--force --timeout 60m0s --wait');
      expect(result).not.toContain('--timeout 30m');
    });

    it('should handle OCI chart URLs correctly', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'postgresql',
        'my-release',
        'my-namespace',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        undefined,
        'oci://registry-1.docker.io/bitnamicharts/postgresql'
      );

      expect(result).toContain('helm upgrade --install my-release oci://registry-1.docker.io/bitnamicharts/postgresql');
      expect(result).toContain('--namespace my-namespace');
      expect(result).toContain('--set "key=value"');
      expect(result).toContain('-f values.yaml');
    });

    it('should handle OCI charts with custom args', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'postgresql',
        'my-release',
        'my-namespace',
        ['auth.username=admin', 'auth.password=secret'],
        [],
        ChartType.PUBLIC,
        '--wait',
        'oci://ghcr.io/myorg/charts/postgresql',
        undefined,
        '12.9.0'
      );

      expect(result).toContain('helm upgrade --install my-release oci://ghcr.io/myorg/charts/postgresql');
      expect(result).toContain('--namespace my-namespace');
      expect(result).toContain('--version 12.9.0');
      expect(result).toContain('--set "auth.username=admin"');
      expect(result).toContain('--set "auth.password=secret"');
      expect(result).toContain('--wait');
    });

    it('should add chart version for PUBLIC charts when version is specified', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'bitnami/postgresql',
        'my-release',
        'my-namespace',
        ['auth.username=postgres_user'],
        [],
        ChartType.PUBLIC,
        undefined,
        'https://charts.bitnami.com/bitnami',
        undefined,
        '12.9.0'
      );

      expect(result).toContain('helm upgrade --install my-release bitnami/postgresql');
      expect(result).toContain('--namespace my-namespace');
      expect(result).toContain('--version 12.9.0');
      expect(result).toContain('--set "auth.username=postgres_user"');
    });

    it('should not add chart version for LOCAL charts even when version is specified', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        './my-local-chart',
        'my-release',
        'my-namespace',
        [],
        [],
        ChartType.LOCAL,
        undefined,
        undefined,
        undefined,
        '1.0.0'
      );

      expect(result).toContain('helm upgrade --install my-release ./my-local-chart');
      expect(result).toContain('--namespace my-namespace');
      expect(result).not.toContain('--version');
    });

    it('should not add chart version for PUBLIC charts when version is not specified', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'bitnami/postgresql',
        'my-release',
        'my-namespace',
        [],
        [],
        ChartType.PUBLIC,
        undefined,
        'https://charts.bitnami.com/bitnami'
      );

      expect(result).toContain('helm upgrade --install my-release bitnami/postgresql');
      expect(result).toContain('--namespace my-namespace');
      expect(result).not.toContain('--version');
    });

    it('should add chart version for ORG_CHART when version is specified', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'helm-app',
        'my-release',
        'my-namespace',
        ['deployment.appImage=myapp:latest'],
        [],
        ChartType.ORG_CHART,
        undefined,
        'cm://h.cfcr.io/helm/default',
        undefined,
        '2.0.9'
      );

      expect(result).toContain('helm upgrade --install my-release helm-app');
      expect(result).toContain('--namespace my-namespace');
      expect(result).toContain('--version 2.0.9');
      expect(result).toContain('--set "deployment.appImage=myapp:latest"');
    });

    it('should not add chart version for ORG_CHART when version is not specified', () => {
      const result = constructHelmCommand(
        'upgrade --install',
        'helm-app',
        'my-release',
        'my-namespace',
        [],
        [],
        ChartType.ORG_CHART,
        undefined,
        'cm://h.cfcr.io/helm/default'
      );

      expect(result).toContain('helm upgrade --install my-release helm-app');
      expect(result).toContain('--namespace my-namespace');
      expect(result).not.toContain('--version');
    });
  });

  describe('createHelmContainer', () => {
    it('should create helm container with correct configuration', async () => {
      const result = await createHelmContainer(
        'org/repo',
        'my-chart',
        'my-release',
        'my-namespace',
        '3.12.0',
        ['key=value'],
        ['values.yaml'],
        ChartType.PUBLIC,
        '--force --timeout 60m0s --wait',
        'https://charts.example.com',
        '--wait --timeout 30m',
        '1.2.3'
      );

      expect(result.name).toBe('helm-deploy');
      expect(result.image).toBe('alpine/helm:3.12.0');
      expect(result.env).toEqual([
        { name: 'HELM_CACHE_HOME', value: '/workspace/.helm/cache' },
        { name: 'HELM_CONFIG_HOME', value: '/workspace/.helm/config' },
      ]);
      expect(result.command).toEqual(['/bin/sh', '-c']);
      expect(result.args).toHaveLength(1);
      expect(result.args[0]).toContain('helm upgrade --install');
      expect(result.args[0]).toContain('--force --timeout 60m0s --wait');
    });
  });

  describe('envMapping for LOCAL charts', () => {
    beforeEach(() => {
      mockGetAllConfigs.mockResolvedValue({});
    });

    it('should transform env vars to array format when envMapping.app.format is array', async () => {
      const deploy = {
        uuid: 'test-uuid',
        env: {
          CLIENT_HOST: 'grpc-echo:8080',
          TEST_TEST: 'test',
          WHAT: 'is-this',
        },
        deployable: {
          buildUUID: 'build-123',
          helm: {
            chart: { name: './helm/lc-apps' },
            docker: {
              app: {},
            },
            envMapping: {
              app: {
                format: 'array',
                path: 'deployment.env',
              },
            },
          },
        },
        build: {
          commentRuntimeEnv: {},
        },
      } as any;

      const customValues = await constructHelmCustomValues(deploy, ChartType.LOCAL);

      expect(customValues).toContain('deployment.env[0].name=CLIENT_HOST');
      expect(customValues).toContain('deployment.env[0].value=grpc-echo:8080');
      expect(customValues).toContain('deployment.env[1].name=TEST_TEST');
      expect(customValues).toContain('deployment.env[1].value=test');
      expect(customValues).toContain('deployment.env[2].name=WHAT');
      expect(customValues).toContain('deployment.env[2].value=is-this');
    });

    it('should transform env vars to map format when envMapping.app.format is map', async () => {
      const deploy = {
        uuid: 'test-uuid',
        env: {
          CLIENT_HOST: 'grpc-echo:8080',
          TEST_TEST: 'test',
          WHAT_IS_THIS: 'value',
        },
        deployable: {
          buildUUID: 'build-123',
          helm: {
            chart: { name: './helm/lc-apps' },
            docker: {
              app: {},
            },
            envMapping: {
              app: {
                format: 'map',
                path: 'deployment.envVars',
              },
            },
          },
        },
        build: {
          commentRuntimeEnv: {},
        },
      } as any;

      const customValues = await constructHelmCustomValues(deploy, ChartType.LOCAL);

      expect(customValues).toContain('deployment.envVars.CLIENT__HOST="grpc-echo:8080"');
      expect(customValues).toContain('deployment.envVars.TEST__TEST="test"');
      expect(customValues).toContain('deployment.envVars.WHAT__IS__THIS="value"');
    });

    it('should handle init env vars with array format', async () => {
      const deploy = {
        uuid: 'test-uuid',
        env: {},
        initEnv: {
          INIT_DB: 'true',
          MIGRATION_PATH: '/migrations',
        },
        deployable: {
          buildUUID: 'build-123',
          helm: {
            chart: { name: './helm/lc-apps' },
            docker: {
              init: {},
            },
            envMapping: {
              init: {
                format: 'array',
                path: 'deployment.initContainers[0].env',
              },
            },
          },
        },
        build: {
          commentRuntimeEnv: {},
        },
      } as any;

      const customValues = await constructHelmCustomValues(deploy, ChartType.LOCAL);

      expect(customValues).toContain('deployment.initContainers[0].env[0].name=INIT_DB');
      expect(customValues).toContain('deployment.initContainers[0].env[0].value=true');
      expect(customValues).toContain('deployment.initContainers[0].env[1].name=MIGRATION_PATH');
      expect(customValues).toContain('deployment.initContainers[0].env[1].value=/migrations');
    });

    it('should handle both app and init env vars', async () => {
      const deploy = {
        uuid: 'test-uuid',
        env: {
          APP_ENV: 'production',
        },
        initEnv: {
          INIT_ENV: 'setup',
        },
        deployable: {
          buildUUID: 'build-123',
          helm: {
            chart: { name: './helm/lc-apps' },
            docker: {
              app: {},
              init: {},
            },
            envMapping: {
              app: {
                format: 'map',
                path: 'app.env',
              },
              init: {
                format: 'array',
                path: 'init.env',
              },
            },
          },
        },
        build: {
          commentRuntimeEnv: {},
        },
      } as any;

      const customValues = await constructHelmCustomValues(deploy, ChartType.LOCAL);

      expect(customValues).toContain('app.env.APP__ENV="production"');
      expect(customValues).toContain('init.env[0].name=INIT_ENV');
      expect(customValues).toContain('init.env[0].value=setup');
    });

    it('should merge runtime env vars with precedence', async () => {
      const deploy = {
        uuid: 'test-uuid',
        env: {
          ENV_FROM_DB: 'db-value',
          OVERRIDE_ME: 'db-value',
        },
        deployable: {
          buildUUID: 'build-123',
          helm: {
            chart: { name: './helm/lc-apps' },
            docker: {
              app: {},
            },
            envMapping: {
              app: {
                format: 'map',
                path: 'env',
              },
            },
          },
        },
        build: {
          commentRuntimeEnv: {
            OVERRIDE_ME: 'yaml-value',
            NEW_ENV: 'yaml-only',
          },
        },
      } as any;

      const customValues = await constructHelmCustomValues(deploy, ChartType.LOCAL);

      expect(customValues).toContain('env.ENV__FROM__DB="db-value"');
      expect(customValues).toContain('env.OVERRIDE__ME="yaml-value"'); // yaml takes precedence
      expect(customValues).toContain('env.NEW__ENV="yaml-only"');
    });

    it('should not add env vars if envMapping is not specified', async () => {
      const deploy = {
        uuid: 'test-uuid',
        env: {
          SHOULD_NOT_APPEAR: 'value',
        },
        deployable: {
          buildUUID: 'build-123',
          helm: {
            chart: { name: './helm/lc-apps' },
            docker: {
              app: {},
            },
            // No envMapping specified
          },
        },
        build: {
          commentRuntimeEnv: {},
        },
      } as any;

      const customValues = await constructHelmCustomValues(deploy, ChartType.LOCAL);

      expect(customValues).not.toContain('SHOULD_NOT_APPEAR');
      expect(customValues).toContain('fullnameOverride=test-uuid');
      expect(customValues).toContain('commonLabels.name=build-123');
    });
  });

  describe('Chart Version Integration', () => {
    it('should include chart version from global config for PUBLIC charts', async () => {
      mockGetAllConfigs.mockResolvedValue({
        postgresql: {
          version: '3.7.2',
          chart: {
            name: 'postgresql',
            repoUrl: 'https://charts.bitnami.com/bitnami',
            version: '12.9.0',
            values: ['auth.username=postgres_user'],
          },
        },
      });

      const result = await createHelmContainer(
        'no-repo',
        'postgresql',
        'test-release',
        'test-namespace',
        '3.12.0',
        ['auth.username=postgres_user'],
        [],
        ChartType.PUBLIC,
        undefined,
        'https://charts.bitnami.com/bitnami',
        undefined,
        '12.9.0'
      );

      expect(result.args[0]).toContain('--version 12.9.0');
      expect(result.args[0]).toContain('bitnami/postgresql');
    });

    it('should include chart version from global config for ORG_CHART', async () => {
      mockGetOrgChartName.mockResolvedValue('helm-app');
      mockGetAllConfigs.mockResolvedValue({
        'helm-app': {
          version: '3.7.2',
          chart: {
            name: 'helm-app',
            repoUrl: 'cm://h.cfcr.io/helm/default',
            version: '2.0.9',
            values: ['deployment.customNodeAffinity.enabled=true'],
          },
        },
      });

      const deploy = {
        uuid: 'test-uuid',
        dockerImage: 'myapp:v1.2.3',
        env: {},
        deployable: {
          buildUUID: 'build-123',
          helm: {
            chart: { name: 'helm-app' },
            docker: { app: {} },
          },
        },
        build: {
          commentRuntimeEnv: {},
        },
      } as any;

      const chartType = await determineChartType(deploy);
      expect(chartType).toBe(ChartType.ORG_CHART);

      const result = await createHelmContainer(
        'no-repo',
        'helm-app',
        'test-release',
        'test-namespace',
        '3.7.2',
        ['deployment.appImage=myapp:v1.2.3', 'version=v1.2.3'],
        [],
        ChartType.ORG_CHART,
        undefined,
        'cm://h.cfcr.io/helm/default',
        undefined,
        '2.0.9'
      );

      expect(result.args[0]).toContain('--version 2.0.9');
      expect(result.args[0]).toContain('helm-app');
    });
  });
});
