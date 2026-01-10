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

import { DeployTypes, DEPLOY_TYPES_DICTIONARY as dtd } from 'shared/constants';
import Repository from 'server/models/Repository';
import {
  isInObj,
  getDeployType,
  resolveRepository,
  fetchLifecycleConfigByRepository,
} from 'server/models/config/utils';
import { LifecycleConfig, Service } from 'server/models/config/types';

import { getLogger } from 'server/lib/logger/index';

export const isGithubServiceDockerConfig = (obj) => isInObj(obj, 'dockerfilePath');
export const isDockerServiceConfig = (obj) => isInObj(obj, 'dockerImage');

export function getEnvironmentVariables(service: Service) {
  const deployType = getDeployType(service);
  if (![dtd.github, dtd.codefresh, dtd.docker].includes(deployType)) return;
  if (deployType === dtd.github) return service.github?.docker?.app?.env || service.github.env || undefined;
  return service[deployType]?.env;
}

export const getInitEnvironmentVariables = (service: Service) => {
  if (getDeployType(service) !== dtd.github) return;
  return service?.github?.docker?.init?.env;
};

export const getAfterBuildPipelineId = (service: Service) => {
  const deployType = getDeployType(service);
  if (deployType !== dtd.github) return;
  return service.github?.docker?.app?.afterBuildPipelineConfig?.afterBuildPipelineId;
};

export const getDetatchAfterBuildPipeline = (service: Service) => {
  const deployType = getDeployType(service);
  if (deployType !== dtd.github) return false;
  return service.github?.docker?.app?.afterBuildPipelineConfig?.detatchAfterBuildPipeline || false;
};

export const getDockerImage = (service: Service) => {
  const deployType = getDeployType(service);
  if (deployType !== dtd.docker) return;
  return service.docker?.dockerImage;
};

export function getRepositoryName(service: Service): string {
  const deployType = getDeployType(service);
  if (![dtd.github, dtd.codefresh].includes(deployType)) return;
  return service[deployType]?.repository;
}

export function getBranchName(service: Service) {
  const deployType = getDeployType(service);
  if (![dtd.github, dtd.codefresh].includes(deployType)) return;
  return service[deployType]?.branchName;
}

export function getDefaultTag(service: Service) {
  const deployType = getDeployType(service);
  if (![dtd.github, dtd.docker].includes(deployType)) return;
  if (deployType === dtd.github) return service.github?.docker?.defaultTag;
  return service.docker?.defaultTag;
}

export const getAppDockerConfig = (service: Service) => {
  const deployType = getDeployType(service);
  if (![dtd.github, dtd.docker].includes(deployType)) return;
  if (deployType === dtd.github) return service.github?.docker?.app;
  return service.docker;
};

export const getInitDockerConfig = (service: Service) => {
  if (getDeployType(service) !== DeployTypes.GITHUB) return;
  return service?.github?.docker?.init;
};

export const getPort = (service: Service) => {
  const deployType = getDeployType(service);
  if (![dtd.github, dtd.docker].includes(deployType)) return;
  const ports = deployType === dtd.github ? service.github?.docker?.app?.ports : service.docker?.ports;
  return ports ? ports.toString() : '8080';
};

export const getDeploymentConfig = (service: Service) => {
  const deployType = getDeployType(service);
  if (![dtd.github, dtd.docker, dtd.codefresh].includes(deployType)) return;
  return service[deployType]?.deployment;
};

export const getDeployPipelineConfig = (service: Service) => {
  const deployType = getDeployType(service);
  if (deployType !== dtd.codefresh) return;
  return service.codefresh?.deploy;
};

export const getDestroyPipelineConfig = (service: Service) => {
  const deployType = getDeployType(service);
  if (deployType !== dtd.codefresh) return;
  return service.codefresh?.destroy;
};

export const fetchLifecycleConfig = async (repositoryName: string, branchName: string) => {
  if (!repositoryName || !branchName) return;
  try {
    const repository: Repository = await resolveRepository(repositoryName);
    if (!repository) throw new Error(`Unable to resolve repository ${repositoryName}`);
    const config = await fetchLifecycleConfigByRepository(repository, branchName);
    return config;
  } catch (err) {
    getLogger().error(
      { error: err instanceof Error ? err.message : String(err) },
      `Failed to fetch config: repository=${repositoryName} branch=${branchName}`
    );
  }
};

export const getDeployingServicesByName = (config: LifecycleConfig, serviceName: string) => {
  if (config?.services?.length === 0 || !serviceName) return;
  return config.services.find(({ name }) => serviceName.localeCompare(name) === 0);
};

export { getDeployType, fetchLifecycleConfigByRepository, resolveRepository };
