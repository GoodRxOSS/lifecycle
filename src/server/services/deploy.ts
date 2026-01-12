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

import BaseService from './_service';
import { Environment, Build, Service, Deploy, Deployable } from 'server/models';
import * as codefresh from 'server/lib/codefresh';
import { getLogger, withLogContext } from 'server/lib/logger/index';
import hash from 'object-hash';
import { DeployStatus, DeployTypes } from 'shared/constants';
import * as cli from 'server/lib/cli';
import RDS from 'aws-sdk/clients/rds';
import resourceGroupsTagging from 'aws-sdk/clients/resourcegroupstaggingapi';
import { merge } from 'lodash';
import { nanoid } from 'nanoid';
import Objection from 'objection';
import * as YamlService from 'server/models/yaml';
import * as github from 'server/lib/github';
import { generateDeployTag, constructEcrRepoPath } from 'server/lib/utils';
import { LifecycleYamlConfigOptions } from 'server/models/yaml/types';
import { getShaForDeploy } from 'server/lib/github';
import GlobalConfigService from 'server/services/globalConfig';
import { PatternInfo, extractEnvVarsWithBuildDependencies, waitForColumnValue } from 'shared/utils';
import { getLogs } from 'server/lib/codefresh';
import { buildWithNative } from 'server/lib/nativeBuild';
import { constructEcrTag } from 'server/lib/codefresh/utils';
import { ChartType, determineChartType } from 'server/lib/nativeHelm';

export interface DeployOptions {
  ownerId?: number;
  repositoryId?: string;
  installationId?: number;
  repositoryBranchName?: string;
  isDeploy?: boolean;
  pullRequestId?: number;
  environmentId?: number;
  lifecycleConfig?: LifecycleYamlConfigOptions;
}

export interface PipelineWaitItem {
  dependentDeploy: Deploy;
  awaitingDeploy: Deploy;
  pipelineId: string;
  serviceName: string;
  patternInfo: PatternInfo[];
}

export default class DeployService extends BaseService {
  /**
   * Creates all of the relevant deploys for a build, based on the provided environment, if they do not already exist.
   * @param environment the environment to use as a the template for these deploys
   * @param build the build these deploys will be associated with
   * @param githubRepositoryId optional filter to only update SHA for deploys from this repo
   */
  async findOrCreateDeploys(environment: Environment, build: Build, githubRepositoryId?: number): Promise<Deploy[]> {
    await build?.$fetchGraph('[deployables.[repository]]');

    const { deployables } = build;

    if (build?.enableFullYaml) {
      //
      // With full yaml enable. Creating deploys from deployables instead of services. This will include YAML only config.
      //
      const { kedaScaleToZero: defaultKedaScaleToZero } = await GlobalConfigService.getInstance().getAllConfigs();

      const buildId = build?.id;
      if (!buildId) {
        getLogger().error('Deploy: build id missing for=findOrCreateDeploys');
        return [];
      }

      const existingDeploys = await this.db.models.Deploy.query().where({ buildId }).withGraphFetched('deployable');
      const existingDeployMap = new Map(existingDeploys.map((d) => [d.deployableId, d]));

      await Promise.all(
        deployables.map(async (deployable) => {
          const uuid = `${deployable.name}-${build?.uuid}`;
          const patchFields: Objection.PartialModelObject<Deploy> = {};
          const isTargetRepo = !githubRepositoryId || deployable.repositoryId === githubRepositoryId;

          let deploy = existingDeployMap.get(deployable.id) ?? null;
          if (!deploy) {
            deploy = await this.db.models.Deploy.findOne({
              deployableId: deployable.id,
              buildId,
            }).catch((error) => {
              getLogger().warn({ error, serviceId: deployable.id }, 'Deploy: find failed');
              return null;
            });
            if (deploy) {
              getLogger().warn(`Deploy: fallback find succeeded deployableId=${deployable.id}`);
            }
          }

          if (deploy != null) {
            if (!isTargetRepo) {
              return;
            }
            patchFields.deployableId = deployable?.id ?? null;
            patchFields.publicUrl = this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable);
            patchFields.internalHostname = uuid;
            patchFields.uuid = uuid;
            patchFields.branchName = deployable.commentBranchName ?? deployable.branchName;
            patchFields.tag = deployable.defaultTag;
          } else {
            deploy = await this.db.models.Deploy.create({
              buildId,
              serviceId: deployable.serviceId,
              deployableId: deployable?.id ?? null,
              uuid,
              internalHostname: uuid,
              githubRepositoryId: deployable.repositoryId,
              active: deployable.active,
            });

            patchFields.branchName = deployable.branchName;
            patchFields.tag = deployable.defaultTag;
            patchFields.publicUrl = this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable);

            deploy.$setRelated('deployable', deployable);
            deploy.$setRelated('build', build);
          }

          if (isTargetRepo && [DeployTypes.HELM, DeployTypes.GITHUB, DeployTypes.CODEFRESH].includes(deployable.type)) {
            try {
              const sha = await getShaForDeploy(deploy);
              patchFields.sha = sha;
            } catch (error) {
              getLogger().debug({ error }, 'Deploy: SHA fetch failed continuing=true');
            }
          }

          patchFields.kedaScaleToZero =
            deployable?.kedaScaleToZero?.type === 'http' && defaultKedaScaleToZero?.enabled
              ? { ...defaultKedaScaleToZero, ...deployable.kedaScaleToZero }
              : null;

          await deploy.$query().patch(patchFields);
        })
      ).catch((error) => {
        getLogger().error({ error }, 'Deploy: create from deployables failed');
      });
      getLogger().info('Deploy: initialized');
    } else {
      const serviceInitFunc = async (service: Service, active: boolean): Promise<Deploy[]> => {
        const newDeploys: Deploy[] = [];

        newDeploys.push(
          await this.findOrCreateDeploy({
            service,
            build,
            active,
          })
        );

        // Grab the dependent services and create those deploys as well
        const dependencies = await this.db.models.Service.query().where({
          dependsOnServiceId: service.id,
        });
        await Promise.all(
          dependencies.map(async (dependency) => {
            newDeploys.push(
              await this.findOrCreateDeploy({
                service: dependency,
                build,
                active,
              })
            );
          })
        );
        getLogger().info(`Deploy: created count=${newDeploys.length}`);
        return newDeploys;
      };

      await environment.$fetchGraph('[optionalServices, defaultServices]');
      await Promise.all([
        environment.defaultServices.map((service) => serviceInitFunc(service, true)),
        environment.optionalServices.map((service) => serviceInitFunc(service, false)),
      ]).catch((error) => {
        getLogger().error({ error }, 'Deploy: create/update failed');
      });
    }
    const buildId = build?.id;
    if (!buildId) {
      getLogger().error('Deploy: build id missing for=findOrCreateDeploys');
    }

    await this.db.models.Deploy.query().where({ buildId });
    await build?.$fetchGraph('deploys');

    if (build?.deployables?.length !== build?.deploys?.length) {
      getLogger().warn(
        { buildId, deployablesCount: build.deployables.length, deploysCount: build.deploys.length },
        'Deployables count mismatch with Deploys count'
      );
    }

    return build?.deploys;
  }

  async findOrCreateDeploy({
    service,
    build,
    active,
  }: {
    service: Service;
    build: Build;
    active: boolean;
  }): Promise<Deploy> {
    const uuid = `${service.name}-${build?.uuid}`;
    const buildId = build?.id;
    if (!buildId) {
      getLogger().error('Deploy: build id missing for=findOrCreateDeploy');
    }
    const serviceId = service?.id;
    if (!serviceId) {
      getLogger().error('Deploy: service id missing for=findOrCreateDeploy');
    }

    // Deployable should be find at this point; otherwise, something is very wrong.
    const deployable: Deployable = await this.db.models.Deployable.query()
      .findOne({ buildId, serviceId })
      .catch((error) => {
        getLogger().error({ error, serviceId }, 'Deployable: find failed');
        return null;
      });

    let deploy = await this.db.models.Deploy.findOne({
      serviceId,
      buildId,
    }).catch((error) => {
      getLogger().warn({ error, serviceId }, 'Deploy: find failed');
      return null;
    });
    if (deploy != null) {
      // If deploy is already exists (re-deployment)
      await deploy.$fetchGraph('service.[repository]');
      await deploy.$query().patch({
        deployableId: deployable?.id ?? null,
        publicUrl: this.db.services.Deploy.hostForServiceDeploy(deploy, service),
        internalHostname: uuid,
        uuid,
      });
    } else {
      const buildId = build?.id;
      if (!buildId) {
        getLogger().error('Deploy: build id missing for=findOrCreateDeploy');
      }
      const serviceId = service?.id;
      if (!serviceId) {
        getLogger().error('Deploy: service id missing for=findOrCreateDeploy');
      }
      // Create deploy object if this is new deployment
      deploy = await this.db.models.Deploy.create({
        buildId,
        serviceId,
        deployableId: deployable?.id ?? null,
        uuid,
        internalHostname: uuid,
        githubRepositoryId: service.repositoryId,
        active,
      });

      await build?.$fetchGraph('[buildServiceOverrides]');
      const override = build.buildServiceOverrides.find((bso) => bso.serviceId === serviceId);
      getLogger().debug({ override: override ? JSON.stringify(override) : null }, 'Service override found');
      /* Default to the service branch name */
      let resolvedBranchName = service.branchName;
      /* If the deploy already has a branch name set, use that */
      if (deploy && deploy.branchName) {
        resolvedBranchName = deploy.branchName;
      }
      /* If we have an override, use that over all else */
      if (override && override.branchName) {
        resolvedBranchName = override.branchName;
      }

      const resolvedTag = override && override.tagName ? override.tagName : service.defaultTag;

      await deploy.$fetchGraph('service.[repository]');
      await deploy.$query().patch({
        branchName: resolvedBranchName,
        tag: resolvedTag,
        publicUrl: this.db.services.Deploy.hostForServiceDeploy(deploy, service),
      });
    }

    deploy.$setRelated('service', service);
    deploy.$setRelated('deployable', deployable);
    deploy.$setRelated('build', build);

    return deploy;
  }

  /**
   * Helper function to check if an Aurora database already exists in AWS
   * @param buildUuid The build UUID to search for
   * @param serviceName The service name to search for
   * @returns The database cluster endpoint address if found (or instance endpoint if not clustered), null otherwise
   */
  private async findExistingAuroraDatabase(buildUuid: string, serviceName: string): Promise<string | null> {
    try {
      const rds = new RDS();
      const taggingApi = new resourceGroupsTagging();
      const results = await taggingApi
        .getResources({
          TagFilters: [
            {
              Key: 'BuildUUID',
              Values: [buildUuid],
            },
            {
              Key: 'ServiceName',
              Values: [serviceName],
            },
          ],
          ResourceTypeFilters: ['rds:db'],
        })
        .promise();

      const instanceArn = results.ResourceTagMappingList?.find((mapping) =>
        mapping.ResourceARN?.includes(':db:')
      )?.ResourceARN;

      if (instanceArn) {
        const instanceIdentifier = instanceArn.split(':').pop();
        if (instanceIdentifier) {
          const instances = await rds
            .describeDBInstances({
              DBInstanceIdentifier: instanceIdentifier,
            })
            .promise();
          const database = instances.DBInstances?.[0];
          if (database) {
            let databaseAddress = database.Endpoint?.Address;
            // If this instance is part of a cluster, use the cluster endpoint instead
            // for better resilience during instance failures and replacements
            if (database.DBClusterIdentifier) {
              const clusters = await rds
                .describeDBClusters({
                  DBClusterIdentifier: database.DBClusterIdentifier,
                })
                .promise();
              const clusterEndpoint = clusters.DBClusters?.[0]?.Endpoint;
              if (clusterEndpoint) {
                databaseAddress = clusterEndpoint;
              }
            }
            return databaseAddress || null;
          }
        }
      }
      return null;
    } catch (error) {
      getLogger().debug({ error }, 'Aurora: check failed');
      return null;
    }
  }

  async deployAurora(deploy: Deploy): Promise<boolean> {
    return withLogContext(
      { deployUuid: deploy.uuid, serviceName: deploy.deployable?.name || deploy.service?.name },
      async () => {
        try {
          await deploy.reload();
          await deploy.$fetchGraph('[build, deployable]');

          if (!deploy.deployable) {
            getLogger().error('Aurora: deployable missing for=restore');
            return false;
          }

          if ((deploy.status === DeployStatus.BUILT || deploy.status === DeployStatus.READY) && deploy.cname) {
            getLogger().info('Aurora: skipped reason=alreadyBuilt');
            return true;
          }

          const existingDbEndpoint = await this.findExistingAuroraDatabase(deploy.build.uuid, deploy.deployable.name);
          if (existingDbEndpoint) {
            getLogger().info('Aurora: skipped reason=exists');
            await deploy.$query().patch({
              cname: existingDbEndpoint,
              status: DeployStatus.BUILT,
            });
            return true;
          }

          const uuid = nanoid();
          await deploy.$query().patch({
            status: DeployStatus.BUILDING,
            buildLogs: uuid,
            runUUID: nanoid(),
          });
          getLogger().info('Aurora: restoring');
          await cli.cliDeploy(deploy);

          const dbEndpoint = await this.findExistingAuroraDatabase(deploy.build.uuid, deploy.deployable.name);
          if (dbEndpoint) {
            await deploy.$query().patch({
              cname: dbEndpoint,
            });
          }

          await deploy.reload();
          if (deploy.buildLogs === uuid) {
            await deploy.$query().patch({
              status: DeployStatus.BUILT,
            });
          }
          getLogger().info('Aurora: restored');
          return true;
        } catch (e) {
          getLogger().error({ error: e }, 'Aurora: cluster restore failed');
          await deploy.$query().patch({
            status: DeployStatus.ERROR,
          });
          return false;
        }
      }
    );
  }

  async deployCodefresh(deploy: Deploy): Promise<boolean> {
    return withLogContext(
      { deployUuid: deploy.uuid, serviceName: deploy.deployable?.name || deploy.service?.name },
      async () => {
        let result: boolean = false;

        const runUUID = nanoid();
        await deploy.$query().patch({
          runUUID,
        });

        await deploy.reload();
        await deploy.$fetchGraph('[service.[repository], deployable.[repository], build]');
        const { build, service, deployable } = deploy;
        const { repository } = build.enableFullYaml ? deployable : service;
        const repo = repository?.fullName;
        const [owner, name] = repo?.split('/') || [];
        const fullSha = await github.getSHAForBranch(deploy.branchName, owner, name).catch((error) => {
          getLogger().warn(
            { error, owner, name, branch: deploy.branchName },
            'Failed to retrieve commit SHA from github'
          );
        });

        if (!fullSha) {
          getLogger().warn({ owner, name, branch: deploy.branchName }, 'Git: SHA missing');

          result = false;
        } else {
          const shortSha = fullSha.substring(0, 7);
          const envSha = hash(merge(deploy.env || {}, build.commentRuntimeEnv));
          const buildSha = `${shortSha}-${envSha}`;

          if (deploy?.sha === buildSha) {
            await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILT, sha: buildSha }, runUUID).catch(
              (error) => {
                getLogger().warn({ error }, 'ActivityFeed: update failed');
              }
            );
            getLogger().info('Codefresh: skipped reason=noChanges status=built');
            result = true;
          } else {
            let buildLogs: string;
            let codefreshBuildId: string;
            try {
              await deploy.$query().patch({
                buildLogs: null,
                buildPipelineId: null,
                buildOutput: null,
                deployPipelineId: null,
                deployOutput: null,
              });

              codefreshBuildId = await cli.codefreshDeploy(deploy, build, service, deployable).catch((error) => {
                getLogger().error({ error }, 'Codefresh: build id missing');
                return null;
              });
              getLogger().info('Codefresh: triggered');
              if (codefreshBuildId != null) {
                buildLogs = `https://g.codefresh.io/build/${codefreshBuildId}`;

                await this.patchAndUpdateActivityFeed(
                  deploy,
                  {
                    buildLogs,
                    status: DeployStatus.BUILDING,
                    buildPipelineId: codefreshBuildId,
                    statusMessage: 'CI build triggered...',
                  },
                  runUUID
                ).catch((error) => {
                  getLogger().warn({ error }, 'ActivityFeed: update failed');
                });
                getLogger().info(`Codefresh: waiting url=${buildLogs}`);
                await cli.waitForCodefresh(codefreshBuildId);
                const buildOutput = await getLogs(codefreshBuildId);
                getLogger().info('Codefresh: completed');
                await this.patchAndUpdateActivityFeed(
                  deploy,
                  {
                    status: DeployStatus.BUILT,
                    sha: buildSha,
                    buildOutput,
                    statusMessage: 'CI build completed',
                  },
                  runUUID
                ).catch((error) => {
                  getLogger().warn({ error }, 'ActivityFeed: update failed');
                });
                result = true;
              }
            } catch (error) {
              getLogger().error({ error, url: buildLogs }, 'Codefresh: build failed');
              await this.patchAndUpdateActivityFeed(
                deploy,
                {
                  status: DeployStatus.ERROR,
                  sha: buildSha,
                  statusMessage: 'CI build failed',
                },
                runUUID
              );
              result = false;
            }
          }
        }

        return result;
      }
    );
  }

  async deployCLI(deploy: Deploy): Promise<boolean> {
    if (deploy.deployable != null) {
      if (deploy.deployable.type === DeployTypes.AURORA_RESTORE) {
        return this.deployAurora(deploy);
      } else if (deploy.deployable.type === DeployTypes.CODEFRESH) {
        return this.deployCodefresh(deploy);
      }
    } else if (deploy.service != null) {
      if (deploy.service.type === DeployTypes.AURORA_RESTORE) {
        return this.deployAurora(deploy);
      } else if (deploy.service.type === DeployTypes.CODEFRESH) {
        return this.deployCodefresh(deploy);
      }
    }
  }

  /**
   * Builds an image for a given deploy
   * @param deploy the deploy to build an image for
   */
  async buildImage(deploy: Deploy, enableFullYaml: boolean, index: number): Promise<boolean> {
    return withLogContext(
      { deployUuid: deploy.uuid, serviceName: deploy.deployable?.name || deploy.service?.name },
      async () => {
        try {
          const runUUID = deploy.runUUID ?? nanoid();
          await deploy.$query().patch({
            runUUID,
          });

          await deploy.$fetchGraph('[service, build.[environment], deployable]');
          const { service, build, deployable } = deploy;
          const uuid = build?.uuid;

          if (!enableFullYaml) {
            await service.$fetchGraph('repository');
            let config: YamlService.LifecycleConfig;
            const isClassicModeOnly = build?.environment?.classicModeOnly ?? false;
            if (!isClassicModeOnly) {
              config = await YamlService.fetchLifecycleConfigByRepository(service.repository, deploy.branchName);
            }

            // Docker types are already built - next
            if (service.type === DeployTypes.DOCKER) {
              await this.patchAndUpdateActivityFeed(
                deploy,
                {
                  status: DeployStatus.BUILT,
                  dockerImage: `${service.dockerImage}:${deploy.tag}`,
                },
                runUUID
              );
              return true;
            } else if (service.type === DeployTypes.GITHUB) {
              if (deploy.branchName === null) {
                // This means we're using an external host, rather than building from source.
                await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.READY }, runUUID);
              } else {
                await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.CLONING }, runUUID);

                await build?.$fetchGraph('pullRequest.[repository]');
                const pullRequest = build?.pullRequest;
                const author = pullRequest?.githubLogin;
                const enabledFeatures = build?.enabledFeatures || [];
                const repository = service?.repository;
                const repo = repository?.fullName;
                const [owner, name] = repo?.split('/') || [];
                const fullSha = await github.getSHAForBranch(deploy.branchName, owner, name);

                let repositoryName: string = service.repository.fullName;
                let branchName: string = deploy.branchName;
                let dockerfilePath: string = service.dockerfilePath || './Dockerfile';
                let initDockerfilePath: string = service.initDockerfilePath;

                let githubService: YamlService.GithubService;
                // TODO This should be updated!
                if (config != null && config.version === '0.0.3-alpha-1') {
                  const yamlService: YamlService.Service = YamlService.getDeployingServicesByName(config, service.name);
                  if (yamlService != null) {
                    githubService = yamlService as YamlService.GithubService;

                    repositoryName = githubService.github.repository;
                    branchName = githubService.github.branchName;
                    dockerfilePath = githubService.github.docker.app.dockerfilePath;

                    if (githubService.github.docker.init != null) {
                      initDockerfilePath = githubService.github.docker.init.dockerfilePath;
                    }
                  }
                }

                // Verify we actually have a SHA from github before proceeding
                if (!fullSha) {
                  // We were unable to retrieve this branch/repo combo
                  await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.ERROR }, runUUID);
                  return false;
                }

                const shortSha = fullSha.substring(0, 7);

                getLogger().debug(
                  { serviceName: service.name, branchName: deploy.branchName },
                  'Building docker image'
                );
                await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILDING, sha: fullSha }, runUUID);
                /**
                 * @note { svc: index } ensures the hash for each image is unique per service
                 */
                const envVariables = merge(deploy.env || {}, deploy.build.commentRuntimeEnv, { svc: index });
                const envVarsHash = hash(envVariables);
                const buildPipelineName = deployable?.dockerBuildPipelineName;
                const tag = generateDeployTag({ sha: shortSha, envVarsHash });
                const initTag = generateDeployTag({ prefix: 'lfc-init', sha: shortSha, envVarsHash });
                let ecrRepo = deployable?.ecr;

                const { lifecycleDefaults, app_setup } = await GlobalConfigService.getInstance().getAllConfigs();
                const { ecrDomain, ecrRegistry: registry } = lifecycleDefaults;

                const serviceName = deploy.build?.enableFullYaml ? deployable?.name : deploy.service?.name;
                ecrRepo = constructEcrRepoPath(deployable?.ecr, serviceName, ecrDomain);

                const tagsExist =
                  (await codefresh.tagExists({ tag, ecrRepo, uuid })) &&
                  (!initDockerfilePath || (await codefresh.tagExists({ tag: initTag, ecrRepo, uuid })));

                getLogger().debug({ tagsExist }, 'Build: tags exist check');
                const gitOrg = (app_setup?.org && app_setup.org.trim()) || 'REPLACE_ME_ORG';
                if (!ecrDomain || !registry) {
                  getLogger().error({ lifecycleDefaults }, 'ECR: config missing for build');
                  await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.ERROR }, runUUID);
                  return false;
                }
                if (!tagsExist) {
                  await deploy.$query().patchAndFetch({
                    buildOutput: null,
                    buildLogs: null,
                    buildPipelineId: null,
                  });

                  const codefreshBuildId = await codefresh.buildImage({
                    ecrRepo,
                    envVars: envVariables,
                    dockerfilePath,
                    gitOrg,
                    tag,
                    revision: fullSha,
                    repo: repositoryName,
                    branch: branchName,
                    initDockerfilePath,
                    cacheFrom: deploy.dockerImage,
                    afterBuildPipelineId: service.afterBuildPipelineId,
                    detatchAfterBuildPipeline: service.detatchAfterBuildPipeline,
                    runtimeName: service.runtimeName,
                    buildPipelineName,
                    deploy,
                    uuid,
                    initTag,
                    author,
                    enabledFeatures,
                    ecrDomain,
                    deployCluster: lifecycleDefaults.deployCluster,
                  });
                  const buildLogs = `https://g.codefresh.io/build/${codefreshBuildId}`;
                  await this.patchAndUpdateActivityFeed(deploy, { buildLogs }, runUUID);
                  const buildSuccess = await codefresh.waitForImage(codefreshBuildId);
                  if (buildSuccess) {
                    await this.patchDeployWithTag({ tag, initTag, deploy, ecrDomain });
                    return true;
                  } else {
                    await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILD_FAILED }, runUUID);
                    return false;
                  }
                } else {
                  await this.patchDeployWithTag({ tag, initTag, deploy, ecrDomain });
                  await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILT }, runUUID);
                  return true;
                }
              }
            } else {
              getLogger().debug({ type: service.type }, 'Build: type not recognized');
              return false;
            }
            return true;
          } else {
            switch (deployable.type) {
              case DeployTypes.GITHUB:
                return this.buildImageForHelmAndGithub(deploy, runUUID);
              case DeployTypes.DOCKER:
                await this.patchAndUpdateActivityFeed(
                  deploy,
                  {
                    status: DeployStatus.BUILT,
                    dockerImage: `${deployable.dockerImage}:${deploy.tag}`,
                  },
                  runUUID
                );
                getLogger().info('Image: skipped reason=public status=built');
                return true;
              case DeployTypes.HELM: {
                try {
                  const chartType = await determineChartType(deploy);

                  if (chartType !== ChartType.PUBLIC) {
                    return this.buildImageForHelmAndGithub(deploy, runUUID);
                  }

                  let fullSha = null;

                  await deploy.$fetchGraph('deployable.repository');
                  if (deploy.deployable?.repository) {
                    try {
                      fullSha = await github.getShaForDeploy(deploy);
                    } catch (shaError) {
                      getLogger().debug(
                        { error: shaError },
                        'Could not get SHA for PUBLIC helm chart, continuing without it'
                      );
                    }
                  }

                  await this.patchAndUpdateActivityFeed(
                    deploy,
                    {
                      status: DeployStatus.BUILT,
                      statusMessage: 'Helm chart does not need to be built',
                      ...(fullSha && { sha: fullSha }),
                    },
                    runUUID
                  );
                  return true;
                } catch (error) {
                  getLogger().warn({ error }, 'Helm: deployment processing failed');
                  return false;
                }
              }
              default:
                getLogger().debug({ type: deployable.type }, 'Build: type not recognized');
                return false;
            }
          }
        } catch (e) {
          getLogger().error({ error: e }, 'Docker: build error');
          return false;
        }
      }
    );
  }

  public async patchAndUpdateActivityFeed(
    deploy: Deploy,
    params: Objection.PartialModelObject<Deploy>,
    runUUID: string,
    targetGithubRepositoryId?: number
  ) {
    let build: Build;
    try {
      const id = deploy?.id;
      await this.db.models.Deploy.query().where({ id, runUUID }).patch(params);
      if (deploy.runUUID !== runUUID) {
        getLogger().debug({ deployRunUUID: deploy.runUUID, providedRunUUID: runUUID }, 'runUUID mismatch');
        return;
      }

      await deploy.$fetchGraph('build.pullRequest');
      build = deploy?.build;
      const pullRequest = build?.pullRequest;

      await this.db.services.ActivityStream.updatePullRequestActivityStream(
        build,
        [],
        pullRequest,
        null,
        true,
        true,
        null,
        true,
        targetGithubRepositoryId
      );
    } catch (error) {
      getLogger().warn({ error }, 'ActivityFeed: update failed');
    }
  }

  private async patchDeployWithTag({ tag, deploy, initTag, ecrDomain }) {
    await deploy.$fetchGraph('[build, service, deployable]');
    const { build, deployable, service } = deploy;
    const _uuid = build?.uuid;
    let ecrRepo = deployable?.ecr as string;

    const serviceName = build?.enableFullYaml ? deployable?.name : service?.name;
    ecrRepo = constructEcrRepoPath(deployable?.ecr as string, serviceName, ecrDomain);

    const dockerImage = codefresh.getRepositoryTag({ tag, ecrRepo, ecrDomain });

    if (service?.initDockerfilePath || deployable?.initDockerfilePath) {
      const initDockerImage = codefresh.getRepositoryTag({ tag: initTag, ecrRepo, ecrDomain });
      await deploy
        .$query()
        .patch({
          initDockerImage,
        })
        .catch((error) => {
          getLogger().warn({ error }, 'Deploy: tag patch failed');
        });
    }

    await deploy.$query().patch({
      status: DeployStatus.BUILT,
      dockerImage,
      statusMessage: 'Successfully built image',
    });
  }

  hostForServiceDeploy(deploy: Deploy, service: Service) {
    if (service.type === DeployTypes.EXTERNAL_HTTP) {
      return deploy.publicUrl ? deploy.publicUrl : service.defaultPublicUrl;
    } else {
      if (service.host) {
        return `${deploy.uuid}.${service.host}`;
      }
    }
  }

  hostForDeployableDeploy(deploy: Deploy, deployable: Deployable) {
    if (deployable.type === DeployTypes.EXTERNAL_HTTP) {
      return deploy.publicUrl ? deploy.publicUrl : deployable.defaultPublicUrl;
    } else {
      if (deployable.host) {
        return `${deploy.uuid}.${deployable.host}`;
      }
    }
  }

  acmARNForDeploy(deploy: Deploy, fullYamlSupport: boolean): string {
    return fullYamlSupport ? deploy?.deployable?.acmARN ?? null : deploy?.service?.acmARN ?? null;
  }

  async buildImageForHelmAndGithub(deploy: Deploy, runUUID: string) {
    const { build, deployable } = deploy;
    const uuid = build?.uuid;
    if (deploy.branchName === null) {
      // This means we're using an external host, rather than building from source.
      await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.READY }, runUUID);
      getLogger().info('Deploy: ready reason=externalHost');
    } else {
      await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.CLONING }, runUUID);

      await deployable.$fetchGraph('repository');
      await build?.$fetchGraph('pullRequest');
      const repository = deployable?.repository;

      if (!repository) {
        await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.ERROR }, runUUID);
        return false;
      }

      const repo = repository?.fullName;
      const [owner, name] = repo?.split('/') || [];
      const fullSha = await github.getSHAForBranch(deploy.branchName, owner, name);

      const repositoryName: string = deployable.repository.fullName;
      const branchName: string = deploy.branchName;
      const dockerfilePath: string = deployable.dockerfilePath;
      const initDockerfilePath: string = deployable.initDockerfilePath;

      // Verify we actually have a SHA from github before proceeding
      if (!fullSha) {
        await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.ERROR }, runUUID);
        getLogger().error({ owner, name, branch: deploy.branchName }, 'Git: SHA fetch failed');
        return false;
      }

      const shortSha = fullSha.substring(0, 7);

      await build?.$fetchGraph('pullRequest.[repository]');
      const author = build?.pullRequest?.githubLogin;
      const enabledFeatures = build?.enabledFeatures || [];
      const envVariables = merge(deploy.env || {}, deploy.build.commentRuntimeEnv);
      const envVarsHash = hash(envVariables);
      const buildPipelineName = deployable?.dockerBuildPipelineName;
      const tag = generateDeployTag({ sha: shortSha, envVarsHash });
      const initTag = generateDeployTag({ prefix: 'lfc-init', sha: shortSha, envVarsHash });
      let ecrRepo = deployable?.ecr;

      const { lifecycleDefaults, app_setup, buildDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
      const { ecrDomain, ecrRegistry: registry } = lifecycleDefaults;

      const serviceName = deploy.build?.enableFullYaml ? deployable?.name : deploy.service?.name;
      ecrRepo = constructEcrRepoPath(deployable?.ecr, serviceName, ecrDomain);

      const gitOrg = (app_setup?.org && app_setup.org.trim()) || 'REPLACE_ME_ORG';
      if (!ecrDomain || !registry) {
        getLogger().error({ lifecycleDefaults }, 'ECR: config missing for build');
        await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.ERROR }, runUUID);
        return false;
      }

      const tagsExist =
        (await codefresh.tagExists({ tag, ecrRepo, uuid })) &&
        (!initDockerfilePath || (await codefresh.tagExists({ tag: initTag, ecrRepo, uuid })));

      getLogger().debug({ tagsExist }, 'Build: tags exist check');

      // Check for and skip duplicates
      if (!tagsExist) {
        getLogger().info('Image: building');

        // if this deploy has any env vars that depend on other builds, we need to wait for those builds to finish
        // and update the env vars in this deploy before we can build the image
        await this.waitAndResolveForBuildDependentEnvVars(deploy, envVariables, runUUID);

        await deploy.reload();
        await this.patchAndUpdateActivityFeed(
          deploy,
          { status: DeployStatus.BUILDING, sha: fullSha, statusMessage: `Building ${deploy?.uuid}...` },
          runUUID
        );

        const buildOptions = {
          ecrRepo,
          ecrDomain,
          envVars: deploy.env,
          dockerfilePath,
          gitOrg,
          tag,
          revision: fullSha,
          repo: repositoryName,
          branch: branchName,
          initDockerfilePath,
          cacheFrom: deploy.dockerImage,
          afterBuildPipelineId: deployable.afterBuildPipelineId,
          detatchAfterBuildPipeline: deployable.detatchAfterBuildPipeline,
          runtimeName: deployable.runtimeName,
          buildPipelineName,
          deploy,
          uuid,
          initTag,
          author,
          enabledFeatures,
          deployCluster: lifecycleDefaults.deployCluster,
        };

        if (['buildkit', 'kaniko'].includes(deployable.builder?.engine)) {
          getLogger().info(`Image: building engine=${deployable.builder.engine}`);

          const nativeOptions = {
            ...buildOptions,
            namespace: deploy.build.namespace,
            buildId: String(deploy.build.id),
            deployUuid: deploy.uuid, // Use the full deploy UUID which includes service name
            cacheRegistry: buildDefaults?.cacheRegistry,
          };

          if (!initDockerfilePath) {
            nativeOptions.initTag = undefined;
          }

          const result = await buildWithNative(deploy, nativeOptions);

          if (result.success) {
            await this.patchDeployWithTag({ tag, initTag, deploy, ecrDomain });
            if (buildOptions?.afterBuildPipelineId) {
              const ecrRepoTag = constructEcrTag({ repo: ecrRepo, tag, ecrDomain });

              const afterbuildPipeline = await codefresh.triggerPipeline(buildOptions.afterBuildPipelineId, 'cli', {
                ...deploy.env,
                ...{ TAG: ecrRepoTag },
                ...{ branch: branchName },
              });
              const completed = await codefresh.waitForImage(afterbuildPipeline);
              if (!completed) return false;
            }
            return true;
          } else {
            await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILD_FAILED }, runUUID);
            return false;
          }
        }

        getLogger().info('Image: building engine=codefresh');

        const buildPipelineId = await codefresh.buildImage(buildOptions);
        const buildLogs = `https://g.codefresh.io/build/${buildPipelineId}`;
        await this.patchAndUpdateActivityFeed(deploy, { buildLogs }, runUUID);
        await deploy.$query().patch({ buildPipelineId });
        const buildSuccess = await codefresh.waitForImage(buildPipelineId);
        const buildOutput = await codefresh.getLogs(buildPipelineId);
        await deploy.$query().patch({ buildOutput });

        if (buildSuccess) {
          await this.patchDeployWithTag({ tag, initTag, deploy, ecrDomain });
          getLogger().info('Image: built');
          return true;
        } else {
          await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILD_FAILED }, runUUID);
          getLogger().warn({ url: buildLogs }, 'Build: image failed');
          return false;
        }
      } else {
        getLogger().info('Image: skipped reason=exists');
        await this.patchDeployWithTag({ tag, initTag, deploy, ecrDomain });
        await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILT }, runUUID);
        return true;
      }
    }
  }

  async waitAndResolveForBuildDependentEnvVars(deploy: Deploy, envVariables: Record<string, string>, runUUID: string) {
    const pipelineIdsToWaitFor: PipelineWaitItem[] = [];
    const awaitingDeploy = deploy;
    const { build } = deploy;
    const deploys = build.deploys;
    const servicesToWaitFor = extractEnvVarsWithBuildDependencies(deploy.deployable.env);

    for (const [serviceName, patternsInfo] of Object.entries(servicesToWaitFor)) {
      const _awaitingService = deploy.uuid;
      const waitingForService = `${serviceName}-${build.uuid}`;

      const dependentDeploy = deploys.find((d) => d.uuid === waitingForService);

      if (dependentDeploy.uuid === waitingForService) {
        getLogger().info(`Build: waiting service=${waitingForService}`);

        await this.patchAndUpdateActivityFeed(
          deploy,
          { status: DeployStatus.WAITING, statusMessage: `Waiting for ${waitingForService} to finish building.` },
          runUUID
        );

        const updatedDeploy = await waitForColumnValue(dependentDeploy, 'buildPipelineId');

        if (updatedDeploy?.buildPipelineId) {
          pipelineIdsToWaitFor.push({
            dependentDeploy,
            awaitingDeploy,
            pipelineId: updatedDeploy.buildPipelineId,
            serviceName,
            patternInfo: patternsInfo,
          });
        }
      }
    }

    const extractedValues = {};
    const pipelinePromises = pipelineIdsToWaitFor.map(
      async ({ dependentDeploy, awaitingDeploy, pipelineId, serviceName, patternInfo }: PipelineWaitItem) => {
        try {
          const updatedDeploy = await waitForColumnValue(dependentDeploy, 'buildOutput', 240, 5000);

          if (!updatedDeploy) {
            throw new Error(`Timed out waiting for build output from ${dependentDeploy.uuid}`);
          }

          const logs = updatedDeploy.buildOutput;
          if (!logs) throw new Error(`No output logs found for ${deploy.uuid}`);
          patternInfo.forEach((item) => {
            // this is here so that we can specify build dependecies without needing a valid pattern
            // for ecxample: if we want to wait for a build to finish before we start building, but we don't care
            // about the output of that build, we can just pass an empty string as the pattern
            if (!item.pattern || item.pattern.trim() === '') {
              extractedValues[item.envKey] = '';
              getLogger().info(`Build: dependency envKey=${item.envKey} pattern=empty`);
              return;
            }

            const regex = new RegExp(item.pattern);
            const match = logs.match(regex);

            if (match && match[0]) {
              extractedValues[item.envKey] = match[0];
              getLogger().debug(
                { value: match[0], envKey: item.envKey, pattern: item.pattern },
                'Successfully extracted value'
              );
            } else {
              getLogger().info(
                `Build: noMatch pattern=${item.pattern} service=${serviceName} pipelineId=${pipelineId} envKey=${item.envKey}`
              );
            }
          });
        } catch (error) {
          getLogger().error({ error, pipelineId, serviceName }, 'Pipeline: processing failed');
          throw error;
        }
      }
    );

    await Promise.all(pipelinePromises);

    await deploy.$query().patch({
      env: {
        ...envVariables,
        ...extractedValues,
      },
    });
  }
}
