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
import { DeployTypes } from 'shared/constants';
import { QueryBuilder } from 'objection';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';

jest.mock('server/database');

jest.mock('server/services/globalConfig');

import GlobalConfigService from 'server/services/globalConfig';
import { IServices } from 'server/services/types';

const mockedGetAllConfigs = jest.fn().mockResolvedValue({
  lifecycleDefaults: {
    defaultUUID: 'mockedUUID',
    defaultPublicUrl: 'mockedPublicUrl',
  },
});

const mockedInstance = {
  getAllConfigs: mockedGetAllConfigs,
};

(GlobalConfigService.getInstance as jest.Mock).mockReturnValue(mockedInstance);

function createTestingDeploy(
  service: {
    name: string;
    type: DeployTypes;
    hostPortMapping?: string;
    defaultUUID?: string;
    port?: string;
  },
  deployable: {
    name: string;
    type: DeployTypes;
    defaultUUID?: string;
    port?: string;
  },
  build: {
    uuid: string;
    pullRequest: {
      pullRequestNumber: number;
    };
    enableFullYamlSupport: boolean;
    namespace: string;
  },
  active: boolean,
  properties: {
    branchName: string;
    ipAddress: string;
    publicUrl: string;
    internalHostname: string;
    dockerImage: string;
    sha: string;
  }
): models.Deploy {
  const deploy: models.Deploy = new models.Deploy();
  deploy.service = new models.Service();
  deploy.uuid = `${service.name}-${build.uuid}`;
  deploy.serviceId = 100;
  deploy.service.name = service.name;
  deploy.service.type = service.type;
  deploy.service.defaultUUID = service.defaultUUID;
  deploy.service.port = service.port;
  deploy.active = active;
  deploy.deployableId = null;

  deploy.deployable = new models.Deployable();
  deploy.deployableId = 23000;
  deploy.deployable.name = deployable.name;
  deploy.deployable.type = deployable.type;
  deploy.deployable.defaultUUID = deployable.defaultUUID;
  deploy.deployable.port = deployable.port;

  if (active) {
    deploy.branchName = properties.branchName;
    deploy.ipAddress = properties.ipAddress;
    deploy.publicUrl = properties.publicUrl;
    deploy.internalHostname = properties.internalHostname;
    deploy.dockerImage = properties.dockerImage;
    deploy.sha = properties.sha;
    deploy.build = new models.Build();
    deploy.build.uuid = build.uuid;
  } else {
    deploy.service.defaultPublicUrl = properties.publicUrl;
    deploy.service.defaultInternalHostname = properties.internalHostname;
  }

  return deploy;
}

function createTestingDeploys(): models.Deploy[] {
  const deployConfigType: models.Deploy = createTestingDeploy(
    { name: 'auth0', type: DeployTypes.CONFIGURATION },
    { name: 'auth0', type: DeployTypes.CONFIGURATION },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    true,
    {
      branchName: null,
      ipAddress: null,
      publicUrl: null,
      internalHostname: null,
      dockerImage: null,
      sha: '8760ffff110',
    }
  );

  const deployGithubTypeActive: models.Deploy = createTestingDeploy(
    {
      name: 'web-frontend',
      type: DeployTypes.GITHUB,
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      name: 'web-frontend',
      type: DeployTypes.GITHUB,
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    true,
    {
      branchName: 'master',
      ipAddress: null,
      publicUrl: 'wf-black-hat-305104.lifecycle.dev.example.com',
      internalHostname: 'wf-black-hat-305104',
      dockerImage: null,
      sha: 'c7ff56001a',
    }
  );

  const deployGithubTypeInactive: models.Deploy = createTestingDeploy(
    {
      name: 'good-web',
      type: DeployTypes.GITHUB,
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      name: 'good-web',
      type: DeployTypes.GITHUB,
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    false,
    {
      branchName: 'main',
      ipAddress: null,
      publicUrl: 'good-web-pool-fun-234007.lifecycle.dev.example.com',
      internalHostname: 'good-web-pool-fun-234007',
      dockerImage: null,
      sha: '90132aaa',
    }
  );
  const deployGithubTypeWithOddUUID: models.Deploy = createTestingDeploy(
    {
      name: 'bad-web',
      type: DeployTypes.GITHUB,
      defaultUUID: 'chonkey-monkey-dev-0',
      port: '4444',
    },
    {
      name: 'bad-web',
      type: DeployTypes.GITHUB,
      defaultUUID: 'chonkey-monkey-dev-0',
      port: '4444',
    },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    false,
    {
      branchName: 'main',
      ipAddress: null,
      publicUrl: 'bad-web-chonkey-monkey-dev-0.lifecycle.dev.example.com',
      internalHostname: 'chonkey-monkey-dev-0',
      dockerImage: null,
      sha: '8ajdf23',
    }
  );
  const deployGithubTypeActiveWithPortMapping: models.Deploy = createTestingDeploy(
    {
      name: 'mdb-app',
      type: DeployTypes.GITHUB,
      hostPortMapping: '{"admin": "9991", "callback":"9990", "web": "8080"}',
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      name: 'mdb-app',
      type: DeployTypes.GITHUB,
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    true,
    {
      branchName: 'master',
      ipAddress: null,
      publicUrl: 'web-mdb-app-mock-test-12345.lifecycle.dev.example.com',
      internalHostname: 'web-mdb-app-mock-test-12345.lifecycle.dev.example.com',
      dockerImage: null,
      sha: 'c7ff56001a',
    }
  );
  const deployDockerType: models.Deploy = createTestingDeploy(
    {
      name: 'nginx',
      type: DeployTypes.DOCKER,
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      name: 'nginx',
      type: DeployTypes.DOCKER,
      defaultUUID: 'dev-0',
      port: '4444',
    },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    true,
    {
      branchName: null,
      ipAddress: null,
      publicUrl: 'nginx-foo-bar-307777.lifecycle.dev.example.com',
      internalHostname: 'nginx-foo-bar-307777',
      dockerImage: 'nginx:latest',
      sha: 'a457000991',
    }
  );
  const deployExternalHttpType: models.Deploy = createTestingDeploy(
    {
      name: 'bond',
      type: DeployTypes.EXTERNAL_HTTP,
      defaultUUID: 'dev-0',
    },
    {
      name: 'bond',
      type: DeployTypes.EXTERNAL_HTTP,
      defaultUUID: 'dev-0',
    },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    true,
    {
      branchName: null,
      ipAddress: null,
      publicUrl: 'bond-sun-rise-212340.lifecycle.dev.example.com',
      internalHostname: 'bond-sun-rise-212340',
      dockerImage: null,
      sha: '1077a499f',
    }
  );
  const deployCodefreshType: models.Deploy = createTestingDeploy(
    { name: 'fastly', type: DeployTypes.CODEFRESH, defaultUUID: 'dev-0' },
    { name: 'fastly', type: DeployTypes.CODEFRESH, defaultUUID: 'dev-0' },
    {
      uuid: 'mock-test-12345',
      pullRequest: { pullRequestNumber: 1234567 },
      enableFullYamlSupport: false,
      namespace: 'testns',
    },
    true,
    {
      branchName: 'main',
      ipAddress: null,
      publicUrl: 'fastly-mock-test-12345.fastly.lifecycle.dev.example.com',
      internalHostname: 'fastly-mock-test-12345.fastly.lifecycle.dev.example.com',
      dockerImage: null,
      sha: '77099bc44',
    }
  );

  const mockDeploys: models.Deploy[] = [
    deployConfigType,
    deployGithubTypeActive,
    deployGithubTypeInactive,
    deployGithubTypeWithOddUUID,
    deployGithubTypeActiveWithPortMapping,
    deployDockerType,
    deployExternalHttpType,
    deployCodefreshType,
  ];

  return mockDeploys;
}

describe('EnvironmentVariables', () => {
  const db = new Database();
  const globalConfigService = GlobalConfigService.getInstance();
  const buildService = { getNamespace: jest.fn().mockResolvedValue('testns') };

  db.services = { GlobalConfig: globalConfigService, BuildService: buildService } as unknown as IServices;
  db.models = models;
  describe('buildEnvironmentVariableDictionary', () => {
    const build: models.Build = new models.Build();
    build.uuid = 'f7890a7cc';
    build.sha = 'aa7511ca3';
    const configuration: Record<string, any> = {
      KEY1: '83ofdofh3',
      KEY2: 'hd943749fhj',
    };
    const result = {
      id: 2,
      key: 'dev-default',
      serviceId: '47',
      service: null,
      data: configuration,
    };

    const mockDeploys: models.Deploy[] = createTestingDeploys();

    const configurationQueryBuilder = QueryBuilder.forClass(models.Configuration);
    configurationQueryBuilder.where = jest.fn().mockImplementation(() => configurationQueryBuilder.resolve(result));
    jest.spyOn(models.Configuration, 'query').mockImplementation(() => configurationQueryBuilder.resolve(result));

    const envVariables = new BuildEnvironmentVariables(db);

    test('retrieving all environment variables for all the deploys', async () => {
      expect(
        await envVariables.buildEnvironmentVariableDictionary(
          mockDeploys,
          mockDeploys[0].build.uuid,
          false,
          mockDeploys[0].build
        )
      ).toEqual({
        KEY1: '83ofdofh3',
        KEY2: 'hd943749fhj',
        bad______web_UUID: 'chonkey-monkey-dev-0',
        bad______web_branchName: '',
        bad______web_dockerImage: '',
        bad______web_initDockerImage: '',
        bad______web_internalHostname: 'chonkey-monkey-dev-0',
        bad______web_ipAddress: '',
        bad______web_namespace: '',
        bad______web_publicUrl: 'bad-web-chonkey-monkey-dev-0.lifecycle.dev.example.com',
        bad______web_sha: '',
        bond_branchName: null,
        bond_UUID: 'mock-test-12345',
        bond_dockerImage: null,
        bond_initDockerImage: undefined,
        bond_internalHostname: 'bond-sun-rise-212340',
        bond_ipAddress: null,
        bond_namespace: undefined,
        bond_publicUrl: 'bond-sun-rise-212340.lifecycle.dev.example.com',
        bond_sha: '1077a499f',
        web______frontend_branchName: 'master',
        web______frontend_UUID: 'mock-test-12345',
        web______frontend_dockerImage: null,
        web______frontend_initDockerImage: undefined,
        web______frontend_internalHostname: 'wf-black-hat-305104',
        web______frontend_ipAddress: null,
        web______frontend_namespace: undefined,
        web______frontend_publicUrl: 'wf-black-hat-305104.lifecycle.dev.example.com',
        web______frontend_sha: 'c7ff56001a',
        fastly_branchName: 'main',
        fastly_UUID: 'mock-test-12345',
        fastly_dockerImage: null,
        fastly_initDockerImage: undefined,
        fastly_internalHostname: 'fastly-mock-test-12345.fastly.lifecycle.dev.example.com',
        fastly_ipAddress: null,
        fastly_namespace: undefined,
        fastly_publicUrl: 'fastly-mock-test-12345.fastly.lifecycle.dev.example.com',
        fastly_sha: '77099bc44',
        good______web_branchName: '',
        good______web_UUID: 'dev-0',
        good______web_dockerImage: '',
        good______web_initDockerImage: '',
        good______web_internalHostname: 'good-web-pool-fun-234007',
        good______web_ipAddress: '',
        good______web_namespace: '',
        good______web_publicUrl: 'good-web-pool-fun-234007.lifecycle.dev.example.com',
        good______web_sha: '',
        mdb______app_branchName: 'master',
        mdb______app_UUID: 'mock-test-12345',
        mdb______app_dockerImage: null,
        mdb______app_initDockerImage: undefined,
        mdb______app_internalHostname: 'web-mdb-app-mock-test-12345.lifecycle.dev.example.com',
        mdb______app_ipAddress: null,
        mdb______app_namespace: undefined,
        mdb______app_publicUrl: 'web-mdb-app-mock-test-12345.lifecycle.dev.example.com',
        mdb______app_sha: 'c7ff56001a',
        nginx_branchName: null,
        nginx_UUID: 'mock-test-12345',
        nginx_dockerImage: 'nginx:latest',
        nginx_initDockerImage: undefined,
        nginx_internalHostname: 'nginx-foo-bar-307777',
        nginx_ipAddress: null,
        nginx_namespace: undefined,
        nginx_publicUrl: 'nginx-foo-bar-307777.lifecycle.dev.example.com',
        nginx_sha: 'a457000991',
      });
    });

    test('retrieving all environment variables for all the deploys with additional variables', async () => {
      expect(
        await envVariables.buildEnvironmentVariableDictionary(
          mockDeploys,
          mockDeploys[0].build.uuid,
          false,
          mockDeploys[0].build,
          {
            buildUUID: 'mock-test-12345',
            buildSHA: 'abcdef',
            pullRequestNumber: '12345',
            namespace: 'testns',
          }
        )
      ).toEqual({
        KEY1: '83ofdofh3',
        KEY2: 'hd943749fhj',
        bad______web_UUID: 'chonkey-monkey-dev-0',
        bad______web_branchName: '',
        bad______web_dockerImage: '',
        bad______web_initDockerImage: '',
        bad______web_internalHostname: 'chonkey-monkey-dev-0',
        bad______web_ipAddress: '',
        bad______web_namespace: '',
        bad______web_publicUrl: 'bad-web-chonkey-monkey-dev-0.lifecycle.dev.example.com',
        bad______web_sha: '',
        bond_branchName: null,
        bond_UUID: 'mock-test-12345',
        bond_dockerImage: null,
        bond_initDockerImage: undefined,
        bond_internalHostname: 'bond-sun-rise-212340',
        bond_ipAddress: null,
        bond_namespace: undefined,
        bond_publicUrl: 'bond-sun-rise-212340.lifecycle.dev.example.com',
        bond_sha: '1077a499f',
        web______frontend_branchName: 'master',
        web______frontend_UUID: 'mock-test-12345',
        web______frontend_dockerImage: null,
        web______frontend_initDockerImage: undefined,
        web______frontend_internalHostname: 'wf-black-hat-305104',
        web______frontend_ipAddress: null,
        web______frontend_namespace: undefined,
        web______frontend_publicUrl: 'wf-black-hat-305104.lifecycle.dev.example.com',
        web______frontend_sha: 'c7ff56001a',
        fastly_branchName: 'main',
        fastly_UUID: 'mock-test-12345',
        fastly_dockerImage: null,
        fastly_initDockerImage: undefined,
        fastly_internalHostname: 'fastly-mock-test-12345.fastly.lifecycle.dev.example.com',
        fastly_ipAddress: null,
        fastly_namespace: undefined,
        fastly_publicUrl: 'fastly-mock-test-12345.fastly.lifecycle.dev.example.com',
        fastly_sha: '77099bc44',
        good______web_branchName: '',
        good______web_UUID: 'dev-0',
        good______web_dockerImage: '',
        good______web_initDockerImage: '',
        good______web_internalHostname: 'good-web-pool-fun-234007',
        good______web_ipAddress: '',
        good______web_namespace: '',
        good______web_publicUrl: 'good-web-pool-fun-234007.lifecycle.dev.example.com',
        good______web_sha: '',
        mdb______app_branchName: 'master',
        mdb______app_UUID: 'mock-test-12345',
        mdb______app_dockerImage: null,
        mdb______app_initDockerImage: undefined,
        mdb______app_internalHostname: 'web-mdb-app-mock-test-12345.lifecycle.dev.example.com',
        mdb______app_ipAddress: null,
        mdb______app_namespace: undefined,
        mdb______app_publicUrl: 'web-mdb-app-mock-test-12345.lifecycle.dev.example.com',
        mdb______app_sha: 'c7ff56001a',
        nginx_branchName: null,
        nginx_UUID: 'mock-test-12345',
        nginx_dockerImage: 'nginx:latest',
        nginx_initDockerImage: undefined,
        nginx_internalHostname: 'nginx-foo-bar-307777',
        nginx_ipAddress: null,
        nginx_namespace: undefined,
        nginx_publicUrl: 'nginx-foo-bar-307777.lifecycle.dev.example.com',
        nginx_sha: 'a457000991',
        buildSHA: 'abcdef',
        buildUUID: 'mock-test-12345',
        pullRequestNumber: '12345',
        namespace: 'testns',
      });
    });
  });

  describe('configurationServiceEnvironments', () => {
    const configuration: Record<string, any> = {
      KEY1: '83ofdofh3',
      KEY2: 'hd943749fhj',
    };
    const result = {
      id: 2,
      key: 'dev-default',
      serviceId: '47',
      service: null,
      data: configuration,
    };
    const configurationBuilder = QueryBuilder.forClass(models.Configuration);
    configurationBuilder.where = jest.fn().mockImplementation(() => configurationBuilder.resolve(result));
    jest.spyOn(models.Configuration, 'query').mockImplementation(() => configurationBuilder.resolve(result));

    const db: Database = new Database();
    db.models = models;

    const envVariables = new BuildEnvironmentVariables(db);

    test('retrieving configurations for configuration deploy type', async () => {
      expect(await envVariables.configurationServiceEnvironments(createTestingDeploys(), false)).toEqual([
        configuration,
      ]);
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
