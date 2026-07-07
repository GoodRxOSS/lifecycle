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

import { getLogger } from 'server/lib/logger';
import { resolveBuildSourceRepository } from 'server/lib/buildSource';
import BaseService from './_service';
import { Environment, Repository, PullRequest, Build, Deploy } from 'server/models';
import Deployable from 'server/models/Deployable';
import * as YamlService from 'server/models/yaml';
import { CAPACITY_TYPE, DeployTypes } from 'shared/constants';

import { Builder, Helm } from 'server/models/yaml';
import GlobalConfigService from './globalConfig';

export type DeployableConfigSource = 'yaml';

export interface DeployableReconciliationEntry {
  name: string;
  source: DeployableConfigSource;
  reconcileEligible: boolean;
  resolvedFromRepositoryId?: number | null;
  branchName?: string | null;
}

export interface DeployableReconciliationResult {
  deployables: Deployable[];
  canReconcile: boolean;
  reconcileEligibleDeployables: DeployableReconciliationEntry[];
  filterGithubRepositoryId?: number | null;
}

export interface DeployableAttributes {
  appShort?: string;
  ecr?: string;
  buildUUID: string;
  buildId: number;
  name: string;
  layer?: number;
  type: string;
  dockerImage?: string;
  repositoryId?: number;
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
  builder?: Builder;
  envLens?: boolean;
  nodeSelector?: Record<string, string>;
  nodeAffinity?: Record<string, unknown>;
  source?: DeployableConfigSource;
  reconcileEligible?: boolean;
  resolvedFromRepositoryId?: number | null;
}

export default class DeployableService extends BaseService {
  private isYamlReconcileEligible(type: string): boolean {
    return type !== DeployTypes.CONFIGURATION;
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
              if (hasFeature) branchName = pullRequest?.branchName ?? branchName;
            }
          }
        }
        const { serviceDefaults, lifecycleDefaults, domainDefaults, buildDefaults } =
          await GlobalConfigService.getInstance().getAllConfigs();
        //TODO check and throw error here?
        const defaultUUID = lifecycleDefaults.defaultUUID;
        const dockerBuildPipelineName =
          YamlService.getDockerBuildPipelineId(service) || lifecycleDefaults.buildPipeline;

        attributes = {
          ecr,
          appShort,
          buildUUID,
          buildId,
          name: service.name,
          type: YamlService.getDeployType(service),
          dockerImage: YamlService.getDockerImage(service),
          repositoryId: repositoryId ?? null,
          resolvedFromRepositoryId: repositoryId != null ? Number(repositoryId) : null,
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
          builder: YamlService.getEffectiveBuilder(service, buildDefaults?.engine) ?? {},
          envLens: await YamlService.getEnvLens(service),
          source: 'yaml',
          reconcileEligible: this.isYamlReconcileEligible(YamlService.getDeployType(service)),
        };
      }
    } catch (error) {
      getLogger({
        buildUUID,
        service: service.name,
        error,
      }).error('Deployable: generate attributes from YAML failed');
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
    service: YamlService.Service,
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
      getLogger({
        buildUUID,
        service: service.name,
        error,
      }).error('Deployable: merge attributes failed');
      throw error;
    }

    return mergedAttributes;
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
            getLogger({ buildUUID, service: service.name }).error(
              `Unable to find ${repoName} from Lifecycle database. Verify repository name and ensure Lifecycle Github app is installed`
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
      getLogger({
        buildUUID,
        service: service.name,
        error,
      }).error('Deployable: upsert attributes from YAML failed');
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
    pullRequest: PullRequest | null | undefined,
    build?: Build,
    filterGithubRepositoryId?: number,
    sourceRef?: string | null,
    sourceBranch?: string | null
  ): Promise<boolean> {
    try {
      let allReferencedYamlConfigsResolved = true;
      let sourceRepository: Repository | null = null;
      let rootBranch: string | null = null;
      let rootBaseConfigRef: string | null = null;
      let sourceBuild: Build | null = null;
      let filterRepositoryFullName: string | null = null;
      let targetAttributionResolved = filterGithubRepositoryId == null || sourceBranch == null;
      let targetAttributionFailed = false;
      if (filterGithubRepositoryId) {
        const filterRepo = await this.db.models.Repository.query()
          .findOne({ githubRepositoryId: filterGithubRepositoryId })
          .whereNull('deletedAt')
          .catch((error) => {
            getLogger({ error, buildUUID, filterGithubRepositoryId }).warn(
              'Deployable: targeted source repository lookup failed'
            );
            return null;
          });
        if (!filterRepo) {
          getLogger({ buildUUID, filterGithubRepositoryId }).warn(
            'Deployable: targeted source repository is not live; skipping reconciliation'
          );
          return false;
        }
        filterRepositoryFullName = filterRepo?.fullName?.toLowerCase() ?? null;
      }

      const targetsSource = (repository: Repository | null | undefined, branchName: string | null | undefined) =>
        filterGithubRepositoryId == null ||
        (repository?.githubRepositoryId != null &&
          Number(repository.githubRepositoryId) === Number(filterGithubRepositoryId) &&
          (sourceBranch == null || branchName === sourceBranch));

      const attribution = async (
        services: YamlService.DependencyService[],
        yamlConfig: YamlService.LifecycleConfig,
        active: boolean,
        rootRepository: Repository,
        rootBranch: string,
        rootBuild: Build | null
      ) => {
        if (services != null && services.length > 0) {
          await Promise.all(
            services.map(async (yamlEnvService) => {
              try {
                if (yamlEnvService.serviceId != null) {
                  if (filterGithubRepositoryId != null && sourceBranch != null) targetAttributionFailed = true;
                  getLogger({ buildUUID, service: yamlEnvService.name, serviceId: yamlEnvService.serviceId }).warn(
                    'serviceId references in lifecycle.yaml are no longer supported; skipping service ' +
                      yamlEnvService.name
                  );
                  return;
                }

                //
                // Using YAML Config
                //
                // By default, the service is defined in the source repository's YAML.
                let repository: Repository = rootRepository;

                // By default, Service defined in local repo. Using local YAML
                let dependencyYamlConfig: YamlService.LifecycleConfig = yamlConfig;

                let branchName: string = rootBranch;
                let deploy: Deploy;
                // Service defined in remote repo. Need to fetch remote YAML
                if (yamlEnvService?.repository != null) {
                  // Skip remote services that don't match the triggering repository.
                  // This avoids re-fetching all remote YAMLs on a targeted push, while
                  // still updating the service whose repo actually changed.
                  if (
                    filterRepositoryFullName &&
                    yamlEnvService.repository.toLowerCase() !== filterRepositoryFullName
                  ) {
                    getLogger({ buildUUID, service: yamlEnvService.name }).debug(
                      'Skipping remote YAML fetch for filtered deploy'
                    );
                    return;
                  }
                  // If the dependency service does not have a branch name defined use 'main' as the default branch name.
                  branchName = yamlEnvService?.branch ?? 'main';
                  // Check if the deployable has a commentBranchName which is set in the lifecycle comment. If it does
                  // Use the commentBranchName to override whatever branchName has been set from the YAML.
                  deploy = rootBuild?.deploys?.find((d) => d.deployable.name === yamlEnvService.name);
                  branchName = deploy?.deployable.commentBranchName ?? branchName;

                  repository = await YamlService.resolveRepository(yamlEnvService.repository);
                  if (!repository || repository.deletedAt != null) {
                    if (yamlEnvService.repository.toLowerCase() === filterRepositoryFullName) {
                      targetAttributionFailed = true;
                    }
                    allReferencedYamlConfigsResolved = false;
                    getLogger({ buildUUID, service: yamlEnvService.name }).warn(
                      'Deployable: referenced repository is not live; skipping service'
                    );
                    return;
                  }

                  const sourceRefTargetsDependency =
                    sourceBuild?.triggerType === 'api' &&
                    sourceRef != null &&
                    filterGithubRepositoryId != null &&
                    sourceBranch != null &&
                    targetsSource(repository, branchName);
                  if (filterGithubRepositoryId != null && !targetsSource(repository, branchName)) {
                    getLogger({ buildUUID, service: yamlEnvService.name, branchName }).debug(
                      'Skipping remote YAML fetch outside filtered source branch'
                    );
                    return;
                  }
                  if (filterGithubRepositoryId != null && sourceBranch != null) targetAttributionResolved = true;

                  const dependencyConfigRef = sourceRefTargetsDependency ? sourceRef : branchName;
                  dependencyYamlConfig = await YamlService.fetchLifecycleConfigByRepository(
                    repository,
                    dependencyConfigRef
                  );
                } else {
                  deploy = rootBuild?.deploys?.find((d) => d.deployable.name === yamlEnvService.name);
                  branchName = deploy?.deployable.commentBranchName ?? branchName;
                  if (filterGithubRepositoryId != null && !targetsSource(repository, branchName)) return;
                  if (filterGithubRepositoryId != null && sourceBranch != null) targetAttributionResolved = true;
                }

                if (dependencyYamlConfig != null) {
                  const resolvedService = YamlService.resolveExactEnvironmentService(
                    dependencyYamlConfig,
                    yamlEnvService
                  );

                  if (resolvedService != null) {
                    const yamlService = resolvedService.service;
                    if (yamlService.requires != null) {
                      // Just like Database config, we only handle 1 level deep inner dependency
                      await Promise.all(
                        resolvedService.requiredServices.map(async (innerService) => {
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
                    if (filterGithubRepositoryId != null && sourceBranch != null) targetAttributionFailed = true;
                    getLogger({ buildUUID, service: yamlEnvService.name }).warn(
                      'Service cannot be found in yaml configuration. Is it referenced via the Lifecycle database?'
                    );
                  }
                } else {
                  allReferencedYamlConfigsResolved = false;
                  if (filterGithubRepositoryId != null && sourceBranch != null) targetAttributionFailed = true;
                  getLogger({ buildUUID, deployUUID: deploy?.uuid, repository: repository?.fullName }).warn(
                    `Unable to locate YAML config file from ${repository?.fullName}:${branchName}. Is this a database service?`
                  );
                }
              } catch (error) {
                getLogger({
                  buildUUID,
                  service: yamlEnvService.name,
                  error,
                }).error('Deployable: create/update from yaml failed');
                throw error;
              }
            })
          );
        }
      };

      if (pullRequest == null && build == null) return false;

      if (pullRequest != null) {
        await pullRequest.$fetchGraph('[build.[deploys.[deployable], environment], repository]');
        sourceRepository = pullRequest.repository;
        rootBranch = pullRequest.branchName;
        rootBaseConfigRef = pullRequest.branchName;
        sourceBuild = pullRequest.build;
      } else if (build != null) {
        await build.$fetchGraph('[deploys.[deployable], environment]');
        sourceRepository = await resolveBuildSourceRepository(build);
        rootBranch = build.branchName ?? null;
        rootBaseConfigRef = build.configSha ?? build.branchName ?? null;
        sourceBuild = build;
      }

      if (
        sourceRepository != null &&
        sourceRepository.deletedAt == null &&
        rootBranch != null &&
        rootBaseConfigRef != null
      ) {
        const sourceRefTargetsRoot =
          filterGithubRepositoryId != null && sourceBranch != null && targetsSource(sourceRepository, rootBranch);
        const rootConfigRef =
          sourceBuild?.triggerType === 'api' && sourceRefTargetsRoot
            ? sourceRef ?? rootBaseConfigRef
            : rootBaseConfigRef;
        const yamlConfig: YamlService.LifecycleConfig = await YamlService.fetchLifecycleConfigByRepository(
          sourceRepository,
          rootConfigRef
        );

        if (yamlConfig != null) {
          if (filterGithubRepositoryId != null && sourceBranch != null && sourceRefTargetsRoot) {
            targetAttributionResolved = true;
          }
          const yamlEnvServices: YamlService.DependencyService[] = [
            ...(yamlConfig.environment?.defaultServices ?? []),
            ...(yamlConfig.environment?.optionalServices ?? []),
          ];

          // New schema allow default/optional services defined w/o using database
          if (yamlEnvServices.length > 0) {
            await attribution(
              yamlConfig.environment.optionalServices,
              yamlConfig,
              false,
              sourceRepository,
              rootBranch,
              sourceBuild
            );
            await attribution(
              yamlConfig.environment.defaultServices,
              yamlConfig,
              true,
              sourceRepository,
              rootBranch,
              sourceBuild
            );
          } else {
            // For older version of lifecycle.yaml, there are no default or optional service defined in environment.
            // Take all the services defined in the yaml and merge with existing db config
            const legacyRootMatchesTarget = targetsSource(sourceRepository, rootBranch);
            if (filterGithubRepositoryId != null && !legacyRootMatchesTarget) {
              return false;
            }
            if (filterGithubRepositoryId != null && sourceBranch != null) targetAttributionResolved = true;
            if (yamlConfig.services != null && yamlConfig.services.length > 0) {
              const legacySourceRepository = sourceRepository;
              const legacyRootBranch = rootBranch;
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
                        legacySourceRepository.githubRepositoryId,
                        legacyRootBranch,
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
          return allReferencedYamlConfigsResolved && targetAttributionResolved && !targetAttributionFailed;
        }
      } else {
        getLogger({ buildUUID }).warn('Build source repository or ref missing');
      }
      return false;
    } catch (error) {
      getLogger({ buildUUID, error }).error('Deployable: create/update from yaml failed');
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
    pullRequest: PullRequest | null | undefined,
    environment: Environment,
    build?: Build,
    filterGithubRepositoryId?: number,
    sourceRef?: string | null,
    sourceBranch?: string | null
  ): Promise<DeployableReconciliationResult> {
    // We are going to ingest all the database and yaml configuration and process in the memory before writes into the database
    let deployables: Deployable[] = [];
    let canReconcile = false;

    // PR-less builds resolve lifecycle.yaml from their own repository and pinned SHA/branch columns.
    const hasBuildSource = build?.githubRepositoryId != null && (build?.configSha != null || build?.branchName != null);

    // Temporary storage for all the deployable configurations in memory
    const deployableServices: Map<string, DeployableAttributes> = new Map<string, DeployableAttributes>();
    try {
      if (pullRequest != null || hasBuildSource) {
        if (pullRequest != null && pullRequest.branchName == null) {
          await this.db.services.PullRequest.updatePullRequestBranchName(pullRequest);
        }

        // Read the YAML config file from the PR's repository and branch
        canReconcile = await this.updateOrCreateDeployableUsingYamlConfig(
          deployableServices,
          buildId,
          buildUUID,
          pullRequest,
          build,
          filterGithubRepositoryId,
          sourceRef,
          sourceBranch
        );

        // Finally, Upsert the deployables into the database
        deployables = await this.upsertDeployablesWithDatabase(
          buildUUID,
          buildId,
          Array.from(deployableServices.values())
        );
      } else {
        getLogger({ buildUUID }).fatal('Build source cannot be undefined');
      }
    } catch (error) {
      getLogger({
        buildUUID,
        environment: environment.name,
        error,
      }).error('Deployable: upsert failed');
      throw error;
    }
    getLogger({ buildUUID }).info(`Deployable: upserted count=${deployables.length}`);
    return {
      deployables,
      canReconcile,
      filterGithubRepositoryId: filterGithubRepositoryId ?? null,
      reconcileEligibleDeployables: Array.from(deployableServices.values())
        .filter((deployable) => deployable.reconcileEligible)
        .map((deployable) => ({
          name: deployable.name,
          source: deployable.source ?? 'yaml',
          reconcileEligible: deployable.reconcileEligible ?? false,
          resolvedFromRepositoryId: deployable.resolvedFromRepositoryId ?? null,
          branchName: deployable.commentBranchName ?? deployable.branchName ?? null,
        })),
    };
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
              getLogger({
                buildUUID,
                service: deployableAttr.name,
                error,
              }).error('Deployable: search failed');
              return undefined;
            });

          if (deployable != null) {
            await deployable
              .$query()
              .patch(deployableAttr as object)
              .catch((error) => {
                getLogger({
                  buildUUID,
                  service: deployableAttr.name,
                  error,
                }).error('Deployable: patch failed');
              });
          } else {
            deployable = await this.db.models.Deployable.create(deployableAttr as object).catch((error) => {
              getLogger({
                buildUUID,
                service: deployableAttr.name,
                error,
              }).error('Deployable: create failed');
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
}
