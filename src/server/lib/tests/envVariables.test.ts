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

import Database from 'server/database';
import { EnvironmentVariables } from '../envVariables';
import GlobalConfigService from 'server/services/globalConfig';
import { IServices } from 'server/services/types';
import * as models from 'server/models';
import { QueryBuilder } from 'objection';

jest.mock('server/database');
jest.mock('redlock', () => {
  return jest.fn().mockImplementation(() => ({}));
});
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    close: jest.fn(),
  })),
}));
jest.mock('ioredis', () => {
  const mockRedis = jest.fn().mockImplementation(() => ({
    duplicate: jest.fn(() => ({
      options: {},
      setMaxListeners: jest.fn(),
      hgetall: jest.fn().mockResolvedValue({
        lifecycleDefaults: JSON.stringify({
          defaultUUID: 'dev-0',
          defaultPublicUrl: 'dev-0.lifecycle.dev.example.com',
        }),
      }),
      hmset: jest.fn(),
      on: jest.fn(),
      info: jest.fn().mockResolvedValue('redis_version:6.0.5'),
    })),
    setMaxListeners: jest.fn(),
    hgetall: jest.fn().mockResolvedValue({
      lifecycleDefaults: JSON.stringify({
        defaultUUID: 'dev-0',
        defaultPublicUrl: 'dev-0.lifecycle.dev.example.com',
      }),
    }),
    hmset: jest.fn(),
    on: jest.fn(),
    info: jest.fn().mockResolvedValue('redis_version:6.0.5'),
    options: {},
  }));
  return mockRedis;
});

class TestEnvironmentVariables extends EnvironmentVariables {
  constructor(db: Database) {
    super(db);
  }

  public async resolve(): Promise<Record<string, any>> {
    return {};
  }
}

describe('EnvironmentVariables library', () => {
  const db = new Database();
  const globalConfigService = GlobalConfigService.getInstance();
  const buildService = { getNamespace: jest.fn().mockResolvedValue('testns') };

  db.services = { GlobalConfig: globalConfigService, BuildService: buildService } as unknown as IServices;
  db.models = models;
  const envVariables = new TestEnvironmentVariables(db);
  test('custom render uses global config default uuid', async () => {
    const template = JSON.stringify({
      VAR_1: '{{test______something_internalHostname}}',
      VAR_2: '{{test______something_internalPort}}',
      VAR_3: '{{test______3_internalHostname}}',
      VAR_4: 'test',
      VAR_5: '{{buildUUID}}',
    });

    const data = {
      test______something_internalHostname: 'test',
      test______something_internalPort: '1234',
    };

    const queryResult = {
      id: 2,
      key: 'defaultUUID',
      value: 'dev-0',
    };

    const globalConfigQueryBuilder = QueryBuilder.forClass(models.GlobalConfig);
    globalConfigQueryBuilder.where = jest.fn().mockImplementation(() => globalConfigQueryBuilder.resolve(queryResult));
    jest.spyOn(models.GlobalConfig, 'query').mockImplementation(() => globalConfigQueryBuilder.resolve(queryResult));

    const result = {
      VAR_1: 'test.testns.svc.cluster.local',
      VAR_2: '1234',
      VAR_3: 'test-3-dev-0.testns.svc.cluster.local',
      VAR_4: 'test',
      VAR_5: '',
    };

    const customRenderResult = JSON.parse(await envVariables.customRender(template, data, true, 'build-ns'));
    expect(customRenderResult).toEqual(result);
  });

  test('custom render uses global config default publicUrl', async () => {
    const template = JSON.stringify({
      VAR_1: '{{test______something_publicUrl}}',
      VAR_2: '{{test______something_internalPort}}',
      VAR_3: '{{test______3_publicUrl}}',
      VAR_4: 'test',
      VAR_5: '{{buildUUID}}',
      VAR_6: '{{{test______6_publicUrl}}}',
    });

    const data = {
      test______something_publicUrl: 'test',
      test______something_internalPort: '1234',
    };

    const queryResult = {
      id: 2,
      key: 'defaultPublicUrl',
      value: 'dev-0.lifecycle.dev.example.com',
    };

    const globalConfigQueryBuilder = QueryBuilder.forClass(models.GlobalConfig);
    globalConfigQueryBuilder.where = jest.fn().mockImplementation(() => globalConfigQueryBuilder.resolve(queryResult));
    jest.spyOn(models.GlobalConfig, 'query').mockImplementation(() => globalConfigQueryBuilder.resolve(queryResult));

    const result = {
      VAR_1: 'test',
      VAR_2: '1234',
      VAR_3: 'test-3-dev-0.lifecycle.dev.example.com',
      VAR_4: 'test',
      VAR_5: '',
      VAR_6: 'test-6-dev-0.lifecycle.dev.example.com',
    };

    const customRenderResult = JSON.parse(await envVariables.customRender(template, data, true, 'testns'));
    expect(customRenderResult).toEqual(result);
  });

  test('custom render accounts for internalHostname suffix and port', async () => {
    const template = JSON.stringify({
      COMPONENT: 'app',
      ENV: 'lifecycle',
      CACHE_SIMPLE: '{{{backend______cache_internalHostname}}}',
      CACHE_HOST: '{{backend______cache_internalHostname}}-master',
      CACHE_URL: '{{{backend______cache_internalHostname}}}:6379',
      CACHE_ME: '{{{backend______cache_internalHostname}}}-master:6379',
      DEFAULT_SIMPLE: '{{{backend______default_internalHostname}}}',
      DEFAULT_HOST: '{{{backend______default_internalHostname}}}-master',
      DEFAULT_URL: '{{backend______default_internalHostname}}:6379',
      DEFAULT_ME: '{{{backend______default_internalHostname}}}-master:6379',
      OPT_CACHE_SIMPLE: '{{{backend______optional______cache_internalHostname}}}',
      OPT_CACHE_HOST: '{{{backend______optional______cache_internalHostname}}}-master',
      OPT_CACHE_URL: '{{{backend______optional______cache_internalHostname}}}:6379',
      OPT_CACHE_ME: '{{backend______optional______cache_internalHostname}}-master:6379',
      BUILD_UUID: '{{{buildUUID}}}',
      PUBLIC_URL: '{{backend______cache_publicUrl}}',
      OPT_PUBLIC_URL: '{{{backend______optional______cache_publicUrl}}}',
      UUID: '{{{ backend______cache_UUID }}}',
      API_URL: 'http://{{{backend______svc_internalHostname}}}/v1',
    });

    const availableEnv = {
      backend______cache_branchName: 'patch-40',
      backend______cache_publicUrl: 'backend-cache-twilight-mouse-849168.lifecycle.example.com',
      backend______cache_UUID: 'twilight-mouse-849168',
      backend______cache_internalHostname: 'backend-cache-twilight-mouse-849168',
      backend______cache_dockerImage: null,
      backend______cache_sha: 'fa60c0a67fet21bde7f50e08881b2476f2d3d344',
      backend______optional______cache_branchName: '',
      backend______optional______cache_ipAddress: '',
      backend______optional______cache_publicUrl: 'backend-optional-cache-dev-0.lifecycle.example.com',
      backend______optional______cache_UUID: 'dev-0',
      backend______optional______cache_internalHostname: 'backend-optional-cache-dev-0',
      backend______optional______cache_dockerImage: '',
      backend______optional______cache_sha: '',
      backend______svc_branchName: 'patch-40',
      backend______svc_publicUrl: 'backend-svc-twilight-mouse-849168.lifecycle-grpc.example.com',
      backend______svc_UUID: 'twilight-mouse-849168',
      backend______svc_internalHostname: 'backend-svc-twilight-mouse-849168',
      backend______svc_dockerImage:
        'acct-id.dkr.ecr.us-west-2.amazonaws.com/lfc/deployments:fa60c0a-945b1ec4e88de7433641ac0b972f7bfa1553280e',
      backend______svc_sha: 'fa60c0a67fet21bde7f50e08881b2476f2d3d344',
      buildUUID: 'twilight-mouse-849168',
      buildSHA: '0f6892',
      pullRequestNumber: 75,
    };

    const useDefaultUUID = true;
    const namespace = 'twilight-mouse-849168';

    const result = {
      COMPONENT: 'app',
      ENV: 'lifecycle',
      CACHE_SIMPLE: 'backend-cache-twilight-mouse-849168.twilight-mouse-849168.svc.cluster.local',
      CACHE_HOST: 'backend-cache-twilight-mouse-849168-master.twilight-mouse-849168.svc.cluster.local',
      CACHE_URL: 'backend-cache-twilight-mouse-849168.twilight-mouse-849168.svc.cluster.local:6379',
      CACHE_ME: 'backend-cache-twilight-mouse-849168-master.twilight-mouse-849168.svc.cluster.local:6379',
      DEFAULT_SIMPLE: 'backend-default-dev-0.testns.svc.cluster.local',
      DEFAULT_HOST: 'backend-default-dev-0-master.testns.svc.cluster.local',
      DEFAULT_URL: 'backend-default-dev-0.testns.svc.cluster.local:6379',
      DEFAULT_ME: 'backend-default-dev-0-master.testns.svc.cluster.local:6379',
      OPT_CACHE_SIMPLE: 'backend-optional-cache-dev-0.testns.svc.cluster.local',
      OPT_CACHE_HOST: 'backend-optional-cache-dev-0-master.testns.svc.cluster.local',
      OPT_CACHE_URL: 'backend-optional-cache-dev-0.testns.svc.cluster.local:6379',
      OPT_CACHE_ME: 'backend-optional-cache-dev-0-master.testns.svc.cluster.local:6379',
      BUILD_UUID: 'twilight-mouse-849168',
      PUBLIC_URL: 'backend-cache-twilight-mouse-849168.lifecycle.example.com',
      OPT_PUBLIC_URL: 'backend-optional-cache-dev-0.lifecycle.example.com',
      UUID: 'twilight-mouse-849168',
      API_URL: 'http://backend-svc-twilight-mouse-849168.twilight-mouse-849168.svc.cluster.local/v1',
    };

    const customRenderResult = JSON.parse(
      await envVariables.customRender(template, availableEnv, useDefaultUUID, namespace)
    );
    expect(customRenderResult).toEqual(result);
  });

  test('custom render replaces _UUID with defaultUuid if not present in data', async () => {
    const template = JSON.stringify({
      VAR_1: '{{{myservice_UUID}}}',
      VAR_2: '{{myservice_UUID}}',
      VAR_3: '{{{otherservice_UUID}}}',
      VAR_4: 'static',
    });

    // No UUIDs in data
    const data = {
      unrelated_var: 'value',
    };

    const queryResult = {
      id: 2,
      key: 'defaultUUID',
      value: 'dev-0',
    };
    const globalConfigQueryBuilder = QueryBuilder.forClass(models.GlobalConfig);
    globalConfigQueryBuilder.where = jest.fn().mockImplementation(() => globalConfigQueryBuilder.resolve(queryResult));
    jest.spyOn(models.GlobalConfig, 'query').mockImplementation(() => globalConfigQueryBuilder.resolve(queryResult));

    const result = {
      VAR_1: 'dev-0',
      VAR_2: 'dev-0',
      VAR_3: 'dev-0',
      VAR_4: 'static',
    };

    const customRenderResult = JSON.parse(await envVariables.customRender(template, data, true, 'testns'));
    expect(customRenderResult).toEqual(result);
  });
});
