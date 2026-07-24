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

import { YamlConfigParser } from 'server/lib/yamlConfigParser';
import { Repository } from 'server/models';
import * as Config from '../Config';
import { Service } from '../YamlService';

describe('Yaml Config', () => {
  describe('getDeployingServicesByName', () => {
    const repository: Repository = new Repository();
    repository.fullName = 'org/foobar';

    const lifecycleConfigContent: string = `---
    version: '1.0.0'

    environment:
      webhooks:
        - state: 'deployed'
          name: 'e2e test'
          pipelineId: '3084088f0a8080b'
          trigger: 'webhook'
          type: 'codefresh'
          env:
            branch: 'main'

    services:
      - name: 'app1'
        github:
          repository: 'org/foobar'
          branchName: 'main'
          env:
            SOURCE: 'yaml'
            TOKEN1: 'abcdefghijk'
            BRANCH: '{{{cwf_branchName}}}'
      - name: 'app2'
        github:
          repository: 'org/foobar'
          branchName: 'main'
          env:
            SOURCE: 'yaml'
            TOKEN1: 'abcdefghijk'
            BRANCH: '{{{cwf_branchName}}}'
      - name: 'app3'
        codefresh:
          repository: 'org/foobar'
          branchName: 'main'
          env:
            SOURCE: 'yaml'
            TOKEN1: 'abcdefghijk'
            BRANCH: '{{{cwf_branchName}}}'
      - name: 'app4'
        codefresh:
          repository: 'org/cwf'
          branchName: 'main'
          env:
            SOURCE: 'yaml'
            TOKEN1: 'abcdefghijk'
            BRANCH: '{{{cwf_branchName}}}'
    `;

    test('valid yaml', () => {
      const parser = new YamlConfigParser();
      const config: Config.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);

      const service: Service = Config.getDeployingServicesByName(config, 'app1');
      expect(service.name).toEqual('app1');
    });
  });
});
