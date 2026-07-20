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

import Database from 'server/database';
import * as models from 'server/models';
import { DeployTypes, FeatureFlags, NO_DEFAULT_ENV_UUID } from 'shared/constants';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';

jest.mock('server/database');

const mockGetAllConfigs = jest.fn().mockResolvedValue({
  lifecycleDefaults: {
    defaultUUID: 'mockedUUID',
    defaultPublicUrl: 'mockedPublicUrl',
  },
});

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: mockGetAllConfigs,
    })),
  },
}));

jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfigByRepository: jest.fn(),
  getDeployingServicesByName: jest.fn(),
  getEnvironmentVariables: jest.fn(),
  getInitEnvironmentVariables: jest.fn(),
}));

import GlobalConfigService from 'server/services/globalConfig';
import { IServices } from 'server/services/types';

describe('EnvironmentVariables', () => {
  const db = new Database();
  const globalConfigService = GlobalConfigService.getInstance();
  const buildService = { getNamespace: jest.fn().mockResolvedValue('testns') };

  db.services = { GlobalConfig: globalConfigService, BuildService: buildService } as unknown as IServices;
  db.models = models;
  describe('buildEnvironmentVariableDictionary', () => {
    const envVariables = new BuildEnvironmentVariables(db);

    test('can skip no-default env resolve when building non-env-template contexts', async () => {
      const inactiveDeploy = new models.Deploy();
      inactiveDeploy.active = false;
      inactiveDeploy.deployable = new models.Deployable();
      inactiveDeploy.deployable.name = 'inactive-web';
      inactiveDeploy.deployable.type = DeployTypes.GITHUB;
      inactiveDeploy.deployable.defaultUUID = 'dev-0';
      inactiveDeploy.deployable.defaultPublicUrl = 'inactive-web-dev-0.lifecycle.dev.example.com';
      inactiveDeploy.deployable.defaultInternalHostname = 'inactive-web-dev-0';

      const buildWithNoDefaultResolve = new models.Build();
      buildWithNoDefaultResolve.uuid = 'mock-test-12345';
      buildWithNoDefaultResolve.enabledFeatures = [FeatureFlags.NO_DEFAULT_ENV_RESOLVE];

      await expect(
        envVariables.buildEnvironmentVariableDictionary([inactiveDeploy], buildWithNoDefaultResolve)
      ).resolves.toMatchObject({
        inactive______web_internalHostname: NO_DEFAULT_ENV_UUID,
      });

      await expect(
        envVariables.buildEnvironmentVariableDictionary([inactiveDeploy], buildWithNoDefaultResolve, undefined, {
          applyNoDefaultEnvResolveFeatureFlag: false,
        })
      ).resolves.toMatchObject({
        inactive______web_internalHostname: 'inactive-web-dev-0',
      });
    });
  });

  describe('compileEnvironmentWithAvailableEnvironment', () => {
    const envVariables = new BuildEnvironmentVariables(db);
    const availableVars: Record<string, any> = {
      buildUUID: '3749374979f',
      buildSHA: 'c4997f97a9',
    };

    test('replace all variable values in the template', async () => {
      const buildArgs: string = '{"BUILD_SHA":"{{buildSHA}}","BUILD_UUID":"{{buildUUID}}"}';

      expect(
        await envVariables.compileEnvironmentWithAvailableEnvironment(buildArgs, availableVars, false, 'testns')
      ).toEqual('{"BUILD_SHA":"c4997f97a9","BUILD_UUID":"3749374979f"}');
    });

    test('replace some variable values in the template', async () => {
      const buildArgs: string = '{"BUILD_SHA":"{{buildSHA}}","BUILD_UUID":"{{buildUUID}}","NAME":"{{fullName}}"}';
      const result: string = '{"BUILD_SHA":"c4997f97a9","BUILD_UUID":"3749374979f","NAME":""}';

      expect(
        await envVariables.compileEnvironmentWithAvailableEnvironment(buildArgs, availableVars, false, 'testns')
      ).toEqual(result);
    });

    test('replace some variable values with static values in the template', async () => {
      const buildArgs: string =
        '{"BUILD_SHA":"{{buildSHA}}","BUILD_UUID":"{{buildUUID}}","NAME":"{{fullName}}","REPO_NAME":"org/lifecycle"}';
      const result: string =
        '{"BUILD_SHA":"c4997f97a9","BUILD_UUID":"3749374979f","NAME":"","REPO_NAME":"org/lifecycle"}';

      expect(
        await envVariables.compileEnvironmentWithAvailableEnvironment(buildArgs, availableVars, false, 'testns')
      ).toEqual(result);
    });

    test('empty template', async () => {
      const buildArgs: string = '';
      const result: string = '';

      expect(
        await envVariables.compileEnvironmentWithAvailableEnvironment(buildArgs, availableVars, false, 'testns')
      ).toEqual(result);
    });

    test('empty json template', async () => {
      const buildArgs: string = '{}';
      const result: string = '{}';

      expect(
        await envVariables.compileEnvironmentWithAvailableEnvironment(buildArgs, availableVars, false, 'testns')
      ).toEqual(result);
    });

    test('template with initDockerImage variable', async () => {
      const buildArgs: string = '{"APP_IMAGE":"{{nginx_dockerImage}}","INIT_IMAGE":"{{nginx_initDockerImage}}"}';
      const availableVarsWithInit = {
        ...availableVars,
        nginx_dockerImage: 'nginx:latest',
        nginx_initDockerImage: 'busybox:1.35',
      };

      expect(
        await envVariables.compileEnvironmentWithAvailableEnvironment(buildArgs, availableVarsWithInit, false, 'testns')
      ).toEqual('{"APP_IMAGE":"nginx:latest","INIT_IMAGE":"busybox:1.35"}');
    });
  });
});
