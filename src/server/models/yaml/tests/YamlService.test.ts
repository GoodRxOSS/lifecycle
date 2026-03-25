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
import { YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import { DeployTypes } from 'shared/constants';
import * as YamlService from '../index';

describe('Yaml Service', () => {
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
    - name: 'githubApp'
      github:
        repository: 'org/foobar'
        branchName: 'main'
        docker:
          defaultTag: 'main'
          app:
            dockerfilePath: 'app1/app.Dockerfile'
            env:
              SOURCE: 'yaml'
              TYPE: 'github'
          init:
            dockerfilePath: 'app1/init.Dockerfile'
            env:
              SOURCE: 'yaml'
              TYPE: 'github-init'
    - name: 'githubApp-with-after-build-pipeline-id'
      github:
        repository: 'org/foobar'
        branchName: 'main'
        docker:
          defaultTag: 'main'
          app:
            afterBuildPipelineConfig:
              afterBuildPipelineId: '8080a08b080ff'
              detatchAfterBuildPipeline: true
              description: 'after build pipeline'
            dockerfilePath: 'app1/app.Dockerfile'
            env:
              SOURCE: 'yaml'
              TYPE: 'github'
          init:
            dockerfilePath: 'app1/init.Dockerfile'
            env:
              SOURCE: 'yaml'
              TYPE: 'github-init'
    - name: 'codefreshApp'
      codefresh:
        repository: 'org/cwf'
        branchName: 'main'
        env:
          SOURCE: 'yaml'
          TYPE: 'codefresh'
          TOKEN1: '8080a08b080ff'
    - name: 'dockerApp'
      docker:
        defaultTag: 'latest'
        dockerImage: 'postgres'
        command: 'postgres'
        arguments: '-c%%SPLIT%%max_connections= 3451%%SPLIT%%-c%%SPLIT%%shared_buffers=3GB'
        env:
          SOURCE: 'yaml'
          TYPE: 'docker'
    - name: 'externalHttpApp'
      externalHttp:
        defaultInternalHostname: 'externalHttpApp-dev-0'
        defaultPublicUrl: 'externalHttpApp-dev-0.lifecycle.dev.example.com'
    - name: 'auroraRestoreApp'
      auroraRestore:
        command: 'ls'
        arguments: '-arg foobar'
    - name: 'configurationApp'
      configuration:
        defaultTag: 'main'
        branchName: 'main'
`;

  describe('validation', () => {
    test('accepts environment-level agent session resource overrides', () => {
      const parser = new YamlConfigParser();
      const config = parser.parseYamlConfigFromString(`---
version: '1.0.0'
environment:
  agentSession:
    resources:
      agent:
        requests:
          cpu: '1200m'
        limits:
          memory: '6Gi'
      editor:
        requests:
          memory: '768Mi'
        limits:
          cpu: '1500m'
services:
  - name: 'agent-app'
    dev:
      image: 'node:20-slim'
      command: 'pnpm dev'
    github:
      repository: 'org/example'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'apps/agent-app/Dockerfile'
`);

      expect(() => new YamlConfigValidator().validate_1_0_0(config)).not.toThrow();
    });

    test('accepts forwardEnvVarsToAgent in dev config', () => {
      const parser = new YamlConfigParser();
      const config = parser.parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'agent-app'
    dev:
      image: 'node:20-slim'
      command: 'pnpm dev'
      installCommand: 'pnpm install --frozen-lockfile'
      forwardEnvVarsToAgent:
        - PRIVATE_REGISTRY_TOKEN
        - TURBO_TOKEN
    github:
      repository: 'org/example'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'apps/agent-app/Dockerfile'
`);

      expect(() => new YamlConfigValidator().validate_1_0_0(config)).not.toThrow();
    });
  });

  describe('isGithubService', () => {
    test('GithubService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.isGithubService(service)).toEqual(true);
    });

    test('Non-GithubService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'codefreshApp');

      expect(YamlService.isGithubService(service)).toEqual(false);
    });
  });

  describe('isCodefreshService', () => {
    test('Non-CodefreshService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.isCodefreshService(service)).toEqual(false);
    });

    test('CodefreshService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'codefreshApp');

      expect(YamlService.isCodefreshService(service)).toEqual(true);
    });
  });

  describe('isDockerService', () => {
    test('Non-DockerService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.isDockerService(service)).toEqual(false);
    });

    test('DockerService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'dockerApp');

      expect(YamlService.isDockerService(service)).toEqual(true);
    });
  });

  describe('isExternalHttpService', () => {
    test('Non-ExternalHttpService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.isExternalHttpService(service)).toEqual(false);
    });

    test('ExternalHttpService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'externalHttpApp');

      expect(YamlService.isExternalHttpService(service)).toEqual(true);
    });
  });

  describe('isAuroraRestoreService', () => {
    test('Non-AuroraRestoreService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.isAuroraRestoreService(service)).toEqual(false);
    });

    test('AuroraRestoreService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'auroraRestoreApp');

      expect(YamlService.isAuroraRestoreService(service)).toEqual(true);
    });
  });

  describe('isConfigurationService', () => {
    test('Non-ConfigurationService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'dockerApp');

      expect(YamlService.isConfigurationService(service)).toEqual(false);
    });

    test('ConfigurationService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'configurationApp');

      expect(YamlService.isConfigurationService(service)).toEqual(true);
    });
  });

  describe('getDeployType', () => {
    test('GithubService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.getDeployType(service)).toEqual(DeployTypes.GITHUB);
    });

    test('CodefreshService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'codefreshApp');

      expect(YamlService.getDeployType(service)).toEqual(DeployTypes.CODEFRESH);
    });

    test('DockerService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'dockerApp');

      expect(YamlService.getDeployType(service)).toEqual(DeployTypes.DOCKER);
    });

    test('ExternalHttpService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'externalHttpApp');

      expect(YamlService.getDeployType(service)).toEqual(DeployTypes.EXTERNAL_HTTP);
    });

    test('AuroraRestoreService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'auroraRestoreApp');

      expect(YamlService.getDeployType(service)).toEqual(DeployTypes.AURORA_RESTORE);
    });

    test('ConfigurationService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'configurationApp');

      expect(YamlService.getDeployType(service)).toEqual(DeployTypes.CONFIGURATION);
    });
  });

  describe('hasLifecycleManagedDockerBuild', () => {
    test('returns true for github services with docker config', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.hasLifecycleManagedDockerBuild(service)).toEqual(true);
    });

    test('returns true for helm services with docker config', () => {
      const parser = new YamlConfigParser();
      const config = parser.parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'grpc-echo'
    dev:
      image: 'repo/app:dev'
      command: 'npm run dev'
    helm:
      repository: 'org/example'
      branchName: 'main'
      chart:
        name: './helm/app'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'grpc-echo/Dockerfile'
`);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'grpc-echo');

      expect(YamlService.hasLifecycleManagedDockerBuild(service)).toEqual(true);
    });

    test('returns false for helm services without docker config', () => {
      const parser = new YamlConfigParser();
      const config = parser.parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'redis'
    dev:
      image: 'repo/redis:dev'
      command: 'redis-server'
    helm:
      repository: 'org/example'
      branchName: 'main'
      chart:
        name: 'redis'
`);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'redis');

      expect(YamlService.hasLifecycleManagedDockerBuild(service)).toEqual(false);
    });

    test('returns false for docker services that only reference external images', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'dockerApp');

      expect(YamlService.hasLifecycleManagedDockerBuild(service)).toEqual(false);
    });
  });

  describe('getEnvironmentVariables', () => {
    test('GithubService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.getEnvironmentVariables(service)).toEqual({
        SOURCE: 'yaml',
        TYPE: 'github',
      });
    });

    test('GithubService - Missing app env', () => {
      const missingEnvVar: string = `---
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
        - name: 'githubApp'
          github:
            repository: 'org/foobar'
            branchName: 'main'
            docker:
              defaultTag: 'main'
              app:
                dockerfilePath: 'app1/app.Dockerfile'
        - name: 'codefreshApp'
          codefresh:
            repository: 'org/cwf'
            branchName: 'main'
            env:
              SOURCE: 'yaml'
              TYPE: 'codefresh'
              TOKEN1: '8080a08b080ff'
        - name: 'dockerApp'
          docker:
            defaultTag: 'latest'
            dockerImage: 'postgres'
            command: 'postgres'
            arguments: '-c%%SPLIT%%max_connections= 3451%%SPLIT%%-c%%SPLIT%%shared_buffers=3GB'
            env:
              SOURCE: 'yaml'
              TYPE: 'docker'
        - name: 'externalHttpApp'
          externalHttp:
            defaultInternalHostname: 'externalHttpApp-dev-0'
            defaultPublicUrl: 'externalHttpApp-dev-0.lifecycle.dev.example.com'
        - name: 'auroraRestoreApp'
          auroraRestore:
            command: 'ls'
            arguments: '-arg foobar'
        - name: 'configurationApp'
          configuration:
            defaultTag: 'main'
            branchName: 'main'
      `;

      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(missingEnvVar);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.getEnvironmentVariables(service)).toEqual(undefined);
    });

    test('CodefreshService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'codefreshApp');

      expect(YamlService.getEnvironmentVariables(service)).toEqual({
        SOURCE: 'yaml',
        TYPE: 'codefresh',
        TOKEN1: '8080a08b080ff',
      });
    });

    test('DockerService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'dockerApp');

      expect(YamlService.getEnvironmentVariables(service)).toEqual({
        SOURCE: 'yaml',
        TYPE: 'docker',
      });
    });

    test('ExternalHttpService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'externalHttpApp');

      expect(YamlService.getEnvironmentVariables(service)).toEqual(undefined);
    });

    test('AuroraRestoreService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'auroraRestoreApp');

      expect(YamlService.getEnvironmentVariables(service)).toEqual(undefined);
    });

    test('ConfigurationService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'configurationApp');

      expect(YamlService.getEnvironmentVariables(service)).toEqual(undefined);
    });
  });

  describe('getInitEnvironmentVariables', () => {
    test('GithubService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.getInitEnvironmentVariables(service)).toEqual({
        SOURCE: 'yaml',
        TYPE: 'github-init',
      });
    });

    test('GithubService - Missing app env', () => {
      const missingEnvVar: string = `---
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
        - name: 'githubApp'
          github:
            repository: 'org/foobar'
            branchName: 'main'
            docker:
              defaultTag: 'main'
              app:
                dockerfilePath: 'app1/app.Dockerfile'
        - name: 'codefreshApp'
          codefresh:
            repository: 'org/cwf'
            branchName: 'main'
            env:
              SOURCE: 'yaml'
              TYPE: 'codefresh'
              TOKEN1: '8080a08b080ff'
        - name: 'dockerApp'
          docker:
            defaultTag: 'latest'
            dockerImage: 'postgres'
            command: 'postgres'
            arguments: '-c%%SPLIT%%max_connections= 3451%%SPLIT%%-c%%SPLIT%%shared_buffers=3GB'
            env:
              SOURCE: 'yaml'
              TYPE: 'docker'
        - name: 'externalHttpApp'
          externalHttp:
            defaultInternalHostname: 'externalHttpApp-dev-0'
            defaultPublicUrl: 'externalHttpApp-dev-0.lifecycle.dev.example.com'
        - name: 'auroraRestoreApp'
          auroraRestore:
            command: 'ls'
            arguments: '-arg foobar'
        - name: 'configurationApp'
          configuration:
            defaultTag: 'main'
            branchName: 'main'
    `;

      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(missingEnvVar);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.getInitEnvironmentVariables(service)).toEqual(undefined);
    });

    test('CodefreshService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'codefreshApp');

      expect(YamlService.getInitEnvironmentVariables(service)).toEqual(undefined);
    });

    test('DockerService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'dockerApp');

      expect(YamlService.getInitEnvironmentVariables(service)).toEqual(undefined);
    });

    test('ExternalHttpService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'externalHttpApp');

      expect(YamlService.getInitEnvironmentVariables(service)).toEqual(undefined);
    });

    test('AuroraRestoreService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'auroraRestoreApp');

      expect(YamlService.getInitEnvironmentVariables(service)).toEqual(undefined);
    });

    test('ConfigurationService', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);

      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'configurationApp');

      expect(YamlService.getInitEnvironmentVariables(service)).toEqual(undefined);
    });

    test('isAfterBuildPipelineId should return value', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(
        config,
        'githubApp-with-after-build-pipeline-id'
      );

      expect(YamlService.getAfterBuildPipelineId(service)).toEqual('8080a08b080ff');
    });

    test('isAfterBuildPipelineId should be undefined', () => {
      const parser = new YamlConfigParser();

      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.getAfterBuildPipelineId(service)).toEqual(undefined);
    });

    test('getDetachAfterBuildPipeline should return value', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(
        config,
        'githubApp-with-after-build-pipeline-id'
      );

      expect(YamlService.getDetatchAfterBuildPipeline(service)).toEqual(true);
    });

    test('getDetachAfterBuildPipeline should be false', () => {
      const parser = new YamlConfigParser();
      const config: YamlService.LifecycleConfig = parser.parseYamlConfigFromString(lifecycleConfigContent);
      new YamlConfigValidator().validate_1_0_0(config);
      const service: YamlService.Service = YamlService.getDeployingServicesByName(config, 'githubApp');

      expect(YamlService.getDetatchAfterBuildPipeline(service)).toEqual(false);
    });
  });
});
