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

import type { DeploymentConfig } from 'server/models/yaml/YamlService';

export interface DependencyService {
  name?: string;
  repository?: string;
  branch?: string;
  serviceId?: number;
}

export interface ExternalHttpService {
  defaultInternalHostname: string;
  defaultPublicUrl: string;
}

export interface AuroraRestoreService {
  command: string;
  arguments: string;
}

export interface ConfigurationService {
  defaultTag: string;
  branchName: string;
}

export interface AfterBuildPipelineConfig {
  afterBuildPipelineId: string;
  detatchAfterBuildPipeline?: boolean;
  description?: string;
}

export interface GithubServiceAppDockerConfig {
  dockerfilePath: string;
  command?: string;
  arguments?: string;
  env?: Record<string, string>;
  ports?: number[];
  afterBuildPipelineConfig?: AfterBuildPipelineConfig;
}

export interface InitDockerConfig {
  dockerfilePath: string;
  command?: string;
  arguments?: string;
  env?: Record<string, string>;
}

export interface GithubService {
  env?: Record<string, string>;
  repository?: string;
  branchName?: string;
  docker?: {
    defaultTag?: string;
    app?: GithubServiceAppDockerConfig;
    init?: InitDockerConfig;
  };
  deployment?: DeploymentConfig;
}

export interface DockerService {
  dockerImage: string;
  defaultTag: string;
  command?: string;
  arguments?: string;
  env?: Record<string, string>;
  ports?: number[];
  deployment?: DeploymentConfig;
  dockerfilePath: string;
}

export interface CodefreshConfig {
  pipelineId: string;
  trigger: string;
}

export interface CodefreshService {
  repository: string;
  branchName: string;
  env?: Record<string, string>;
  deploy?: CodefreshConfig;
  destroy?: CodefreshConfig;
  deployment?: DeploymentConfig;
}
export interface Service {
  name: string;
  defaultUUID?: string;
  requires?: DependencyService[];
  github?: GithubService;
  docker?: DockerService;
  codefresh?: CodefreshService;
  configuration?: ConfigurationService;
  externalHttp?: ExternalHttpService;
  auroraRestore?: AuroraRestoreService;
}

export interface Webhook {
  name?: string;
  description?: string;
  state: string;
  type: string;
  pipelineId: string;
  trigger: string;
  env: Record<string, string>;
}

export interface Environment {
  defaultServices?: DependencyService[];
  optionalServices?: DependencyService[];
  webhooks?: Webhook[];
}

export interface LifecycleConfigVersion {
  version: string;
}

export interface LifecycleConfig {
  version: string;
  environment: Environment;
  service?: {
    github?: {
      env?: Record<string, string>;
    };
  };
  services: Service[];
}
