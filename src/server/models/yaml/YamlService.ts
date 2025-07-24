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

/* eslint-disable no-case-declarations */
import _ from 'lodash';
import rootLogger from 'server/lib/logger';
import GlobalConfigService from 'server/services/globalConfig';
import { DeployTypes, FeatureFlags, NO_DEFAULT_ENV_UUID } from 'shared/constants';
import Build from '../Build';
import { DomainDefaults, NativeHelmConfig } from 'server/services/types/globalConfig';

const logger = rootLogger.child({
  filename: 'models/yaml/YamlService.ts',
});

export interface Service001 {
  readonly github: {
    readonly env: Record<string, string>;
  };
}

export interface Service {
  readonly name: string;
  appShort?: string;
  readonly defaultUUID?: string;
  readonly requires?: DependencyService[];
  readonly deploymentDependsOn?: string[];
  readonly kedaScaleToZero?: KedaScaleToZero;
}

export interface KedaScaleToZero {
  readonly type: string;
  readonly replicas: { readonly min: number; readonly max: number };
  readonly scaledownPeriod: number;
  readonly maxRetries: number;
  readonly scalingMetric: {
    readonly requestRate: {
      readonly granularity: string;
      readonly targetValue: number;
      readonly window: string;
    };
    readonly concurrency: {
      readonly targetValue: number;
    };
  };
}

export interface DependencyService {
  readonly name?: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly serviceId?: number;
}

export interface GithubService002 extends Service {
  readonly github: {
    readonly env: Record<string, string>;
  };
}

export interface GithubService extends Service {
  readonly github: {
    readonly repository: string;
    readonly branchName: string;
    readonly docker: {
      readonly builder?: Builder;
      readonly ecr?: string;
      pipelineId?: string;
      readonly defaultTag: string;
      readonly app: GithubServiceAppDockerConfig;
      readonly init?: InitDockerConfig;
    };
    readonly deployment?: DeploymentConfig;
  };
}

export interface GithubServiceAppDockerConfig {
  readonly dockerfilePath: string;
  readonly command?: string;
  readonly arguments?: string;
  readonly env?: Record<string, string>;
  readonly ports?: number[];
  readonly afterBuildPipelineConfig?: AfterBuildPipelineConfig;
}

export interface InitDockerConfig {
  readonly dockerfilePath: string;
  readonly command?: string;
  readonly arguments?: string;
  readonly env?: Record<string, string>;
}

export function isGithubServiceDockerConfig(object: any): object is GithubServiceAppDockerConfig {
  let result: boolean;
  object == null ? (result = false) : (result = 'dockerfilePath' in object);
  return result;
}

export function isDockerServiceConfig(object: any): object is DockerServiceConfig {
  let result: boolean;
  object == null ? (result = false) : (result = 'dockerImage' in object);
  return result;
}

export interface DockerServiceConfig {
  readonly dockerImage: string;
  readonly defaultTag: string;
  readonly command?: string;
  readonly arguments?: string;
  readonly env?: Record<string, string>;
  readonly ports?: number[];
  readonly deployment?: DeploymentConfig;
}

export interface CodefreshService extends Service {
  readonly codefresh: {
    readonly repository: string;
    readonly branchName: string;
    readonly env?: Record<string, string>;
    readonly deploy?: CodefreshConfig;
    readonly destroy?: CodefreshConfig;
    readonly deployment?: DeploymentConfig;
  };
}

export interface CodefreshConfig {
  readonly pipelineId: string;
  readonly trigger: string;
}

export interface AfterBuildPipelineConfig {
  readonly afterBuildPipelineId: string;
  readonly detatchAfterBuildPipeline?: boolean;
  readonly description?: string;
}

export interface DockerService extends Service {
  readonly docker: DockerServiceConfig;
}

export interface ExternalHttpService extends Service {
  readonly externalHttp: {
    readonly defaultInternalHostname: string;
    readonly defaultPublicUrl: string;
  };
}

export interface AuroraRestoreService extends Service {
  readonly auroraRestore: AuroraRestoreServiceConfig;
}

export interface AuroraRestoreServiceConfig extends Service {
  readonly command: string;
  readonly arguments: string;
}
export interface ConfigurationService extends Service {
  readonly configuration: {
    readonly defaultTag: string;
    readonly branchName: string;
  };
}

export interface DockerForHelm {
  readonly defaultTag: string;
  readonly app: GithubServiceAppDockerConfig;
  readonly init?: InitDockerConfig;
  readonly builder?: Builder;
  readonly ecr?: string;
}

export interface Helm {
  readonly cfStepType: string;
  readonly repository?: string;
  readonly branchName?: string;
  readonly args?: string;
  readonly version?: string;
  readonly action?: string;
  readonly chart?: HelmChart;
  readonly docker?: DockerForHelm;
  readonly grpc?: boolean;
  readonly disableIngressHost?: boolean;
  readonly overrideDefaultIpWhitelist?: boolean;
  readonly type?: string;
  readonly builder?: Builder;
  readonly envLens?: boolean;
  readonly deploymentMethod?: 'native' | 'ci';
  readonly nativeHelm?: NativeHelmConfig;
  readonly envMapping?: {
    readonly app?: {
      readonly format: 'array' | 'map';
      readonly path: string;
    };
    readonly init?: {
      readonly format: 'array' | 'map';
      readonly path: string;
    };
  };
}

export interface HelmService {
  readonly helm?: Helm;
}

export interface HelmChart {
  readonly name?: string;
  readonly repoUrl?: string;
  readonly version?: string;
  readonly values?: string[];
  readonly valueFiles?: string[];
}

export interface DeploymentConfig {
  readonly public?: boolean;
  readonly capacityType?: string;
  readonly resource?: ResourceConfig;
  readonly readiness?: ReadinessConfig;
  readonly hostnames?: HostnamesConfig;
  readonly network?: NetworkConfig;
  readonly serviceDisks?: ServiceDiskConfig[];
}

export interface ResourceConfig {
  readonly cpu?: CapacityConfig;
  readonly memory?: CapacityConfig;
}

export interface CapacityConfig {
  readonly request?: string;
  readonly limit?: string;
}

export interface ReadinessConfig {
  readonly disabled?: boolean;
  readonly tcpSocketPort?: number;
  readonly httpGet?: {
    readonly path: string;
    readonly port: number;
  };
  readonly initialDelaySeconds?: number;
  readonly periodSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly successThreshold?: number;
  readonly failureThreshold?: number;
}

export interface HostnamesConfig {
  readonly host?: string;
  readonly acmARN?: string;
  readonly defaultInternalHostname?: string;
  readonly defaultPublicUrl?: string;
}

export interface NetworkConfig {
  readonly ipWhitelist?: string[];
  readonly pathPortMapping?: Record<string, string>;
  readonly hostPortMapping?: Record<string, string>;
  readonly grpc?: {
    readonly enable: boolean;
    readonly host?: string;
    readonly defaultHost?: string;
  };
  ingressAnnotations?: Record<string, any>;
}

export interface ServiceDiskConfig {
  readonly name: string;
  readonly mountPath: string;
  readonly accessModes?: string;
  readonly storageSize: string;
  readonly medium?: string;
}

export interface Builder {
  readonly engine?: string;
}

/**
 * Determine if the given Lifecycle Service YAML model is a Github Service type. Typescript has no runtime meta data to determine the interface type during runtime.
 * The only solution is looking for the combination of attributes to guess the type. If there is a better way to determine runtime type, Pull Request is very welcome.
 * @param service Valid Lifecycle Service YAML model
 * @returns True if the given Lifecycle Service YAML model is a github service type
 */
export function isGithubService(service: Service): boolean {
  return (service as GithubService)?.github != null;
}

/**
 * Determine if the given Lifecycle Service YAML model is a Codefresh Service type. Typescript has no runtime meta data to determine the interface type during runtime.
 * The only solution is looking for the combination of attributes to guess the type. If there is a better way to determine runtime type, Pull Request is very welcome.
 * @param service Valid Lifecycle Service YAML model
 * @returns True if the given Lifecycle Service YAML model is a Codefresh service type
 */
export function isCodefreshService(service: Service): boolean {
  return (service as CodefreshService)?.codefresh != null;
}

/**
 * Determine if the given Lifecycle Service YAML model is a Docker Service type. Typescript has no runtime meta data to determine the interface type during runtime.
 * The only solution is looking for the combination of attributes to guess the type. If there is a better way to determine runtime type, Pull Request is very welcome.
 * @param service Valid Lifecycle Service YAML model
 * @returns True if the given Lifecycle Service YAML model is a Codefresh service type
 */
export function isDockerService(service: Service): boolean {
  return (service as DockerService)?.docker != null;
}

/**
 * Determine if the given Lifecycle Service YAML model is a External HTTP Service type. Typescript has no runtime meta data to determine the interface type during runtime.
 * The only solution is looking for the combination of attributes to guess the type. If there is a better way to determine runtime type, Pull Request is very welcome.
 * @param service Valid Lifecycle Service YAML model
 * @returns True if the given Lifecycle Service YAML model is a Codefresh service type
 */
export function isExternalHttpService(service: Service): boolean {
  return (service as ExternalHttpService)?.externalHttp != null;
}

/**
 * Determine if the given Lifecycle Service YAML model is a Aurora Restore Service type. Typescript has no runtime meta data to determine the interface type during runtime.
 * The only solution is looking for the combination of attributes to guess the type. If there is a better way to determine runtime type, Pull Request is very welcome.
 * @param service Valid Lifecycle Service YAML model
 * @returns True if the given Lifecycle Service YAML model is a Codefresh service type
 */
export function isAuroraRestoreService(service: Service): boolean {
  return (service as AuroraRestoreService)?.auroraRestore != null;
}

/**
 * Determine if the given Lifecycle Service YAML model is a Aurora Restore Service type. Typescript has no runtime meta data to determine the interface type during runtime.
 * The only solution is looking for the combination of attributes to guess the type. If there is a better way to determine runtime type, Pull Request is very welcome.
 * @param service Valid Lifecycle Service YAML model
 * @returns True if the given Lifecycle Service YAML model is a Codefresh service type
 */
export function isConfigurationService(service: Service): boolean {
  return (service as ConfigurationService)?.configuration != null;
}

/**
 * Determine if the given Lifecycle Service YAML model is a Helm Service type. Typescript has no runtime meta data to determine the interface type during runtime.
 * The only solution is looking for the combination of attributes to guess the type. If there is a better way to determine runtime type, Pull Request is very welcome.
 * @param service Valid Lifecycle Service YAML model
 * @returns True if the given Lifecycle Service YAML model is a Codefresh service type
 */
export function isHelmService(service: Service): boolean {
  return (service as unknown as HelmService)?.helm != null;
}

/**
 * Determine the Lifecycle service type. Even Service is the base interface of all the Service types. Typescript has no runtime type meta data can be used to determine the type.
 * If there is any better way than switch/case statement, pull request is very welcome.
 * @param service Lifecycle Service type
 * @returns One of the DeployTypes enumerations
 */
export function getDeployType(service: Service): DeployTypes {
  let result: DeployTypes;

  if (isGithubService(service)) {
    result = DeployTypes.GITHUB;
  } else if (isCodefreshService(service)) {
    result = DeployTypes.CODEFRESH;
  } else if (isDockerService(service)) {
    result = DeployTypes.DOCKER;
  } else if (isExternalHttpService(service)) {
    result = DeployTypes.EXTERNAL_HTTP;
  } else if (isConfigurationService(service)) {
    result = DeployTypes.CONFIGURATION;
  } else if (isAuroraRestoreService(service)) {
    result = DeployTypes.AURORA_RESTORE;
  } else if (isHelmService(service)) {
    result = DeployTypes.HELM;
  }

  return result;
}

/**
 * Helper function to quickly retrieve the environment variables from varies Lifecycle service type (because they are in different locations within the JSON structure).
 * @param service Valid Lifecycle Service YAML model
 * @returns Key/Value records of environment variables
 */
export function getEnvironmentVariables(service: Service): Record<string, string> {
  let result: Record<string, string>;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      result = (service as GithubService).github.docker?.app?.env ?? undefined;
      if (result == null) {
        result = (service as GithubService002).github.env ?? undefined;
      }
      break;
    case DeployTypes.CODEFRESH:
      result = (service as CodefreshService).codefresh.env ?? undefined;
      break;
    case DeployTypes.DOCKER:
      result = (service as DockerService).docker.env ?? undefined;
      break;
    case DeployTypes.HELM:
      result = (service as HelmService).helm?.docker?.app?.env ?? undefined;
      break;
    default:
      break;
  }

  return result;
}

/**
 * Helper function to quickly retrieve the init container environment variables from varies Lifecycle service type (because they are in different locations within the JSON structure).
 * @param service Valid Lifecycle Service YAML model
 * @returns Key/Value records of environment variables
 */
export function getInitEnvironmentVariables(service: Service): Record<string, string> {
  let result: Record<string, string>;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      if (githubService?.github?.docker?.init != null) {
        result = githubService.github.docker.init.env;
      }
      break;
    case DeployTypes.HELM:
      const helmService: HelmService = service as HelmService;
      result = helmService?.helm?.docker?.init?.env;
      break;
    default:
      break;
  }

  return result;
}

/**
 * Helper function to quickly retrieve the afterBuildPipelineId which is used to trigger post build pipeline
 * @param service
 * @returns string | undefined
 */
export function getAfterBuildPipelineId(service: Service): string {
  let result: string;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      if (githubService?.github?.docker?.app?.afterBuildPipelineConfig?.afterBuildPipelineId != null) {
        result = githubService.github.docker.app.afterBuildPipelineConfig.afterBuildPipelineId;
      }
      break;
    case DeployTypes.HELM:
      const helmService: HelmService = service as HelmService;
      result = helmService?.helm?.docker?.app?.afterBuildPipelineConfig?.afterBuildPipelineId;
      break;
    default:
      break;
  }

  return result;
}
/**
 * Helper function to quickly retrieve the detatchAfterBuildPipeline which is used to determine if the CI build will be run in detatch mode
 * @param service
 * @returns boolean
 */

export function getDetatchAfterBuildPipeline(service: Service): boolean {
  let result: boolean = false;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      if (githubService?.github?.docker?.app?.afterBuildPipelineConfig?.detatchAfterBuildPipeline != null) {
        result = githubService.github.docker.app.afterBuildPipelineConfig.detatchAfterBuildPipeline;
      }
      break;
    case DeployTypes.HELM:
      const helmService: HelmService = service as HelmService;
      result = helmService?.helm?.docker?.app?.afterBuildPipelineConfig?.detatchAfterBuildPipeline;
      break;
    default:
      break;
  }

  return result;
}

/**
 * Helper function to quickly retrieve the helm configurations
 * @param service
 * @returns boolean
 */

export async function getHelmConfigFromYaml(service: Service): Promise<Helm> {
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  if (DeployTypes.HELM === getDeployType(service)) {
    const helmService = (service as unknown as HelmService).helm;

    // First check for chart-specific configuration
    if (!globalConfig[helmService?.chart?.name]) {
      if (globalConfig?.publicChart?.block)
        throw new Error(
          `Unspported Chart: helmChart with name: ${helmService?.chart?.name} is not currently supported`
        );
      logger.warn(`[helmChart with name: ${helmService?.chart?.name} is not currently supported, proceed with caution`);
    }

    // Merge in priority order:
    // 1. Service-specific helm config (highest priority)
    // 2. Chart-specific global config
    // 3. helmDefaults from global_config (lowest priority)
    const helmDefaults = globalConfig.helmDefaults || {};
    const chartConfig = globalConfig[helmService?.chart?.name] || {};

    const helmConfig = _.merge({}, helmDefaults, chartConfig, helmService);

    // Preserve value files from service config if specified
    if (helmService?.chart?.valueFiles?.length > 0) {
      helmConfig.chart.values = helmService.chart.values;
    }

    return helmConfig as Helm;
  }
}

/**
 *
 * @param service
 * @returns
 */
export function getDockerImage(service: Service): string {
  let result: string;

  switch (getDeployType(service)) {
    case DeployTypes.DOCKER:
      const dockerService: DockerService = service as DockerService;
      result = dockerService?.docker?.dockerImage;
      break;
    default:
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getRepositoryName(service: Service): string {
  let result: string;
  try {
    switch (getDeployType(service)) {
      case DeployTypes.GITHUB:
        const githubService: GithubService = service as GithubService;
        result = githubService?.github?.repository;
        break;
      case DeployTypes.CODEFRESH:
        const codefreshService: CodefreshService = service as CodefreshService;
        result = codefreshService?.codefresh?.repository;
        break;
      case DeployTypes.HELM:
        const helmService: HelmService = service as unknown as HelmService;
        result = helmService?.helm?.repository;
        break;
      default:
        break;
    }
  } catch (error) {
    logger.error(
      `There was a problem getting the repository name for service name: ${JSON.stringify(
        service,
        null,
        2
      )} \n ${error}`
    );
    throw error;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getBranchName(service: Service): string {
  let result: string;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      result = githubService?.github?.branchName;
      break;
    case DeployTypes.CODEFRESH:
      const codefreshService: CodefreshService = service as CodefreshService;
      result = codefreshService?.codefresh?.branchName;
      break;
    case DeployTypes.HELM:
      const helmChartService: HelmService = service as unknown as HelmService;
      result = helmChartService?.helm?.branchName;
      break;
    default:
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export async function getDefaultTag(service: Service): Promise<string> {
  let result: string;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      result = githubService?.github?.docker?.defaultTag;
      break;
    case DeployTypes.DOCKER:
      const dockerService: DockerService = service as DockerService;
      result = dockerService?.docker?.defaultTag;
      break;
    case DeployTypes.HELM:
      const helmService: HelmService = service as unknown as HelmService;
      result = helmService?.helm?.docker?.defaultTag;
      break;
    default:
      const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
      result = globalConfig.serviceDefaults.defaultTag as string;
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getAppDockerConfig(
  service: Service
): GithubServiceAppDockerConfig | DockerServiceConfig | AuroraRestoreServiceConfig {
  let result: GithubServiceAppDockerConfig | DockerServiceConfig | AuroraRestoreServiceConfig;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      result = githubService?.github?.docker?.app;
      break;
    case DeployTypes.DOCKER:
      const dockerService: DockerService = service as DockerService;
      result = dockerService?.docker;
      break;
    case DeployTypes.AURORA_RESTORE:
      const rdsService: AuroraRestoreService = service as AuroraRestoreService;
      result = rdsService?.auroraRestore;
      break;
    case DeployTypes.HELM:
      const helmService: HelmService = service as unknown as HelmService;
      result = helmService?.helm?.docker?.app;
      break;
    default:
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getInitDockerConfig(service: Service): InitDockerConfig {
  let result: InitDockerConfig;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      result = githubService?.github?.docker?.init;
      break;
    case DeployTypes.HELM:
      const helmService: HelmService = service as unknown as HelmService;
      result = helmService?.helm?.docker?.init;
      break;
    default:
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getPort(service: Service): string {
  let result: string;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      result =
        githubService?.github?.docker?.app?.ports != null ? githubService.github.docker.app.ports.toString() : '8080';
      break;
    case DeployTypes.DOCKER:
      const dockerService: DockerService = service as DockerService;
      result = dockerService?.docker?.ports ? dockerService.docker.ports.toString() : '8080';
      break;
    case DeployTypes.HELM:
      const helmService: HelmService = service as unknown as HelmService;
      result = helmService?.helm?.docker?.app?.ports ? helmService.helm.docker.app.ports.toString() : '8080';
      break;
    default:
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getDeploymentConfig(service: Service): DeploymentConfig {
  let result: DeploymentConfig;

  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      result = githubService?.github.deployment;
      break;
    case DeployTypes.DOCKER:
      const dockerService: DockerService = service as DockerService;
      result = dockerService?.docker.deployment;
      break;
    case DeployTypes.CODEFRESH:
      const codefreshService: CodefreshService = service as CodefreshService;
      result = codefreshService?.codefresh.deployment;
      break;
    default:
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getDeployPipelineConfig(service: Service): CodefreshConfig {
  let result: CodefreshConfig;

  switch (getDeployType(service)) {
    case DeployTypes.CODEFRESH:
      const codefreshService: CodefreshService = service as CodefreshService;
      result = codefreshService?.codefresh.deploy;
      break;
    default:
      break;
  }

  return result;
}

export function getScaleToZeroConfig(service: Service): KedaScaleToZero {
  let result: KedaScaleToZero;
  switch (service?.kedaScaleToZero?.type?.toLowerCase()) {
    case 'http':
      result = service.kedaScaleToZero;
      break;
    default:
      break;
  }

  return result;
}

/**
 *
 * @param service
 * @returns
 */
export function getDestroyPipelineConfig(service: Service): CodefreshConfig {
  let result: CodefreshConfig;

  switch (getDeployType(service)) {
    case DeployTypes.CODEFRESH:
      const codefreshService: CodefreshService = service as CodefreshService;
      result = codefreshService?.codefresh.destroy;
      break;
    default:
      break;
  }

  return result;
}

/**
 * Retrieves the TCP socket port from a deployment configuration.
 * @param deployment: DeploymentConfig
 * @returns number
 */
export async function getTcpSocketPort(deployment: DeploymentConfig): Promise<number> {
  if (deployment?.readiness?.disabled) return null;
  if (deployment?.readiness?.tcpSocketPort) {
    return deployment?.readiness?.tcpSocketPort;
  }
  if (deployment?.readiness?.httpGet?.port && deployment?.readiness?.httpGet?.path) {
    return null;
  }
  const { serviceDefaults } = await GlobalConfigService.getInstance().getAllConfigs();

  return serviceDefaults.readinessTcpSocketPort;
}

/**
 * Retrieves the HTTP GET port and host from a deployment configuration.
 * @param deployment: DeploymentConfig
 * @returns { port: number; path: string }
 */
export async function getHttpGetPortAndHost(deployment: DeploymentConfig): Promise<{ port: number; path: string }> {
  if (deployment?.readiness?.disabled) return null;
  if (deployment?.readiness?.tcpSocketPort) {
    return {
      port: null,
      path: null,
    };
  }
  if (!deployment?.readiness?.httpGet?.port && !deployment?.readiness?.httpGet?.path) {
    const { serviceDefaults } = await GlobalConfigService.getInstance().getAllConfigs();

    return {
      port: serviceDefaults.readinessHttpGetPort,
      path: serviceDefaults.readinessHttpGetPath,
    };
  }
  return {
    port: deployment.readiness.httpGet.port,
    path: deployment.readiness.httpGet.path,
  };
}

export const getAppShort = (service: Service) => service?.appShort;

export const getDockerBuildPipelineId = (service) =>
  service?.helm?.docker?.pipelineId || service?.github?.docker?.pipelineId;

export async function getPublicUrl(service: Service, build: Build): Promise<string> {
  const { lifecycleDefaults, domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  let host = lifecycleDefaults.defaultUUID;
  let { http: httpDomain, grpc: grpcDomain } = domainDefaults;
  if (build?.enabledFeatures.includes(FeatureFlags.NO_DEFAULT_ENV_RESOLVE)) {
    host = NO_DEFAULT_ENV_UUID;
  }

  if (DeployTypes.HELM === getDeployType(service)) {
    const helmService = (service as unknown as HelmService).helm;
    if (helmService?.grpc) return `${service.name}-${host}.${grpcDomain}`;
  }
  return `${service.name}-${host}.${httpDomain}`;
}

export function getHost({ service, domain }: { service: Service; domain: DomainDefaults }): string {
  if (DeployTypes.HELM === getDeployType(service)) {
    const helmService = (service as unknown as HelmService).helm;
    if (helmService?.grpc) {
      if (helmService?.disableIngressHost === false) return domain?.http;
      return domain.grpc;
    }
  }
  return domain?.http;
}

export async function getUUID(service: Service, build: Build): Promise<string> {
  const configs = await GlobalConfigService.getInstance().getAllConfigs();

  if (!build) return configs.lifecycleDefaults.defaultUUID;

  if (build.enabledFeatures.includes(FeatureFlags.NO_DEFAULT_ENV_RESOLVE)) {
    return NO_DEFAULT_ENV_UUID;
  }

  if (service?.defaultUUID) return service.defaultUUID;

  return configs.lifecycleDefaults.defaultUUID;
}

export function getBuilder(service: Service): Builder {
  switch (getDeployType(service)) {
    case DeployTypes.GITHUB:
      const githubService: GithubService = service as GithubService;
      return githubService?.github?.docker?.builder;
    case DeployTypes.HELM:
      const helmService = service as HelmService;
      return helmService?.helm?.docker?.builder;
  }
  return {};
}

export async function getEcr(service: Service): Promise<string> {
  const svc = service as unknown as HelmService;
  const ecr = svc?.helm?.docker?.ecr;

  // TODO: this appShort logic check can be removed after we migrate out of appShort attribute
  if (!ecr) {
    const { lifecycleDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
    const registry = lifecycleDefaults?.ecrRegistry;
    const appShort = this.getAppShort(service);
    return appShort ? `${registry}/${appShort}/lfc` : `${registry}/lifecycle-deployments`;
  }
  return ecr;
}
