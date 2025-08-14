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
import rootLogger from 'server/lib/logger';
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
import { generateDeployTag } from 'server/lib/utils';
import { LifecycleYamlConfigOptions } from 'server/models/yaml/types';
import { getShaForDeploy } from 'server/lib/github';
import GlobalConfigService from 'server/services/globalConfig';
import { PatternInfo, extractEnvVarsWithBuildDependencies, waitForColumnValue } from 'shared/utils';
import { getLogs } from 'server/lib/codefresh';
import { buildWithNative } from 'server/lib/nativeBuild';
import { constructEcrTag } from 'server/lib/codefresh/utils';
import { ChartType, determineChartType } from 'server/lib/nativeHelm';

const logger = rootLogger.child({
  filename: 'services/deploy.ts',
});

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
   */
  async findOrCreateDeploys(environment: Environment, build: Build): Promise<Deploy[]> {
    await build?.$fetchGraph('[deployables.[repository]]');

    const { deployables } = build;

    if (build?.enableFullYaml) {
      //
      // With full yaml enable. Creating deploys from deployables instead of services. This will include YAML only config.
      //
      await Promise.all(
        deployables.map(async (deployable) => {
          const uuid = `${deployable.name}-${build?.uuid}`;
          const buildId = build?.id;
          if (!buildId) {
            logger.error(`[BUILD ${build?.uuid}][findOrCreateDeploy][buidIdError] No build ID found for this build!`);
            return;
          }

          let deploy = await this.db.models.Deploy.findOne({
            deployableId: deployable.id,
            buildId,
          }).catch((error) => {
            logger.warn(`[BUILD ${build?.uuid}] [Service ${deployable.id}] ${error}`);
            return null;
          });

          if (deploy != null) {
            await deploy.$fetchGraph('deployable');

            // If deploy is already exists (re-deployment)
            await deploy.$query().patch({
              deployableId: deployable?.id ?? null,
              publicUrl: this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable),
              internalHostname: uuid,
              uuid,
              branchName: deployable.commentBranchName ?? deployable.branchName,
              tag: deployable.defaultTag,
            });
          } else {
            const buildId = build?.id;
            if (!buildId) {
              logger.error(`[BUILD ${build?.uuid}][findOrCreateDeploy][buidIdError] No build ID found for this build!`);
            }
            // Create deploy object if this is new deployment
            deploy = await this.db.models.Deploy.create({
              buildId,
              serviceId: deployable.serviceId,
              deployableId: deployable?.id ?? null,
              uuid,
              internalHostname: uuid,
              githubRepositoryId: deployable.repositoryId,
              active: deployable.active,
            });

            await deploy.$fetchGraph('deployable');

            await deploy.$query().patch({
              branchName: deployable.branchName,
              tag: deployable.defaultTag,
              publicUrl: this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable),
            });

            deploy.$setRelated('deployable', deployable);
            deploy.$setRelated('build', build);
          }

          // only set sha for deploys where needed
          if ([DeployTypes.HELM, DeployTypes.GITHUB, DeployTypes.CODEFRESH].includes(deployable.type)) {
            try {
              const sha = await getShaForDeploy(deploy);
              await deploy.$query().patch({
                sha,
              });
            } catch (error) {
              logger.debug(`[DEPLOY ${deploy.uuid}] Unable to get SHA, continuing: ${error}`);
            }
          }

          if (deployable?.kedaScaleToZero?.type == 'http') {
            const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
            const defaultKedaScaleToZero = globalConfig.kedaScaleToZero;
            const deployableKedaScaleToZero = deployable?.kedaScaleToZero;

            const kedaScaleToZero = {
              ...defaultKedaScaleToZero,
              ...deployableKedaScaleToZero,
            };

            await deploy.$query().patch({
              kedaScaleToZero,
            });
          } else {
            await deploy.$query().patch({
              kedaScaleToZero: null,
            });
          }
        })
      ).catch((error) => {
        logger.error(`[BUILD ${build?.uuid}] Failed to create deploys from deployables: ${error}`);
      });
      logger.info(`[BUILD ${build?.uuid}] Deploys created(or exists already) for deployables with YAML config`);
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
        logger.info(
          `[BUILD ${build?.uuid}] Created ${newDeploys.length} deploys from services table for non-YAML config`
        );
        return newDeploys;
      };

      await environment.$fetchGraph('[optionalServices, defaultServices]');
      await Promise.all([
        environment.defaultServices.map((service) => serviceInitFunc(service, true)),
        environment.optionalServices.map((service) => serviceInitFunc(service, false)),
      ]).catch((error) => {
        logger.error(`[BUILD ${build?.uuid}] Something is wrong when trying to create/update deploys: ${error}`);
      });
    }
    const buildId = build?.id;
    if (!buildId) {
      logger.error(`[BUILD ${build?.uuid}][findOrCreateDeploy][buidIdError] No build ID found for this build!`);
    }

    await this.db.models.Deploy.query().where({ buildId });
    await build?.$fetchGraph('deploys');

    if (build?.deployables?.length !== build?.deploys?.length) {
      logger.warn(
        `[BUILD ${build?.uuid} (${buildId})] No worry. Nothing critical yet: Deployables count (${build.deployables.length}) mismatch with Deploys count (${build.deploys.length}).`
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
      logger.error(`[BUILD ${build?.uuid}][findOrCreateDeploy][buidIdError] No build ID found for this build!`);
    }
    const serviceId = service?.id;
    if (!serviceId) {
      logger.error(`[BUILD ${build?.uuid}][findOrCreateDeploy][serviceIdError] No service ID found for this service!`);
    }

    // Deployable should be find at this point; otherwise, something is very wrong.
    const deployable: Deployable = await this.db.models.Deployable.query()
      .findOne({ buildId, serviceId })
      .catch((error) => {
        logger.error(`[BUILD ${build.uuid}] [Service ${serviceId}] ${error}`);
        return null;
      });

    let deploy = await this.db.models.Deploy.findOne({
      serviceId,
      buildId,
    }).catch((error) => {
      logger.warn(`[BUILD ${build?.uuid}] [Service ${serviceId}] ${error}`);
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
        logger.error(`[BUILD ${build?.uuid}][findOrCreateDeploy][buidIdError] No build ID found for this build!`);
      }
      const serviceId = service?.id;
      if (!serviceId) {
        logger.error(
          `[BUILD ${build?.uuid}][findOrCreateDeploy][serviceIdError] No service ID found for this service!`
        );
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
      logger.debug(`[BUILD ${build.uuid}] Override: ${override}`);
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

  async deployAurora(deploy: Deploy): Promise<boolean> {
    try {
      // For now, we're just going to shell out and run the deploy
      await deploy.reload();

      /**
       * For now, only run the CLI deploy step one time.
       */
      if (deploy.status === DeployStatus.BUILT) {
        logger.info(`[DEPLOY ${deploy?.uuid}] Aurora restore already built`);
        return true;
      }

      const uuid = nanoid();
      await deploy.$query().patch({
        status: DeployStatus.BUILDING,
        buildLogs: uuid,
      });
      logger.info(`[DEPLOY ${deploy?.uuid}] Restoring Aurora cluster for ${deploy?.uuid}`);
      await cli.cliDeploy(deploy);
      const rds = new RDS();
      const taggingApi = new resourceGroupsTagging();
      const results = await taggingApi
        .getResources({
          TagFilters: [
            {
              Key: 'BuildUUID',
              Values: [deploy.build.uuid],
            },
            {
              Key: 'ServiceName',
              Values: [deploy.deployable.name],
            },
          ],
          ResourceTypeFilters: ['rds:db'],
        })
        .promise();
      const dbArn = results.ResourceTagMappingList[0].ResourceARN;
      const params = {
        Filters: [
          {
            Name: 'db-instance-id' /* required */,
            Values: [dbArn],
          },
        ],
      };
      const instances = await rds.describeDBInstances(params, null).promise();

      if (instances.DBInstances.length === 1) {
        const database = instances.DBInstances[0];
        const databaseAddress = database.Endpoint.Address;
        await deploy.$query().patch({
          cname: databaseAddress,
        });
      }
      await deploy.reload();
      if (deploy.buildLogs === uuid) {
        await deploy.$query().patch({
          status: DeployStatus.BUILT,
        });
      }
      logger.info(`[DEPLOY ${deploy?.uuid}] Restored Aurora cluster for ${deploy?.uuid}`);
      return true;
    } catch (e) {
      logger.info(`[DEPLOY ${deploy?.uuid}] Aurora cluster restore for ${deploy?.uuid} failed with error: ${e}`);
      await deploy.$query().patch({
        status: DeployStatus.ERROR,
      });
      return false;
    }
  }

  async deployCodefresh(deploy: Deploy): Promise<boolean> {
    let result: boolean = false;

    // We'll use either a tag specified in the UI when creating a manual build
    // or the default tag specified on the service
    const runUUID = nanoid();
    await deploy.$query().patch({
      runUUID,
    });

    // For now, we're just going to shell out and run the deploy
    await deploy.reload();
    await deploy.$fetchGraph('[service.[repository], deployable.[repository], build]');
    const { build, service, deployable } = deploy;
    const { repository } = build.enableFullYaml ? deployable : service;
    const repo = repository?.fullName;
    const [owner, name] = repo?.split('/') || [];
    const fullSha = await github.getSHAForBranch(deploy.branchName, owner, name).catch((error) => {
      logger.warn(
        `[BUILD ${build.uuid}] ${owner}/${name}/${deploy.branchName} Something could be wrong when retrieving commit SHA for ${deploy.uuid} from github: ${error}`
      );
    });

    if (!fullSha) {
      logger.warn(
        `[BUILD ${build.uuid}] ${owner}/${name}/${deploy.branchName} Commit SHA  for ${deploy.uuid} cannot be falsy. Check the owner, etc.`
      );

      result = false;
    } else {
      const shortSha = fullSha.substring(0, 7);
      const envSha = hash(merge(deploy.env || {}, build.commentRuntimeEnv));
      const buildSha = `${shortSha}-${envSha}`;

      // If the SHA's are the same, nothing need to do and considered as done.
      if (deploy?.sha === buildSha) {
        // Make sure we're in a clean state
        await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILT, sha: buildSha }, runUUID).catch(
          (error) => {
            logger.warn(`[BUILD ${build.uuid}] Failed to update activity feed: ${error}`);
          }
        );
        logger.info(`[BUILD ${deploy?.uuid}] Marked codefresh deploy ${deploy?.uuid} as built since no changes`);
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
            logger.error(`[BUILD ${build.uuid}] Failed to receive codefresh build id for ${deploy.uuid}: ${error}`);
            return null;
          });
          logger.info(`[DEPLOY ${deploy?.uuid}] Triggered codefresh build for ${deploy?.uuid}`);
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
              logger.warn(`[BUILD ${build.uuid}] Failed to update activity feed: ${error}`);
            });
            logger
              .child({ url: buildLogs })
              .info(`[DEPLOY ${deploy?.uuid}] Wait for codefresh build to complete for ${deploy?.uuid}`);
            await cli.waitForCodefresh(codefreshBuildId);
            const buildOutput = await getLogs(codefreshBuildId);
            logger
              .child({ url: buildLogs })
              .info(`[DEPLOY ${deploy?.uuid}] Codefresh build completed for ${deploy?.uuid}`);
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
              logger.warn(`[BUILD ${build.uuid}] Failed to update activity feed: ${error}`);
            });
            result = true;
          }
        } catch (error) {
          // Error'd while waiting for the pipeline to finish. This is usually due to an actual
          // pipeline failure or a pipeline getting terminated.
          logger
            .child({ url: buildLogs })
            .error(`[BUILD ${build?.uuid}] Codefresh build failed for ${deploy?.uuid}: ${error}`);
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
    try {
      // We'll use either a tag specified in the UI when creating a manual build
      // or the default tag specified on the service
      const runUUID = deploy.runUUID ?? nanoid();
      await deploy.$query().patch({
        runUUID,
      });

      await deploy.$fetchGraph('[service, build.[environment], deployable]');
      const { service, build, deployable } = deploy;
      const uuid = build?.uuid;
      const uuidText = uuid ? `[DEPLOY ${uuid}][buildImage]:` : '[DEPLOY][buildImage]:';

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

            logger.debug(`${uuidText} Building docker image ${service.name} ${deploy.branchName}`);
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

            const tagsExist =
              (await codefresh.tagExists({ tag, ecrRepo, uuid })) &&
              (!initDockerfilePath || (await codefresh.tagExists({ tag: initTag, ecrRepo, uuid })));

            logger.debug(`${uuidText} Tags exist check for ${deploy.uuid}: ${tagsExist}`);

            const { lifecycleDefaults, app_setup } = await GlobalConfigService.getInstance().getAllConfigs();
            const { ecrDomain, ecrRegistry: registry } = lifecycleDefaults;
            const gitOrg = (app_setup?.org && app_setup.org.trim()) || 'REPLACE_ME_ORG';
            if (!ecrDomain || !registry) {
              logger.child({ lifecycleDefaults }).error(`[BUILD ${deploy.uuid}] Missing ECR config to build image`);
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
          logger.debug(`${uuidText} Build type not recognized: ${service.type} for deploy.`);
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
            logger.info(`[${deploy?.uuid}] Marked ${deploy.uuid} as BUILT since its a public docker image`);
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
                  logger.debug(
                    `[${deploy?.uuid}] Could not get SHA for PUBLIC helm chart, continuing without it: ${shaError.message}`
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
              logger.child({ error }).warn(`[${deploy?.uuid}] Error processing Helm deployment: ${error.message}`);
              return false;
            }
          }
          default:
            logger.debug(`[${deploy.uuid}] Build type not recognized: ${deployable.type} for deploy.`);
            return false;
        }
      }
    } catch (e) {
      logger.error(`[${deploy.uuid}] Uncaught error building docker image: ${e}`);
      return false;
    }
  }

  public async patchAndUpdateActivityFeed(
    deploy: Deploy,
    params: Objection.PartialModelObject<Deploy>,
    runUUID: string
  ) {
    let build: Build;
    try {
      const id = deploy?.id;
      await this.db.models.Deploy.query().where({ id, runUUID }).patch(params);
      if (deploy.runUUID !== runUUID) {
        logger.debug(
          `[DEPLOY ${deploy.uuid}] runUUID mismatch: deploy.runUUID=${deploy.runUUID}, provided runUUID=${runUUID}`
        );
        return;
      }
      await deploy.$fetchGraph('build.[deploys.[service, deployable], pullRequest.[repository]]');
      build = deploy?.build;
      const pullRequest = build?.pullRequest;

      await this.db.services.ActivityStream.updatePullRequestActivityStream(
        build,
        build?.deploys,
        pullRequest,
        pullRequest?.repository,
        true,
        true,
        null,
        false
      );
    } catch (error) {
      logger.child({ error }).warn(`[BUILD ${build?.uuid}] Failed to update the activity feeds`);
    }
  }

  private async patchDeployWithTag({ tag, deploy, initTag, ecrDomain }) {
    await deploy.$fetchGraph('[build, service, deployable]');
    const { build, deployable, service } = deploy;
    const uuid = build?.uuid;
    const uuidText = uuid ? `[DEPLOY ${uuid}][patchDeployWithTag]:` : '[DEPLOY][patchDeployWithTag]:';
    let ecrRepo = deployable?.ecr;

    const serviceName = build?.enableFullYaml ? deployable?.name : service?.name;
    if (serviceName && ecrRepo && !ecrRepo.endsWith(`/${serviceName}`)) {
      ecrRepo = `${ecrRepo}/${serviceName}`;
      logger.debug(`${uuidText} Auto-appended service name to ECR path: ${ecrRepo}`);
    }

    const dockerImage = codefresh.getRepositoryTag({ tag, ecrRepo, ecrDomain });

    if (service?.initDockerfilePath || deployable?.initDockerfilePath) {
      const initDockerImage = codefresh.getRepositoryTag({ tag: initTag, ecrRepo, ecrDomain });
      await deploy
        .$query()
        .patch({
          initDockerImage,
        })
        .catch((error) => {
          logger.warn(`${uuidText} ${error}`);
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
    const uuidText = `[BUILD ${deploy?.uuid}]:`;
    if (deploy.branchName === null) {
      // This means we're using an external host, rather than building from source.
      await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.READY }, runUUID);
      logger.info(`${uuidText} [${deploy?.uuid}] Deploy is marked ready for external Host`);
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
        logger.error(
          `${uuidText} Failed to retrieve SHA for ${owner}/${name}/${deploy.branchName} to build ${deploy.uuid}`
        );
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
      const gitOrg = (app_setup?.org && app_setup.org.trim()) || 'REPLACE_ME_ORG';
      if (!ecrDomain || !registry) {
        logger.child({ lifecycleDefaults }).error(`[BUILD ${deploy.uuid}] Missing ECR config to build image`);
        await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.ERROR }, runUUID);
        return false;
      }

      const tagsExist =
        (await codefresh.tagExists({ tag, ecrRepo, uuid })) &&
        (!initDockerfilePath || (await codefresh.tagExists({ tag: initTag, ecrRepo, uuid })));

      logger.debug(`${uuidText} Tags exist check for ${deploy.uuid}: ${tagsExist}`);

      // Check for and skip duplicates
      if (!tagsExist) {
        logger.info(`${uuidText} Building image`);

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
          logger.info(`${uuidText} Building image with native build (${deployable.builder.engine})`);

          const nativeOptions = {
            ...buildOptions,
            namespace: deploy.build.namespace,
            buildId: String(deploy.build.id),
            deployUuid: deploy.uuid, // Use the full deploy UUID which includes service name
            cacheRegistry: buildDefaults?.cacheRegistry || 'distribution.0env.com',
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

        logger.info(`${uuidText} Building image with Codefresh`);

        const buildPipelineId = await codefresh.buildImage(buildOptions);
        const buildLogs = `https://g.codefresh.io/build/${buildPipelineId}`;
        await this.patchAndUpdateActivityFeed(deploy, { buildLogs }, runUUID);
        await deploy.$query().patch({ buildPipelineId });
        const buildSuccess = await codefresh.waitForImage(buildPipelineId);
        const buildOutput = await codefresh.getLogs(buildPipelineId);
        await deploy.$query().patch({ buildOutput });

        if (buildSuccess) {
          await this.patchDeployWithTag({ tag, initTag, deploy, ecrDomain });
          logger.child({ url: buildLogs }).info(`${uuidText} Image built successfully`);
          return true;
        } else {
          await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILD_FAILED }, runUUID);
          logger.child({ url: buildLogs }).warn(`${uuidText} Error building image for ${deploy?.uuid}`);
          return false;
        }
      } else {
        logger.info(`${uuidText} Image already exist for ${deploy?.uuid}`);
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
      const awaitingService = deploy.uuid;
      const waitingForService = `${serviceName}-${build.uuid}`;

      const dependentDeploy = deploys.find((d) => d.uuid === waitingForService);

      if (dependentDeploy.uuid === waitingForService) {
        logger.info(`[BUILD ${awaitingService}]: ${awaitingService} is waiting for ${waitingForService} to complete`);

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
              logger.info(
                `[BUILD ${awaitingDeploy?.uuid}]: Empty pattern for key "${item.envKey}". Assuming build dependecy`
              );
              return;
            }

            const regex = new RegExp(item.pattern);
            const match = logs.match(regex);

            if (match && match[0]) {
              extractedValues[item.envKey] = match[0];
              logger.debug(
                `[BUILD ${awaitingDeploy?.uuid}]: Successfully extracted value: "${match[0]}" for key: "${item.envKey}" using pattern "${item.pattern}"`
              );
            } else {
              logger.info(
                `[BUILD ${awaitingDeploy?.uuid}]: No match found for pattern "${item.pattern}" in ${serviceName} build pipeline with id: ${pipelineId}. Value of ${item.envKey} will be empty`
              );
            }
          });
        } catch (error) {
          logger.error(`Error processing pipeline ${pipelineId} for service ${serviceName}:`, error);
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
