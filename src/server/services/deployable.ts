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

import rootLogger from 'server/lib/logger';
import BaseService from './_service';
import { Environment, Repository, Service, PullRequest, Build, Deploy } from 'server/models';
import Deployable from 'server/models/Deployable';
import * as YamlService from 'server/models/yaml';
import { CAPACITY_TYPE, DeployTypes } from 'shared/constants';

import { Builder, Helm, KedaScaleToZero } from 'server/models/yaml';
import GlobalConfigService from './globalConfig';

const logger = rootLogger.child({
  filename: 'services/deployable.ts',
});

export interface DeployableAttributes {
  appShort?: string;
  ecr?: string;
  buildUUID: string;
  serviceId?: number;
  buildId: number;
  name: string;
  layer?: number;
  type: string;
  dockerImage?: string;
  repositoryId?: string;
  defaultTag?: string;
  dockerfilePath?: string;
  // buildArgs: NOT IN USE
  port?: string;
  command?: string;
  arguments?: string;
  env?: Record<string, any>;
  environmentId?: number;
  branchName?: string;
  public?: boolean;
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  readinessInitialDelaySeconds?: number;
  readinessPeriodSeconds?: number;
  readinessTimeoutSeconds?: number;
  readinessSuccessThreshold?: number;
  readinessFailureThreshold?: number;
  readinessTcpSocketPort?: number;
  readinessHttpGetPath?: string;
  readinessHttpGetPort?: number;
  host?: string;
  acmARN?: string;
  initDockerfilePath?: string;
  initCommand?: string;
  initArguments?: string;
  initEnv?: Record<string, any>;
  hostPortMapping?: Record<string, any>;
  defaultInternalHostname?: string;
  defaultPublicUrl?: string;
  dependsOnServiceId?: number;
  dependsOnDeployableId?: number;
  deployPipelineId?: string;
  deployTrigger?: string;
  destroyPipelineId?: string;
  destroyTrigger?: string;
  ipWhitelist?: string;
  pathPortMapping?: Record<string, any>;
  afterBuildPipelineId?: string;
  detatchAfterBuildPipeline?: boolean;
  grpc?: boolean;
  grpcHost?: string;
  defaultGrpcHost?: string;
  defaultUUID?: string;
  serviceDisksYaml?: string;
  capacityType: string;
  runtimeName?: string;
  dockerBuildPipelineName?: string;
  active: boolean;
  dependsOnDeployableName?: string;
  defaultBranchName?: string;
  yamlConfig?: string;
  commentBranchName?: string;
  ingressAnnotations?: Record<string, any>;
  helm?: Helm;
  deploymentDependsOn?: string[];
  kedaScaleToZero?: KedaScaleToZero;
  builder?: Builder;
  nodeSelector?: Record<string, string>;
  nodeAffinity?: Record<string, unknown>;
}

export default class DeployableService extends BaseService {
  /**
   *
   * @param buildId
   * @param buildUUID
   * @param branch
   * @param service
   * @returns
   */
  private generateAttributesFromDbConfig(
    buildId: number,
    buildUUID: string,
    branch: string,
    service: Service,
    active: boolean,
    dependsOnDeployableName: string
  ): DeployableAttributes {
    let attributes: DeployableAttributes;

    try {
      attributes = {
        buildUUID,
        serviceId: service.id,
        buildId,
        name: service.name,
        layer: service.layer,
        type: service.type,
        dockerImage: service.dockerImage,
        repositoryId: service.repositoryId,
        defaultTag: service.defaultTag,
        dockerfilePath: service.dockerfilePath,
        // buildArgs: NOT IN USE
        port: service.port,
        command: service.command,
        arguments: service.arguments,
        env: service.env,
        environmentId: service.environmentId,
        public: service.public,
        cpuRequest: service.cpuRequest,
        memoryRequest: service.memoryRequest,
        cpuLimit: service.cpuLimit,
        memoryLimit: service.memoryLimit,
        readinessInitialDelaySeconds: service.readinessInitialDelaySeconds,
        readinessPeriodSeconds: service.readinessPeriodSeconds,
        readinessTimeoutSeconds: service.readinessTimeoutSeconds,
        readinessSuccessThreshold: service.readinessSuccessThreshold,
        readinessFailureThreshold: service.readinessFailureThreshold,
        readinessTcpSocketPort: service.readinessTcpSocketPort,
        readinessHttpGetPath: service.readinessHttpGetPath,
        readinessHttpGetPort: service.readinessHttpGetPort,
        host: service.host,
        acmARN: service.acmARN,
        initDockerfilePath: service.initDockerfilePath,
        initCommand: service.initCommand,
        initArguments: service.initArguments,
        initEnv: service.initEnv,
        hostPortMapping: service.hostPortMapping,
        defaultInternalHostname: service.defaultInternalHostname,
        defaultPublicUrl: service.defaultPublicUrl,
        dependsOnServiceId: service.dependsOnServiceId,
        dependsOnDeployableName,
        deployPipelineId: service.deployPipelineId,
        deployTrigger: service.deployTrigger,
        destroyPipelineId: service.destroyPipelineId,
        destroyTrigger: service.destroyTrigger,
        ipWhitelist: null,
        pathPortMapping: service.pathPortMapping,
        afterBuildPipelineId: service.afterBuildPipelineId,
        detatchAfterBuildPipeline: service.detatchAfterBuildPipeline,
        grpc: service.grpc,
        grpcHost: service.grpcHost,
        defaultGrpcHost: service.defaultGrpcHost,
        defaultUUID: service.defaultUUID,
        serviceDisksYaml: null,
        capacityType: service.capacityType,
        runtimeName: service.runtimeName,
        dockerBuildPipelineName: service.dockerBuildPipelineName,
        active,
        defaultBranchName: service.branchName,
        nodeSelector: service.nodeSelector ?? null,
        nodeAffinity: service.nodeAffinity ?? null,
      };

      if (branch != null) {
        attributes.branchName = branch;
      }

      if (service.ipWhitelist != null) {
        attributes.ipWhitelist = '{' + service.ipWhitelist + '}';
      }

      // Retrieve the service disk configuration from db and converts into yaml config
      let yamlServiceDisks: YamlService.ServiceDiskConfig[] = [];
      if (service.serviceDisks != null && service.serviceDisks.length > 0) {
        service.serviceDisks.map((serviceDisk) => {
          let yamlServiceDisk: YamlService.ServiceDiskConfig = {
            name: serviceDisk.name,
            mountPath: serviceDisk.mountPath,
            accessModes: serviceDisk.accessModes,
            storageSize: serviceDisk.storage,
            medium: serviceDisk.medium,
          };

          yamlServiceDisks.push(yamlServiceDisk);
        });

        attributes.serviceDisksYaml = JSON.stringify(yamlServiceDisks);
      }
    } catch (error) {
      logger
        .child({ service, error })
        .error(
          `[BUILD ${buildUUID}] [SERVICE ${service.name}] There was a problem generating deployable attributes from the database configuration.`
        );
      throw error;
    }

    return attributes;
  }

  /**
   *
   * @param buildId
   * @param buildUUID
   * @param repositoryId
   * @param branch
   * @param service
   * @returns
   */
  private async generateAttributesFromYamlConfig(
    buildId: number,
    buildUUID: string,
    repositoryId: number,
    branch: string,
    service: YamlService.Service,
    active: boolean,
    dependsOnDeployableName: string,
    build?: Build
  ): Promise<DeployableAttributes> {
    let attributes: DeployableAttributes;
    let deployment: YamlService.DeploymentConfig;

    try {
      if (service != null) {
        const appDockerConfig:
          | YamlService.GithubServiceAppDockerConfig
          | YamlService.DockerServiceConfig
          | YamlService.AuroraRestoreServiceConfig = YamlService.getAppDockerConfig(service);
        const initDockerConfig: YamlService.InitDockerConfig = YamlService.getInitDockerConfig(service);
        const appEnv = YamlService.getEnvironmentVariables(service);
        deployment = YamlService.getDeploymentConfig(service);
        const defaultBranchName = YamlService.getBranchName(service);
        const port = YamlService.getPort(service);
        const appShort = YamlService.getAppShort(service);
        const ecr = await YamlService.getEcr(service);
        /**
         * If the current service is a github service then we need to get the required dockerfilePath
         * Otherwise if it is a docker type service, we can set the dockerfilePath to null
         * since we will rely instead on the external dockerImage which is set later.
         */
        let dockerfilePath: string;
        if (YamlService.isGithubServiceDockerConfig(appDockerConfig)) {
          dockerfilePath = appDockerConfig.dockerfilePath;
        } else {
          dockerfilePath = null;
        }

        /**
         * @note hack feature used to force a specific github branch
         * This is useful for pos-discounts with eureka
         * @example to enable `enabledFeatures: ['hack-force-pull-request-branch','hack-force-pull-request-service-pos-discounts']
         * The property above enables the feature and
         * uses the matcher `hack-force-pull-request-service-` + <service.name> to match the service name
         * now the branch can be applied to multiple services
         */
        let branchName = branch ?? 'main';
        if (build) {
          const enabledFeatures = build?.enabledFeatures || [];
          const hasEnabledFeatures = enabledFeatures?.length > 0;
          if (hasEnabledFeatures) {
            const forcePullRequestBranch = 'hack-force-pull-request-branch';
            const isBranchHack = enabledFeatures.includes(forcePullRequestBranch);
            if (isBranchHack) {
              await build.$fetchGraph('pullRequest');
              const pullRequest = build?.pullRequest;
              const svcName = service?.name;
              const svcFeature = `hack-force-pull-request-service-${svcName}`;
              const hasFeature = enabledFeatures.includes(svcFeature);
              if (hasFeature) branchName = pullRequest?.branchName;
            }
          }
        }
        const { serviceDefaults, lifecycleDefaults, domainDefaults, kedaScaleToZero } =
          await GlobalConfigService.getInstance().getAllConfigs();
        //TODO check and throw error here?
        const defaultUUID = lifecycleDefaults.defaultUUID;
        const dockerBuildPipelineName =
          YamlService.getDockerBuildPipelineId(service) || lifecycleDefaults.buildPipeline;

        attributes = {
          ecr,
          appShort,
          buildUUID,
          serviceId: null,
          buildId,
          name: service.name,
          type: YamlService.getDeployType(service),
          dockerImage: YamlService.getDockerImage(service),
          repositoryId: repositoryId ? `${repositoryId}` : null,
          branchName,
          defaultBranchName,
          defaultTag: await YamlService.getDefaultTag(service),
          dockerfilePath: dockerfilePath ?? serviceDefaults.dockerfilePath,
          command: appDockerConfig?.command ?? null,
          arguments: appDockerConfig?.arguments ?? null,
          port,
          afterBuildPipelineId: YamlService.getAfterBuildPipelineId(service),
          detatchAfterBuildPipeline: YamlService.getDetatchAfterBuildPipeline(service),
          env: appEnv ?? {},
          initDockerfilePath: initDockerConfig?.dockerfilePath ?? null,
          initCommand: initDockerConfig?.command ?? null,
          initArguments: initDockerConfig?.arguments ?? null,
          initEnv: initDockerConfig?.env ?? {},
          public: deployment?.public ?? false,
          cpuRequest: deployment?.resource?.cpu?.request ?? serviceDefaults.cpuRequest,
          memoryRequest: deployment?.resource?.memory?.request ?? serviceDefaults.memoryRequest,
          cpuLimit: deployment?.resource?.cpu?.limit ?? null,
          memoryLimit: deployment?.resource?.memory?.limit ?? null,
          capacityType: deployment?.capacityType ?? CAPACITY_TYPE.SPOT,

          readinessInitialDelaySeconds:
            deployment?.readiness?.initialDelaySeconds ?? serviceDefaults.readinessInitialDelaySeconds,
          readinessPeriodSeconds: deployment?.readiness?.periodSeconds ?? serviceDefaults.readinessPeriodSeconds,
          readinessTimeoutSeconds: deployment?.readiness?.timeoutSeconds ?? serviceDefaults.readinessTimeoutSeconds,
          readinessSuccessThreshold:
            deployment?.readiness?.successThreshold ?? serviceDefaults.readinessSuccessThreshold,
          readinessFailureThreshold:
            deployment?.readiness?.failureThreshold ?? serviceDefaults.readinessFailureThreshold,
          readinessTcpSocketPort: await YamlService.getTcpSocketPort(deployment),
          readinessHttpGetPath: (await YamlService.getHttpGetPortAndHost(deployment))?.path,
          readinessHttpGetPort: (await YamlService.getHttpGetPortAndHost(deployment))?.port,

          host: deployment?.hostnames?.host ?? YamlService.getHost({ service, domain: domainDefaults }),
          acmARN: deployment?.hostnames?.acmARN ?? serviceDefaults.acmARN,
          defaultInternalHostname: deployment?.hostnames?.defaultInternalHostname ?? `${service.name}-${defaultUUID}`,
          defaultPublicUrl: deployment?.hostnames?.defaultPublicUrl ?? (await YamlService.getPublicUrl(service, build)),

          ipWhitelist: deployment?.network?.ipWhitelist
            ? '{' + deployment?.network?.ipWhitelist + '}'
            : serviceDefaults.defaultIPWhiteList,
          hostPortMapping: deployment?.network?.hostPortMapping ?? {},
          pathPortMapping: deployment?.network?.pathPortMapping ?? {},
          grpc: deployment?.network?.grpc?.enable ?? serviceDefaults.grpc,
          grpcHost: deployment?.network?.grpc?.host ?? domainDefaults.grpc,
          defaultGrpcHost:
            deployment?.network?.grpc?.defaultHost ?? `${service.name}-${defaultUUID}.${domainDefaults.grpc}`,

          ingressAnnotations: deployment?.network?.ingressAnnotations ?? {},
          defaultUUID: await YamlService.getUUID(service, build),
          serviceDisksYaml: deployment?.serviceDisks ? JSON.stringify(deployment.serviceDisks) : null,

          nodeSelector: deployment?.node_selector ?? null,
          nodeAffinity: deployment?.node_affinity ?? null,

          deployPipelineId: YamlService.getDeployPipelineConfig(service)?.pipelineId ?? null,

          deployTrigger: YamlService.getDeployPipelineConfig(service)?.trigger ?? null,
          destroyPipelineId: YamlService.getDestroyPipelineConfig(service)?.pipelineId ?? null,
          destroyTrigger: YamlService.getDestroyPipelineConfig(service)?.trigger ?? null,

          runtimeName: '',
          dockerBuildPipelineName,
          active,
          dependsOnDeployableName,
          helm: await YamlService.getHelmConfigFromYaml(service),
          deploymentDependsOn: service.deploymentDependsOn || [],
          kedaScaleToZero: kedaScaleToZero?.enabled ? YamlService.getScaleToZeroConfig(service) : null,
          builder: YamlService.getBuilder(service) ?? {},
        };
      }
    } catch (error) {
      logger
        .child({ service, deployment })
        .error(
          `[BUILD ${buildUUID}] [SERVICE ${service.name}] There was a problem generating deployable attributes from the yaml configuration. Error: ${error}`
        );
      throw error;
    }

    // Merge the given attributes into the default values
    return attributes;
  }

  /**
   * Merging the new attributes into the old attributes.
   * Environment variables will be merged while the rest of the db attributes will be overwritten
   * by the yaml attributes.
   *
   * @param yamlAttributes
   * @param dbAttributes
   * @returns
   */
  private mergeDeployableAttributes(
    buildUUID: string,
    service: Service | YamlService.Service,
    yamlAttributes: DeployableAttributes,
    dbAttributes: DeployableAttributes
  ): DeployableAttributes {
    let mergedAttributes: DeployableAttributes;
    try {
      if (yamlAttributes != null) {
        if (dbAttributes != null) {
          mergedAttributes = { ...dbAttributes };
        }
        mergedAttributes = { ...yamlAttributes };
      }
    } catch (error) {
      logger
        .child({ dbAttributes, yamlAttributes, error })
        .error(
          `[BUILD ${buildUUID}] [SERVICE ${service.name}] There was a problem merging deployable attributes from the database with the yaml configuration. ${error}`
        );
      throw error;
    }

    return mergedAttributes;
  }

  private async overwriteDbConfigDeployableWithYamlConfig(
    deployableServices: Map<string, DeployableAttributes>,
    buildId: number,
    buildUUID: string,
    service: Service,
    build?: Build
  ) {
    try {
      // We need to find out if the service has YAML config file overwrite the db config
      if (service.type === DeployTypes.GITHUB || service.type === DeployTypes.CODEFRESH) {
        await service.$fetchGraph('[repository, environment]');

        // Always use the branchName from the DeployableAttributes first, since it may have been overridden by the commentBranchName
        // if the user has updated the branch in the lifecycle comment of their pull request
        const branchName = deployableServices.get(service.name).branchName;
        const isClassicModeOnly = service?.environment?.classicModeOnly ?? false;
        const yamlConfig: YamlService.LifecycleConfig | null = !isClassicModeOnly
          ? await YamlService.fetchLifecycleConfigByRepository(service.repository, branchName)
          : null;
        if (yamlConfig != null) {
          const yamlService: YamlService.Service = YamlService.getDeployingServicesByName(yamlConfig, service.name);
          if (yamlService != null) {
            const serviceRepositoryId = await this.determineRepositoryId(service, build);
            deployableServices.set(
              service.name,
              this.mergeDeployableAttributes(
                buildUUID,
                service,
                await this.generateAttributesFromYamlConfig(
                  buildId,
                  buildUUID,
                  serviceRepositoryId,
                  branchName,
                  yamlService,
                  true,
                  null,
                  build
                ),
                deployableServices.get(service.name)
              )
            );
          }
        }
      }
    } catch (error) {
      logger
        .child({ service, error })
        .error(
          `[BUILD ${buildUUID}] [SERVICE ${service.name}] There was a problem overwriting the deployable object configuration with the yaml configuration.`
        );
      throw error;
    }
  }

  /**
   *
   * @param deployableServices
   * @param service
   * @param pullRequest
   */
  async updateOrCreateDeployableAttributesUsingDbConfig(
    deployableServices: Map<string, DeployableAttributes>,
    buildId: number,
    buildUUID: string,
    service: Service,
    branchName: string,
    active: boolean,
    mergeYaml: boolean,
    build?: Build
  ) {
    try {
      await service.$fetchGraph('serviceDisks');

      deployableServices.set(
        service.name,
        this.generateAttributesFromDbConfig(buildId, buildUUID, branchName, service, active, null)
      );

      if (mergeYaml) {
        await this.overwriteDbConfigDeployableWithYamlConfig(deployableServices, buildId, buildUUID, service, build);
      }

      const dependencies: Service[] = await this.db.models.Service.query().where('dependsOnServiceId', service.id);

      logger.debug(
        `[BUILD ${buildUUID}] ${service.name} has ${dependencies.length} database dependency(dependsOnServiceId).`
      );

      await Promise.all(
        dependencies.map(async (dependency) => {
          await dependency.$fetchGraph('serviceDisks');

          deployableServices.set(
            dependency.name,
            this.generateAttributesFromDbConfig(buildId, buildUUID, branchName, dependency, active, service.name)
          );

          if (mergeYaml) {
            await this.overwriteDbConfigDeployableWithYamlConfig(
              deployableServices,
              buildId,
              buildUUID,
              dependency,
              build
            );
          }
        })
      );
    } catch (error) {
      logger
        .child({ service, error })
        .error(
          `[BUILD ${buildUUID}] [SERVICE ${service.name}] There was a problem creating or updating the deployable attributes from the database configuration.`
        );
      throw error;
    }
  }

  /**
   *
   * @param deployableServices
   * @param service
   * @param pullRequest
   */
  async updateOrCreateDeployableAttributesUsingYAMLConfig(
    deployableServices: Map<string, DeployableAttributes>,
    buildId: number,
    buildUUID: string,
    service: YamlService.Service,
    repositoryId: number,
    branchName: string,
    active: boolean,
    parentDeployableName: string,
    build?: Build
  ) {
    try {
      // Look for service entry in the config database. Just ingest the env variable in case secrets stored in the db but not in yaml config file.
      const dbService: Service = await Service.query()
        .findOne({ name: service.name })
        .catch((error) => {
          logger
            .child({ error })
            .debug(`[BUILD ${buildUUID}] Not really an error. Just no db config for this yaml based service`);
          return null;
        });

      let repository: Repository;
      let branch: string;
      const repoName: string = YamlService.getRepositoryName(service);
      if (repoName != null) {
        repository = await YamlService.resolveRepository(YamlService.getRepositoryName(service));

        if (repository != null) {
          branch =
            repository?.githubRepositoryId != null && repository?.githubRepositoryId === repositoryId
              ? branchName
              : YamlService.getBranchName(service);
        } else {
          await build?.$fetchGraph('[pullRequest, environment]');
          await build?.pullRequest?.$fetchGraph('[repository]');
          repository = build?.pullRequest?.repository;
          if (!repository) {
            logger.error(
              `[BUILD ${buildUUID}] [SERVICE ${service.name}] Unable to find ${repoName} from Lifecycle database. Please verify the repository name and make sure Lifecycle Github app is installed on repository.`
            );
          }
        }
      }

      const deployableAttributes: DeployableAttributes = await this.generateAttributesFromYamlConfig(
        buildId,
        buildUUID,
        repository?.githubRepositoryId ?? null,
        branch,
        service,
        active,
        parentDeployableName,
        build
      );

      // Need to merge with existing config since it may come from db config
      if (dbService != null) {
        if (dbService.env != null) {
          deployableAttributes.env = {
            ...dbService.env,
            ...deployableAttributes.env,
          };
        }

        if (dbService.initEnv != null) {
          deployableAttributes.initEnv = {
            ...dbService.initEnv,
            ...deployableAttributes.initEnv,
          };
        }
      }

      if (!deployableServices.has(deployableAttributes.name)) {
        deployableServices.set(deployableAttributes.name, deployableAttributes);
      } else {
        deployableServices.set(
          deployableAttributes.name,
          this.mergeDeployableAttributes(
            buildUUID,
            service,
            deployableAttributes,
            deployableServices.get(deployableAttributes.name)
          )
        );
      }
    } catch (error) {
      logger
        .child({ deployableServices, service, error })
        .error(
          `[BUILD ${buildUUID}] [SERVICE ${service.name}] There was a problem creating or updating the deployable attributes from the yaml configuration when using a services yaml configuration.`
        );
      throw error;
    }
  }

  /**
   * Resolve service configuration from the database service table
   * @param deployableServices
   * @param buildId
   * @param buildUUID
   * @param pullRequest
   * @param environment
   */
  private async updateOrCreateDeployableUsingDbConfig(
    deployableServices: Map<string, DeployableAttributes>,
    buildId: number,
    buildUUID: string,
    pullRequest: PullRequest,
    environment: Environment,
    build?: Build
  ) {
    try {
      const attribution = async (services: Service[], active: boolean) => {
        if (services != null && services.length > 0) {
          await Promise.all(
            services.map(async (dbEnvService) => {
              try {
                let branchName: string;
                if (dbEnvService.repositoryId != null) {
                  // If this service is the same as the service where the pull request is opened, use the branch name from the pull request.
                  if (Number(dbEnvService.repositoryId) === pullRequest.repository.githubRepositoryId) {
                    branchName = pullRequest.branchName;
                  }
                  // External dependencies should use the branch name from the config table, or from the lifecycle comment if it has been updated.
                  else {
                    /*
                      We need to try and determine if a deployable already exists so that if it does,
                      we can leverage the commentBranchName from the deployable table since the commentBranchName
                      should always override any other branch name. If the deployable or the commentBranchName
                      do not exist, we will use the branch name defined in the service.
                    */
                    let deployable: Deployable = await this.db.models.Deployable.query()
                      .where('buildUUID', buildUUID)
                      .where('buildId', buildId)
                      .where('name', dbEnvService.name)
                      .first()
                      .catch(() => {
                        return undefined;
                      });
                    branchName = deployable?.commentBranchName ?? dbEnvService.branchName;
                  }
                } else {
                  if (dbEnvService.type === DeployTypes.CONFIGURATION) {
                    branchName = dbEnvService.branchName;
                  }
                }

                // Generate and update/create attributes for the service and all the services depend on it
                await this.updateOrCreateDeployableAttributesUsingDbConfig(
                  deployableServices,
                  buildId,
                  buildUUID,
                  dbEnvService,
                  branchName,
                  active,
                  true,
                  build
                );
              } catch (error) {
                logger
                  .child({ dbEnvService, error })
                  .error(
                    `[BUILD ${buildUUID}] [SERVICE ${dbEnvService.name}] There was a problem during attribution while using the database configuration.`
                  );
                throw error;
              }
            })
          );
        }
      };

      if (environment != null) {
        await environment.$fetchGraph('[defaultServices, optionalServices]');
        await pullRequest.$fetchGraph('repository');

        await attribution(environment.defaultServices, true);
        await attribution(environment.optionalServices, false);
      }
    } catch (error) {
      logger
        .child({ environment, error })
        .error(
          `[BUILD ${buildUUID}] [ENVIRONMENT ${environment.name}] There was a problem creating or update the deployable object from the database configuration.`
        );
      throw error;
    }
  }

  /**
   * Resolve service configuration from YAML config file in the repository
   * @param deployableServices
   * @param buildId
   * @param buildUUID
   * @param pullRequest
   */
  private async updateOrCreateDeployableUsingYamlConfig(
    deployableServices: Map<string, DeployableAttributes>,
    buildId: number,
    buildUUID: string,
    pullRequest: PullRequest,
    build?: Build
  ) {
    try {
      const attribution = async (
        services: YamlService.DependencyService[],
        yamlConfig: YamlService.LifecycleConfig,
        active: boolean
      ) => {
        if (services != null && services.length > 0) {
          await Promise.all(
            services.map(async (yamlEnvService) => {
              try {
                //
                // Using DatabaseYamlService. If environment service is defined in database instead of YAML (using service ID in the YAML config)
                //
                if (yamlEnvService.serviceId != null) {
                  try {
                    const service: Service = await Service.query()
                      .findOne({
                        id: yamlEnvService.serviceId,
                      })
                      .catch((error) => {
                        logger.child({ error }).warn(`[BUILD ${buildUUID}] error`);
                        return null;
                      });

                    if (service != null) {
                      // Ingest database configuration based on the yaml meta data along with all the internal dependencies (dependsOnServiceId) in the database
                      await this.updateOrCreateDeployableAttributesUsingDbConfig(
                        deployableServices,
                        buildId,
                        buildUUID,
                        service,
                        service.repositoryId != null &&
                          Number(service.repositoryId) === pullRequest.repository.githubRepositoryId
                          ? pullRequest.branchName
                          : service.branchName,
                        active,
                        false,
                        build
                      );
                    } else {
                      logger.error(`[BUILD ${buildUUID}] [yamlEnvService ${yamlEnvService}]`);
                      logger.error(`[BUILD ${buildUUID}] [service ${service}]`);
                      logger.error(
                        `[BUILD ${buildUUID}] Service ID (${yamlEnvService.serviceId}) cannot be find in the database configuration.`
                      );
                    }
                  } catch (error) {
                    logger
                      .child({ yamlEnvService, error })
                      .error(
                        `[BUILD ${buildUUID}] [SERVICE ${yamlEnvService.name}]  There was a problem creating or updating the deployable object from the yaml configuration when using a services ID.`
                      );
                    throw error;
                  }
                } else {
                  try {
                    //
                    // Using YAML Config
                    //
                    // By default, repository is the same as the current pull request local repository
                    let repository: Repository = pullRequest.repository;

                    // By default, Service defined in local repo. Using local YAML
                    let dependencyYamlConfig: YamlService.LifecycleConfig = yamlConfig;

                    let branchName: string = pullRequest.branchName;
                    let deploy: Deploy;
                    // Service defined in remote repo. Need to fetch remote YAML
                    if (yamlEnvService?.repository != null) {
                      // If the dependency service does not have a branch name defined use 'main' as the default branch name.
                      branchName = yamlEnvService?.branch ?? 'main';
                      // Check if the deployable has a commentBranchName which is set in the lifecycle comment. If it does
                      // Use the commentBranchName to override whatever branchName has been set from the YAML.
                      deploy = pullRequest.build.deploys.find((d) => d.deployable.name === yamlEnvService.name);
                      branchName = deploy?.deployable.commentBranchName ?? branchName;

                      repository = await YamlService.resolveRepository(yamlEnvService.repository);

                      // Fetch the lifecycle yaml from the dependency services repositories and parse them
                      dependencyYamlConfig = await YamlService.fetchLifecycleConfig(
                        yamlEnvService.repository,
                        branchName
                      );
                    }

                    let yamlService: YamlService.Service;
                    if (dependencyYamlConfig != null) {
                      yamlService = YamlService.getDeployingServicesByName(dependencyYamlConfig, yamlEnvService.name);

                      if (yamlService != null) {
                        if (yamlService.requires != null) {
                          // Just like Database config, we only handle 1 level deep inner dependency
                          await Promise.all(
                            yamlService.requires.map(async (requireService) => {
                              let innerService: YamlService.Service;
                              innerService = YamlService.getDeployingServicesByName(
                                dependencyYamlConfig,
                                requireService.name
                              );
                              if (innerService != null) {
                                await this.updateOrCreateDeployableAttributesUsingYAMLConfig(
                                  deployableServices,
                                  buildId,
                                  buildUUID,
                                  innerService,
                                  repository.githubRepositoryId,
                                  branchName,
                                  active,
                                  yamlService.name,
                                  build
                                );
                              }
                            })
                          );
                        }

                        await this.updateOrCreateDeployableAttributesUsingYAMLConfig(
                          deployableServices,
                          buildId,
                          buildUUID,
                          yamlService,
                          repository.githubRepositoryId,
                          branchName,
                          active,
                          null,
                          build
                        );
                      } else {
                        logger.warn(
                          `[BUILD ${buildUUID}] Service Name (${yamlEnvService.name}) cannot be find in the yaml configuration. Is it referenced via the Lifecycle database?`
                        );
                      }
                    } else {
                      logger
                        .child({ repository, deploy })
                        .warn(
                          `[BUILD ${buildUUID}][DEPLOY ${deploy?.uuid}] Unable to locate YAML config file from ${repository?.fullName}:${branchName}. Is this a database service?`
                        );
                    }
                  } catch (error) {
                    logger
                      .child({ error, yamlEnvService })
                      .error(
                        `[BUILD ${buildUUID}] There was a problem creating or updating the deployable object from the yaml configuration when using a services yaml configuration.`
                      );
                    throw error;
                  }
                }
              } catch (error) {
                logger
                  .child({ error, yamlEnvService })
                  .error(
                    `[BUILD ${buildUUID}] There was a problem creating or updating the deployable object from the yaml configuration.`
                  );
                throw error;
              }
            })
          );
        }
      };

      if (pullRequest == null) return;

      await pullRequest.$fetchGraph('[build.[deploys.[deployable], environment], repository]');
      if (pullRequest.repository != null && pullRequest.branchName != null) {
        const isClassicModeOnly = pullRequest?.build?.environment?.classicModeOnly ?? false;
        const yamlConfig: YamlService.LifecycleConfig = !isClassicModeOnly
          ? await YamlService.fetchLifecycleConfigByRepository(pullRequest.repository, pullRequest.branchName)
          : null;

        if (yamlConfig != null) {
          const yamlEnvServices: YamlService.DependencyService[] = [
            ...(yamlConfig.environment?.defaultServices ?? []),
            ...(yamlConfig.environment?.optionalServices ?? []),
          ];

          // New schema allow default/optional services defined w/o using database
          if (yamlEnvServices.length > 0) {
            await attribution(yamlConfig.environment.optionalServices, yamlConfig, false);
            await attribution(yamlConfig.environment.defaultServices, yamlConfig, true);
          } else {
            // For older version of lifecycle.yaml, there are no default or optional service defined in environment.
            // Take all the services defined in the yaml and merge with existing db config
            if (yamlConfig.services != null && yamlConfig.services.length > 0) {
              await Promise.all(
                yamlConfig.services.map(async (service) => {
                  // Handling older schema
                  // For each of the yaml service definition, merge with db configuration
                  deployableServices.set(
                    service.name,
                    this.mergeDeployableAttributes(
                      buildUUID,
                      service,
                      await this.generateAttributesFromYamlConfig(
                        buildId,
                        buildUUID,
                        pullRequest.repository.githubRepositoryId,
                        pullRequest.branchName,
                        service,
                        true,
                        null,
                        build
                      ),
                      deployableServices.get(service.name)
                    )
                  );
                })
              );
            }
          }
        }
      } else {
        logger.warn(`[BUILD ${buildUUID}] Missing PR branch name.`);
      }
    } catch (error) {
      logger
        .child({ error })
        .error(
          `[BUILD ${buildUUID}] There was a problem creating or updating the deployable object from the yaml configuration.`
        );
      throw error;
    }
  }

  /**
   *
   * @param buildId
   * @param buildUUID
   * @param pullRequest
   * @param environment
   * @returns
   */
  public async upsertDeployables(
    buildId: number,
    buildUUID: string,
    pullRequest: PullRequest,
    environment: Environment,
    build?: Build
  ): Promise<Deployable[]> {
    // We are going to ingest all the database and yaml configuration and process in the memory before writes into the database
    let deployables: Deployable[];

    // Temporary storage for all the deployable configurations in memory
    const deployableServices: Map<string, DeployableAttributes> = new Map<string, DeployableAttributes>();
    try {
      if (pullRequest != null) {
        if (pullRequest.branchName == null) {
          await this.db.services.PullRequest.updatePullRequestBranchName(pullRequest);
        }

        // Let's deal with services db config and YAML override here first before the local YAML override below
        await this.updateOrCreateDeployableUsingDbConfig(
          deployableServices,
          buildId,
          buildUUID,
          pullRequest,
          environment,
          build
        );

        // Next read the YAML config file from the PR's repository and branch
        // Overwrite the db config exists in the YAML + any YAML only configurations
        await this.updateOrCreateDeployableUsingYamlConfig(deployableServices, buildId, buildUUID, pullRequest, build);

        // Finally, Upsert the deployables into the database
        deployables = await this.upsertDeployablesWithDatabase(
          buildUUID,
          buildId,
          Array.from(deployableServices.values())
        );
      } else {
        logger.fatal(`[BUILD ${buildUUID}] Pull Request cannot be undefined`);
      }
    } catch (error) {
      logger
        .child({ environment, error })
        .error(`[BUILD ${buildUUID}] [ENVIRONMENT ${environment.name}] There was a problem upserting the deployables.`);
      throw error;
    }
    logger.info(`[BUILD ${buildUUID}] Created/Updated ${deployables.length} deployables`);
    return deployables;
  }

  /**
   * Write deployable
   * @param buildUUID
   * @param buildId
   * @param deployableAttributes
   * @returns
   */
  private async upsertDeployablesWithDatabase(
    buildUUID: string,
    buildId: number,
    deployableAttributes: DeployableAttributes[]
  ): Promise<Deployable[]> {
    const deployables: Deployable[] = [];

    if (deployableAttributes?.length > 0) {
      await Promise.all(
        deployableAttributes.map(async (deployableAttr) => {
          let deployable: Deployable = await this.db.models.Deployable.query()
            .where('buildUUID', buildUUID)
            .where('name', deployableAttr.name)
            .where('buildId', buildId)
            .first()
            .catch((error) => {
              logger
                .child({ error })
                .error(`[BUILD ${buildUUID}] [SERVICE ${deployableAttr.name}] Unable to search deployable`);
              return undefined;
            });

          if (deployable != null) {
            await deployable
              .$query()
              .patch(deployableAttr as object)
              .catch((error) => {
                logger
                  .child({ error })
                  .error(`[BUILD ${buildUUID}] [SERVICE ${deployableAttr.name}] Unable to patch deployable`);
              });
          } else {
            deployable = await this.db.models.Deployable.create(deployableAttr as object).catch((error) => {
              logger
                .child({ error })
                .error(`[BUILD ${buildUUID}] [SERVICE ${deployableAttr.name}] Unable to create new deployable`);
              return undefined;
            });
          }

          if (deployable != null) {
            deployables.push(deployable);
          }
        })
      );
    }

    return deployables;
  }

  /**
   * determineRepositoryId
   * @description determines the repositoryId for the service
   * @note
   * this is useful if the service is and won't be defined in the lifecycle database
   * because it's produced from a 3rd party for example
   * @param service
   * @param build
   * @returns number|null
   */
  private async determineRepositoryId(service, build) {
    if (service?.repositoryId) {
      return Number(service?.repositoryId);
    }
    let repoId = build?.pullRequest?.repository?.githubRepositoryId;
    if (repoId) return Number(repoId);
    build.$fetchGraph('pullRequest.repository');
    repoId = build?.pullRequest?.repository?.githubRepositoryId;
    return repoId ? Number(repoId) : null;
  }
}
