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

import Haikunator from 'haikunator';
import * as k8s from 'server/lib/kubernetes';
import * as cli from 'server/lib/cli';
import * as github from 'server/lib/github';
import { uninstallHelmReleases } from 'server/lib/helm';
import { customAlphabet, nanoid } from 'nanoid';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';

import { Build, Deploy, Environment, Service, BuildServiceOverride } from 'server/models';
import { BuildStatus, CLIDeployTypes, DeployStatus, DeployTypes } from 'shared/constants';
import { type DeployOptions } from './deploy';
import DeployService from './deploy';
import BaseService from './_service';
import _ from 'lodash';
import { QUEUE_NAMES } from 'shared/config';
import { LifecycleError } from 'server/lib/errors';
import rootLogger from 'server/lib/logger';
import { ParsingError } from 'server/lib/yamlConfigParser';
import { ValidationError } from 'server/lib/yamlConfigValidator';

import Fastly from 'server/lib/fastly';
import { constructBuildLinks, determineIfFastlyIsUsed, insertBuildLink } from 'shared/utils';
import { type LifecycleYamlConfigOptions } from 'server/models/yaml/types';
import { DeploymentManager } from 'server/lib/deploymentManager/deploymentManager';
import { Tracer } from 'server/lib/tracer';
import { redisClient } from 'server/lib/dependencies';
import { generateGraph } from 'server/lib/dependencyGraph';
import GlobalConfigService from './globalConfig';

const logger = rootLogger.child({
  filename: 'services/build.ts',
});

const tracer = Tracer.getInstance();
tracer.initialize('build-service');
export interface IngressConfiguration {
  host: string;
  altHosts?: string[];
  serviceHost: string;
  deployUUID: string;
  ipWhitelist: string[];
  pathPortMapping: Record<string, number>;
  readonly ingressAnnotations?: Record<string, any>;
}

export default class BuildService extends BaseService {
  fastly = new Fastly(this.redis);
  /**
   * For every build that is not closed
   * 1. Check if the PR is open, if not, destroy
   * 2. If PR is open, check if lifecycle label exists, if not, destroy.
   */
  async cleanupBuilds() {
    /* On close, delete the build associated with this PR, if one exists */
    const builds = await this.activeBuilds();
    for (const build of builds) {
      try {
        await build?.$fetchGraph('pullRequest.[repository]');
        if (build.pullRequest?.repository != null) {
          const isActive = await this.db.services.PullRequest.lifecycleEnabledForPullRequest(build.pullRequest);
          // Either we want the PR status to be closed or
          // if deployOnUpdate at the PR level (with the lifecycle-disabled! label)
          if (
            build.pullRequest.status === 'closed' ||
            (isActive === false && build.pullRequest.deployOnUpdate === false)
          ) {
            // Enqueue a deletion job
            const buildId = build?.id;
            if (!buildId) {
              logger.error(`[BUILD ${build?.uuid}][cleanupBuilds][buidIdError] No build ID found for this build!`);
            }
            logger.info(`[BUILD ${build?.uuid}] Queuing build for deletion`);
            await this.db.services.BuildService.deleteQueue.add('delete', { buildId });
          }
        }
      } catch (e) {
        logger.error(`[BUILD ${build.uuid}] Can't cleanup build: ${e}`);
      }
    }
  }

  /**
   * Returns a list of all of the active builds
   */
  async activeBuilds(): Promise<Build[]> {
    const builds = await this.db.models.Build.query()
      .whereNot('status', 'torn_down')
      .whereNot('status', 'pending')
      .withGraphFetched('deploys.[service.[repository]]');
    return builds;
  }

  /**
   * Returns namespace of a build based on either id or uuid.
   */
  async getNamespace({ id, uuid }: { id?: number; uuid?: string }): Promise<string> {
    if (!id && !uuid) {
      throw new Error('Either "id" or "uuid" must be provided.');
    }
    const queryCondition = id ? { id } : { uuid };
    const build = await this.db.models.Build.query().findOne(queryCondition);

    if (!build) {
      throw new Error(`[BUILD ${uuid ? uuid : id}] Build not found when looking for namespace`);
    }
    return build?.namespace;
  }

  /**
   * Returns an array of domain configurations for this build
   */
  async domainsAndCertificatesForBuild(build: Build, allServices: boolean): Promise<IngressConfiguration[]> {
    let result: IngressConfiguration[];

    if (build?.enableFullYaml) {
      await build?.$fetchGraph('deploys.[deployable]');
      const deploys = build?.deploys;

      result = _.flatten(
        await Promise.all(
          deploys
            .filter(
              (deploy) =>
                deploy &&
                (allServices || deploy.active) &&
                deploy.deployable &&
                deploy.deployable.public &&
                DeployTypes.HELM !== deploy.deployable.type && // helm deploy ingresses will be managed by helm
                (deploy.deployable.type === DeployTypes.DOCKER || deploy.deployable.type === DeployTypes.GITHUB)
            )
            .map(async (deploy) => {
              return this.ingressConfigurationForDeploy(deploy);
            })
        )
      );
    } else {
      await build?.$fetchGraph('deploys.[service]');
      const deploys = build?.deploys;
      if (!deploys) return [];

      result = _.flatten(
        await Promise.all(
          deploys
            .filter(
              (deploy) =>
                deploy &&
                (allServices || deploy.active) &&
                deploy.service &&
                deploy.service.public &&
                (deploy.service.type === DeployTypes.DOCKER || deploy.service.type === DeployTypes.GITHUB)
            )
            .map((deploy) => {
              logger.debug(`${deploy.uuid}: active = ${deploy.active}`);
              return this.ingressConfigurationForDeploy(deploy);
            })
        )
      );
    }

    return result;
  }

  /**
   * Generates an ingress configuration for a single deploy
   * @param deploy
   */
  private async ingressConfigurationForDeploy(deploy: Deploy): Promise<IngressConfiguration[]> {
    await deploy.$fetchGraph('[build, service, deployable]');
    const { build, service, deployable } = deploy;

    if (build?.enableFullYaml) {
      if (deployable.hostPortMapping && Object.keys(deployable.hostPortMapping).length > 0) {
        return Object.keys(deployable.hostPortMapping).map((key) => {
          return {
            host: `${key}-${this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)}`,
            deployUUID: `${key}-${deploy.uuid}`,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deploy.deployable.ipWhitelist,
            ingressAnnotations: deploy.deployable.ingressAnnotations,
            pathPortMapping: {
              '/': parseInt(deploy.deployable.hostPortMapping[key], 10),
            },
          };
        });
      } else if (deploy.deployable.pathPortMapping && Object.keys(deploy.deployable.pathPortMapping).length > 0) {
        return [
          {
            host: `${this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)}`,
            deployUUID: `${deploy.uuid}`,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deploy.deployable.ipWhitelist,
            ingressAnnotations: deploy.deployable.ingressAnnotations,
            pathPortMapping: deploy.deployable.pathPortMapping,
          },
        ];
      } else {
        return [
          {
            host: this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable),
            deployUUID: deploy.uuid,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deploy.deployable.ipWhitelist,
            ingressAnnotations: deploy.deployable.ingressAnnotations,
            pathPortMapping: {
              '/': parseInt(deploy.deployable.port, 10),
            },
          },
        ];
      }
    } else {
      if (service.hostPortMapping && Object.keys(service.hostPortMapping).length > 0) {
        return Object.keys(service.hostPortMapping).map((key) => {
          return {
            host: `${key}-${this.db.services.Deploy.hostForServiceDeploy(deploy, service)}`,
            deployUUID: `${key}-${deploy.uuid}`,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: service.ipWhitelist,
            pathPortMapping: {
              '/': parseInt(service.hostPortMapping[key], 10),
            },
          };
        });
      } else if (service.pathPortMapping && Object.keys(service.pathPortMapping).length > 0) {
        return [
          {
            host: `${this.db.services.Deploy.hostForServiceDeploy(deploy, service)}`,
            deployUUID: `${deploy.uuid}`,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deploy.service.ipWhitelist,
            pathPortMapping: deploy.service.pathPortMapping,
          },
        ];
      } else {
        return [
          {
            host: this.db.services.Deploy.hostForServiceDeploy(deploy, service),
            deployUUID: deploy.uuid,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deploy.service.ipWhitelist,
            pathPortMapping: {
              '/': parseInt(deploy.service.port, 10),
            },
          },
        ];
      }
    }
  }

  /**
   * Returns an array of all of the domain configurations & certificates for ingress purposes
   */
  async activeDomainsAndCertificatesForIngress(): Promise<IngressConfiguration[]> {
    const activeBuilds = await this.activeBuilds();
    return _.compact(
      _.flatten(
        // Active services only
        await Promise.all(activeBuilds.map(async (build) => this.domainsAndCertificatesForBuild(build, false)))
      )
    );
  }

  /**
   * Returns an array of all of the domain configurations & certificates for ingress purposes
   */
  async configurationsForBuildId(buildId: number, allServices: boolean = false): Promise<IngressConfiguration[]> {
    const build = await this.db.models.Build.findOne({ id: buildId });
    await build?.$fetchGraph('deploys.[service.[repository]]');
    return this.domainsAndCertificatesForBuild(build, allServices);
  }

  public async createBuildAndDeploys({
    repositoryId,
    repositoryBranchName,
    installationId,
    pullRequestId,
    environmentId,
    lifecycleConfig,
  }: DeployOptions & { repositoryId: string }) {
    const environments = await this.getEnvironmentsToBuild(environmentId, repositoryId);

    if (!environments.length) {
      logger.debug('No matching environments');
      return;
    }

    try {
      const promises = environments.map((environment) => {
        return this.createBuild(
          environment,
          {
            repositoryId,
            repositoryBranchName,
            installationId,
            pullRequestId,
          },
          lifecycleConfig
        );
      });
      await Promise.all(promises);
    } catch (err) {
      logger.fatal(`Failed to create and deploy build due to fatal error: ${err}`);
    }
  }

  private async importYamlConfigFile(environment: Environment, build: Build) {
    // Write the deployables here for now and not going to use them yet.
    try {
      const buildId = build?.id;
      await this.db.services.Deployable.upsertDeployables(buildId, build.uuid, build.pullRequest, environment, build);

      await this.db.services.Webhook.upsertWebhooksWithYaml(build, build.pullRequest);
    } catch (error) {
      if (error instanceof ParsingError) {
        logger.error(`[BUILD ${build.uuid}] Invalid Lifecycle Config File: ${error}`);

        throw error;
      } else if (error instanceof ValidationError) {
        logger.error(`[BUILD ${build.uuid}] Invalid Lifecycle Config File: ${error}`);

        throw error;
      } else {
        // Temporary warps around the new implementation so it won't F up production if i did something stupid.
        // This code has no use in production yet but will start collecting data to validate if implementation works or not.
        logger.warn(`[BUILD ${build.uuid}] No worry. Nothing is bombed. Can ignore this error: ${error}`);
      }
    }
  }

  public async createBuild(
    environment: Environment,
    options: DeployOptions,
    lifecycleConfig: LifecycleYamlConfigOptions
  ) {
    try {
      const build = await this.findOrCreateBuild(environment, options, lifecycleConfig);

      // After a build is susccessfully created or retrieved,
      // we need to create or update the deployables to be used for build and deploy.
      if (build && options != null) {
        await build?.$fetchGraph('pullRequest');

        /* Set populate deploys */
        const runUUID = nanoid();
        /* We now own the build for as long as we see this UUID */
        await build.$query().patch({
          runUUID,
        });

        try {
          const isClassicModeOnly = environment?.classicModeOnly ?? false;
          if (!isClassicModeOnly) {
            await this.importYamlConfigFile(environment, build);
          }

          if (options.repositoryId && options.repositoryBranchName) {
            logger.debug(
              `[BUILD ${build.uuid}] Setting up default build services for repositoryID:${options.repositoryId} branch:${options.repositoryBranchName}`
            );

            await this.setupDefaultBuildServiceOverrides(
              build,
              environment,
              options.repositoryId,
              options.repositoryBranchName
            );
          }

          const deploys = await this.db.services.Deploy.findOrCreateDeploys(environment, build);

          if (deploys) {
            build.$setRelated('deploys', deploys);
            await build?.$fetchGraph('pullRequest');

            await this.updateStatusAndComment(build, BuildStatus.PENDING, runUUID, true, true);
          } else {
            throw new Error(
              `[BUILD ${build?.id}] [${environment.id}] Unable to find or create deploys by using build and environment.`
            );
          }
        } catch (error) {
          if (error instanceof ParsingError || error instanceof ValidationError) {
            await this.updateStatusAndComment(build, BuildStatus.CONFIG_ERROR, runUUID, true, true, error);
          }
        }
      } else {
        throw new Error('Missing build or deployment options from environment.');
      }
    } catch (error) {
      logger.fatal(`Failed to create build and deploys due to fatal error: ${error}`);
    }
  }

  /**
   * Deploy an existing build/PR (usually happens when adding the lifecycle-deploy! label)
   * @param build Build associates to a PR
   * @param deploy deploy on changed?
   */
  public async resolveAndDeployBuild(build: Build, isDeploy: boolean, githubRepositoryId = null) {
    // We have to always assume there may be no service entry into the database
    // since the service config exists only in the YAML file.
    /* Set populate deploys */
    const runUUID = nanoid();
    /* We now own the build for as long as we see this UUID */
    const uuid = build?.uuid;
    const pullRequest = build?.pullRequest;
    const fullName = pullRequest?.fullName;
    const branchName = pullRequest?.branchName;
    let latestCommit = pullRequest?.latestCommit;
    try {
      await build.$query().patch({
        runUUID,
      });
      await build?.$fetchGraph('[environment.[services], pullRequest.[repository]]');
      const environment = build?.environment;
      const [owner, name] = fullName.split('/');
      if (!latestCommit) {
        latestCommit = await github.getSHAForBranch(branchName, owner, name);
      }
      const deploys = await this.db.services.Deploy.findOrCreateDeploys(environment, build);
      build?.$setRelated('deploys', deploys);
      await build?.$fetchGraph('pullRequest');
      await new BuildEnvironmentVariables(this.db).resolve(build);
      await this.markConfigurationsAsBuilt(build);
      await this.updateStatusAndComment(build, BuildStatus.BUILDING, runUUID, true, true);
      const pullRequest = build?.pullRequest;
      await pullRequest.$fetchGraph('repository');

      try {
        const dependencyGraph = await generateGraph(build, 'TB');
        await build.$query().patch({
          dependencyGraph,
        });
      } catch (error) {
        // do nothing
        logger.warn(`Unable to generate dependecy graph for ${build.uuid}`, error);
      }

      // Build Docker Images & Deploy CLI Based Infra At the Same Time
      const results = await Promise.all([
        this.buildImages(build, githubRepositoryId),
        this.deployCLIServices(build, githubRepositoryId),
      ]);
      logger.debug(`[BUILD ${uuid}] Build results: buildImages=${results[0]}, deployCLIServices=${results[1]}`);
      const success = _.every(results);
      /* Verify that all deploys are successfully built that are active */
      if (success) {
        await this.db.services.BuildService.updateStatusAndComment(build, BuildStatus.BUILT, runUUID, true, true);

        if (isDeploy) {
          await this.updateStatusAndComment(build, BuildStatus.DEPLOYING, runUUID, true, true);

          const applySuccess = await this.generateAndApplyManifests({
            build,
            githubRepositoryId,
            namespace: build.namespace,
          });
          if (applySuccess) {
            await this.updateStatusAndComment(build, BuildStatus.DEPLOYED, runUUID, true, true);
          } else {
            await this.updateStatusAndComment(build, BuildStatus.ERROR, runUUID, true, true);
          }
        }
      } else {
        // If it's in an error state, then update the build to an error state,
        // update the activity feed, and return.
        logger.warn(
          `[BUILD ${uuid}][resolveAndDeployBuild] Build is in an errored state. Not commencing with rollout for ${fullName}/${branchName}:${latestCommit}`
        );
        await this.updateStatusAndComment(build, BuildStatus.ERROR, runUUID, true, true);
      }
    } catch (error) {
      logger.child({ error }).error(`[BUILD ${uuid}][resolveAndDeployBuild][ERROR]  Failed to deploy build: ${error}`);
      await this.updateStatusAndComment(build, BuildStatus.ERROR, runUUID, true, true, error);
    }

    return build;
  }

  /**
   * Creates a build if no build exists for the given UUID
   * @param environment the environment to use for this build
   * @param options
   */
  private async findOrCreateBuild(
    environment: Environment,
    options: DeployOptions,
    lifecycleConfig: LifecycleYamlConfigOptions
  ) {
    const haikunator = new Haikunator({
      defaults: {
        tokenLength: 6,
      },
    });
    const uuid = haikunator.haikunate();
    const nanoId = customAlphabet('1234567890abcdef', 6);

    const env = lifecycleConfig?.environment;
    const enabledFeatures = env?.enabledFeatures || [];
    const githubDeployments = env?.githubDeployments || false;
    const build =
      (await this.db.models.Build.query()
        .where('pullRequestId', options.pullRequestId)
        .where('environmentId', environment.id)
        .whereNull('deletedAt')
        .first()) ||
      (await this.db.models.Build.create({
        uuid,
        environmentId: environment.id,
        status: BuildStatus.QUEUED,
        pullRequestId: options.pullRequestId,
        sha: nanoId(),
        enableFullYaml: this.db.services.Environment.enableFullYamlSupport(environment),
        enabledFeatures: JSON.stringify(enabledFeatures),
        githubDeployments,
        namespace: `env-${uuid}`,
      }));
    logger.info(`[BUILD ${build.uuid}] Created build for pull request branch: ${options.repositoryBranchName}`);
    return build;
  }

  private async setupDefaultBuildServiceOverrides(
    build: Build,
    environment: Environment,
    repositoryId: string,
    branchName: string
  ): Promise<BuildServiceOverride[]> {
    // Deal with database configuration first
    await environment.$fetchGraph('[defaultServices, optionalServices]');

    let servicesToOverride = environment.defaultServices
      .concat(environment.optionalServices)
      .filter((s) => s.repositoryId === repositoryId);

    const dependencies = (
      await this.db.models.Service.query().whereIn(
        'dependsOnServiceId',
        servicesToOverride.map((el) => el.id)
      )
    ).filter((s) => s.repositoryId === repositoryId);

    servicesToOverride = servicesToOverride.concat(dependencies);
    const buildServiceOverrides = Promise.all(
      servicesToOverride.map(async (serviceToOverride) => {
        return this.createBuildServiceOverride(build, serviceToOverride, branchName);
      })
    );

    return buildServiceOverrides;
  }

  private async createBuildServiceOverride(
    build: Build,
    service: Service,
    branchName: string
  ): Promise<BuildServiceOverride> {
    const buildId = build?.id;
    if (!buildId) {
      logger.error(`[BUILD ${build?.uuid}][createBuildServiceOverride][buidIdError] No build ID found for this build!`);
    }
    const serviceId = service?.id;
    if (!serviceId) {
      logger.error(
        `[BUILD ${build?.uuid}][createBuildServiceOverride][serviceIdError] No service ID found for this service!`
      );
    }
    const buildServiceOverride =
      (await this.db.models.BuildServiceOverride.findOne({
        buildId,
        serviceId,
      })) ||
      (await this.db.models.BuildServiceOverride.create({
        buildId,
        serviceId,
        branchName,
      }));

    return buildServiceOverride;
  }

  async deleteBuild(build: Build) {
    if (build !== undefined && build !== null && ![BuildStatus.TORN_DOWN].includes(build.status as BuildStatus)) {
      try {
        await build.reload();
        await build?.$fetchGraph('[services, deploys.[service, build]]');

        logger.debug(`[DELETE ${build?.uuid}] Triggering cleanup`);

        await this.updateStatusAndComment(build, BuildStatus.TEARING_DOWN, build.runUUID, true, true).catch((error) => {
          logger.warn(`[BUILD: ${build.uuid}] Failed to update status to ${BuildStatus.TEARING_DOWN}: ${error}`);
        });
        await Promise.all([k8s.deleteBuild(build), cli.deleteBuild(build), uninstallHelmReleases(build)]).catch(
          (error) => logger.child({ build, error }).error(`[DELETE ${build?.uuid}] Failed to cleanup build`)
        );

        await Promise.all(
          build.deploys.map(async (deploy) => {
            await deploy.$query().patch({ status: DeployStatus.TORN_DOWN });
            if (build.githubDeployments)
              await this.db.services.GithubService.githubDeploymentQueue.add('deployment', {
                deployId: deploy.id,
                action: 'delete',
              });
          })
        );

        await k8s.deleteNamespace(build.namespace);
        await this.db.services.Ingress.ingressCleanupQueue.add('cleanup', {
          buildId: build.id,
        });
        logger.info(`[DELETE ${build?.uuid}] Deleted build`);
        await this.updateStatusAndComment(build, BuildStatus.TORN_DOWN, build.runUUID, true, true).catch((error) => {
          logger.warn(`[BUILD: ${build.uuid}] Failed to update status to ${BuildStatus.TORN_DOWN}: ${error}`);
        });
      } catch (e) {
        logger.error(
          `[DELETE ${build.uuid}] Error deleting build: ${e instanceof LifecycleError ? e.getMessage() : e}`
        );
      }
    }
  }

  /**
   * Helper method to update github activity messages for the given build.
   * Takes in a runUUID, which is compared before issu
   * @param build
   * @param status
   * @param runUUID
   * @param force
   * @returns
   */
  async updateStatusAndComment(
    build: Build,
    status: BuildStatus,
    runUUID: string,
    updateMissionControl: boolean,
    updateStatus: boolean,
    error: Error = null
  ) {
    try {
      await build.reload();
      await build?.$fetchGraph('[deploys.[service, deployable], pullRequest.[repository]]');

      const { deploys, pullRequest } = build;
      const { repository } = pullRequest;

      if (build.runUUID !== runUUID) {
        return;
      } else {
        await build.$query().patch({
          status,
        });

        // add dashboard links to build database
        let dashboardLinks = constructBuildLinks(build.uuid);
        const hasFastly = determineIfFastlyIsUsed(deploys);
        if (hasFastly) {
          try {
            const fastlyDashboardUrl = await this.fastly.getServiceDashboardUrl(build.uuid, 'fastly');
            if (fastlyDashboardUrl) {
              dashboardLinks = insertBuildLink(dashboardLinks, 'Fastly Dashboard', fastlyDashboardUrl.href);
            }
          } catch (err) {
            logger.error(`[BUILD ${build.uuid}] Unable to get Fastly dashboard URL: ${err}`);
          }
        }
        await build.$query().patch({ dashboardLinks });

        await this.db.services.ActivityStream.updatePullRequestActivityStream(
          build,
          deploys,
          pullRequest,
          repository,
          updateMissionControl,
          updateStatus,
          error
        ).catch((e) => {
          logger.error(`[BUILD ${build.uuid}] Unable to update pull request activity stream: ${e}`);
        });
      }
    } finally {
      // Even S**T happen, we still try to fire the LC webhooks no matter what
      // Pull webhooks for this environment, and run them
      logger.debug(`[BUILD ${build.uuid}] Build status changed to ${build.status}.`);

      await this.db.services.Webhook.webhookQueue.add('webhook', { buildId: build.id });
    }
  }

  async markConfigurationsAsBuilt(build: Build) {
    try {
      await build?.$fetchGraph({
        deploys: {
          service: true,
          deployable: true,
        },
      });
      const deploys = build?.deploys || [];
      const configType = DeployTypes.CONFIGURATION;
      if (!deploys) return;
      const configDeploys = deploys.filter(
        ({ service, deployable }) => service?.type === configType || deployable?.type === configType
      );
      if (configDeploys?.length === 0) {
        return;
      }
      for (const deploy of configDeploys) {
        await deploy.$query().patch({ status: DeployStatus.BUILT });
      }
      const configUUIDs = configDeploys.map((deploy) => deploy?.uuid).join(',');
      logger.info(`[BUILD ${build.uuid}] Updated configuration type deploy ${configUUIDs} as built`);
    } catch (error) {
      logger.error(`[BUILD ${build.uuid}] Failed to update configuration type deploy as built: ${error}`);
    }
  }

  async deployCLIServices(build: Build, githubRepositoryId = null): Promise<boolean> {
    await build?.$fetchGraph({
      deploys: {
        service: true,
        deployable: true,
      },
    });
    const buildId = build?.id;
    if (!buildId) {
      logger.error(`[BUILD ${build?.uuid}][deployCLIServices][buidIdError] No build ID found for this build!`);
    }
    const deploys = await Deploy.query()
      .where({ buildId, ...(githubRepositoryId ? { githubRepositoryId } : {}) })
      .withGraphFetched({ service: true, deployable: true });
    if (!deploys || deploys.length === 0) return false;
    try {
      if (build?.enableFullYaml) {
        return _.every(
          await Promise.all(
            deploys
              .filter((d) => d.active && CLIDeployTypes.has(d.deployable.type))
              .map(async (deploy) => {
                if (!deploy) {
                  logger.debug(
                    `[BUILD ${build?.uuid}][deployCLIServices] This deploy is undefined. Deploys: %j`,
                    deploys
                  );
                  return false;
                }
                try {
                  const result = await this.db.services.Deploy.deployCLI(deploy);
                  return result;
                } catch (err) {
                  logger.error(`[BUILD ${build?.uuid}][DEPLOY ${deploy?.uuid}][deployCLIServices] Error: ${err}`);
                  return false;
                }
              })
          )
        );
      } else {
        return _.every(
          await Promise.all(
            deploys
              .filter((d) => d.active && CLIDeployTypes.has(d.service.type))
              .map(async (deploy) => {
                if (deploy === undefined) {
                  logger.debug(
                    "Somehow deploy is undefined here.... That shouldn't be possible? Build deploy length is %s",
                    deploys.length
                  );
                }
                const result = await this.db.services.Deploy.deployCLI(deploy).catch((error) => {
                  logger.error(`[${build.uuid} Build Failure: CLI Failed => ${error}`);
                  return false;
                });

                if (!result)
                  logger.info(`[BUILD ${build?.uuid}][${deploy.uuid}][deployCLIServices] CLI deploy unsuccessful`);
                return result;
              })
          )
        );
      }
    } catch (error) {
      logger.error(`[${build.uuid} Build Failure: CLI Failed => ${error}`);
      return false;
    }
  }

  /**
   * Builds the images for each deploy for a given build
   * @param build the parent build to build the images for
   * @param options
   */
  async buildImages(build: Build, githubRepositoryId = null): Promise<boolean> {
    const buildId = build?.id;
    if (!buildId) {
      logger.error(`[BUILD ${build?.uuid}][buildImages][buidIdError] No build ID found for this build!`);
    }

    const deploys = await Deploy.query()
      .where({
        buildId,
        ...(githubRepositoryId ? { githubRepositoryId } : {}),
      })
      .withGraphFetched({
        service: true,
        deployable: true,
      });

    if (build?.enableFullYaml) {
      try {
        const deploysToBuild = deploys.filter((d) => {
          return (
            d.active &&
            (d.deployable.type === DeployTypes.DOCKER ||
              d.deployable.type === DeployTypes.GITHUB ||
              d.deployable.type === DeployTypes.HELM)
          );
        });
        logger.debug(
          `[BUILD ${build.uuid}] Processing ${deploysToBuild.length} deploys for build: ${deploysToBuild
            .map((d) => d.uuid)
            .join(', ')}`
        );

        const results = await Promise.all(
          deploysToBuild.map(async (deploy, index) => {
            if (deploy === undefined) {
              logger.debug(
                "Somehow deploy deploy is undefined here.... That shouldn't be possible? Build deploy length is %s",
                build.deploys.length
              );
            }
            await deploy.$query().patchAndFetch({
              deployPipelineId: null,
              deployOutput: null,
            });
            const result = await this.db.services.Deploy.buildImage(deploy, build.enableFullYaml, index);
            logger.debug(`[BUILD ${build.uuid}] Deploy ${deploy.uuid} buildImage completed with result: ${result}`);
            return result;
          })
        );
        const finalResult = _.every(results);
        logger.debug(
          `[BUILD ${build.uuid}] Build results for each deploy: ${results.join(', ')}, final: ${finalResult}`
        );
        return finalResult;
      } catch (error) {
        logger.error(`[${build.uuid}] Uncaught Docker Build Error: ${error}`);
        return false;
      }
    } else {
      try {
        const results = await Promise.all(
          deploys
            .filter((d) => {
              logger.debug(`[${d.uuid}] Check for service type for docker builds: %j`, d.service);
              return d.active && (d.service.type === DeployTypes.DOCKER || d.service.type === DeployTypes.GITHUB);
            })
            .map(async (deploy, index) => {
              if (deploy === undefined) {
                logger.debug(
                  "Somehow deploy deploy is undefined here.... That shouldn't be possible? Build deploy length is %s",
                  build.deploys.length
                );
              }
              const result = await this.db.services.Deploy.buildImage(deploy, build.enableFullYaml, index);
              logger.debug(`[BUILD ${build.uuid}] Deploy ${deploy.uuid} buildImage completed with result: ${result}`);
              if (!result) logger.info(`[BUILD ${build?.uuid}][${deploy.uuid}][buildImages] build image unsuccessful`);
              return result;
            })
        );
        return _.every(results);
      } catch (error) {
        logger.error(`[${build.uuid}] Uncaught Docker Build Error: ${error}`);
        return false;
      }
    }
  }

  /**
   * Generates a k8s manifest for a given build, and applies it to the k8s cluster
   * @param build the build for which we are generating and deploying a manifest for
   */
  async generateAndApplyManifests({
    build,
    githubRepositoryId = null,
    namespace,
  }: {
    build: Build;
    githubRepositoryId: string;
    namespace: string;
  }): Promise<boolean> {
    if (build?.enableFullYaml) {
      try {
        const buildId = build?.id;

        const { serviceAccount } = await GlobalConfigService.getInstance().getAllConfigs();
        const serviceAccountName = serviceAccount?.name || 'default';
        // create namespace and annotate the service account
        await k8s.createOrUpdateNamespace({ name: build.namespace, buildUUID: build.uuid, staticEnv: build.isStatic });
        await k8s.createOrUpdateServiceAccount({
          namespace: build.namespace,
          role: serviceAccount?.role,
        });

        const allDeploys = await Deploy.query()
          .where({
            buildId,
            ...(githubRepositoryId ? { githubRepositoryId } : {}),
          })
          .withGraphFetched({
            service: {
              serviceDisks: true,
            },
            deployable: true,
          });

        const activeDeploys = allDeploys.filter((d) => d.active);

        // Generate manifests for GitHub/Docker/CLI deploys
        for (const deploy of activeDeploys) {
          const deployType = deploy.deployable.type;
          if (
            deployType === DeployTypes.GITHUB ||
            deployType === DeployTypes.DOCKER ||
            CLIDeployTypes.has(deployType)
          ) {
            // Generate individual manifest for this deploy
            const manifest = k8s.generateDeployManifest({
              deploy,
              build,
              namespace,
              serviceAccountName,
            });

            // Store manifest in deploy record
            if (manifest && manifest.trim().length > 0) {
              await deploy.$query().patch({ manifest });
            }
          }
        }

        // Use DeploymentManager for all active deploys (both Helm and GitHub types)
        if (activeDeploys.length > 0) {
          // we should ignore Codefresh services here since we dont deploy anything
          const managedDeploys = activeDeploys.filter((d) => d.deployable.type !== DeployTypes.CODEFRESH);
          const deploymentManager = new DeploymentManager(managedDeploys);
          await deploymentManager.deploy();
        }

        // Queue ingress creation after all deployments
        await this.db.services.Ingress.ingressManifestQueue.add('manifest', {
          buildId,
        });

        // Legacy manifest generation for backwards compatibility
        const githubTypeDeploys = activeDeploys.filter(
          (d) =>
            d.deployable.type === DeployTypes.GITHUB ||
            d.deployable.type === DeployTypes.DOCKER ||
            CLIDeployTypes.has(d.deployable.type)
        );

        if (githubTypeDeploys.length > 0) {
          const legacyManifest = k8s.generateManifest({
            build,
            deploys: githubTypeDeploys,
            uuid: build.uuid,
            namespace,
            serviceAccountName,
          });
          if (legacyManifest && legacyManifest.replace(/---/g, '').trim().length > 0) {
            await build.$query().patch({ manifest: legacyManifest });
          }
        }
        await this.updateDeploysImageDetails(build);
        return true;
      } catch (e) {
        logger.warn(`[BUILD ${build.uuid}] Some problem when deploying services to Kubernetes cluster: ${e}`);
        throw e;
      }
    } else {
      try {
        const buildId = build?.id;
        if (!buildId) {
          logger.error(
            `[BUILD ${build?.uuid}][generateAndApplyManifests][buidIdError] No build ID found for this build!`
          );
        }

        const { serviceAccount } = await GlobalConfigService.getInstance().getAllConfigs();
        const serviceAccountName = serviceAccount?.name || 'default';

        const deploys = (
          await Deploy.query()
            .where({ buildId })
            .withGraphFetched({
              service: {
                serviceDisks: true,
              },
            })
        ).filter(
          (d) =>
            d.active &&
            (d.service.type === DeployTypes.GITHUB ||
              d.service.type === DeployTypes.DOCKER ||
              CLIDeployTypes.has(d.service.type))
        );
        const manifest = k8s.generateManifest({ build, deploys, uuid: build.uuid, namespace, serviceAccountName });
        if (manifest && manifest.replace(/---/g, '').trim().length > 0) {
          await build.$query().patch({ manifest });
          await k8s.applyManifests(build);
        }

        /* Generate the nginx manifests for this new build */
        await this.db.services.Ingress.ingressManifestQueue.add('manifest', {
          buildId,
        });

        const isReady = await k8s.waitForPodReady(build);
        if (isReady) {
          // Mark all deploys as READY after pods are ready
          const deployService = new DeployService();
          await Promise.all(
            deploys.map((deploy) =>
              deployService.patchAndUpdateActivityFeed(
                deploy,
                {
                  status: DeployStatus.READY,
                  statusMessage: 'K8s pods are ready',
                },
                build.runUUID
              )
            )
          );
          await this.updateDeploysImageDetails(build);
        }

        return true;
      } catch (e) {
        logger.warn(`[BUILD ${build.uuid}] Some problem when deploying services to Kubernetes cluster: ${e}`);
        return false;
      }
    }
  }

  /**
   * Returns an array of environments to build.
   * @param environmentId the default environmentId (if one exists)
   * @param repositoryId the repository to use for finding relevant environments, if needed
   */
  private async getEnvironmentsToBuild(environmentId: number, repositoryId: string) {
    let environments: Environment[] = [];
    if (environmentId != null) {
      environments.push(await this.db.models.Environment.findOne({ id: environmentId }));
    } else {
      environments = environments.concat(
        await this.db.models.Environment.find().withGraphJoined('services').where('services.repositoryId', repositoryId)
      );
    }

    return environments;
  }

  private async updateDeploysImageDetails(build: Build) {
    await build?.$fetchGraph('deploys');
    await Promise.all(
      build.deploys.map((deploy) => deploy.$query().patch({ isRunningLatest: true, runningImage: deploy?.dockerImage }))
    );
    logger.debug(`[BUILD ${build.uuid}] Updated deploys with running image and latest status`);
  }

  /**
   * A queue entrypoint for the purpose of performing builds and deploying to K8
   */
  deleteQueue = this.queueManager.registerQueue(QUEUE_NAMES.DELETE_QUEUE, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  /**
   * A queue entrypoint for the purpose of deleting builds
   */
  buildQueue = this.queueManager.registerQueue(QUEUE_NAMES.BUILD_QUEUE, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  /**
   * A queue specifically for the purpose of performing builds and deploying to K8
   */
  resolveAndDeployBuildQueue = this.queueManager.registerQueue(QUEUE_NAMES.RESOLVE_AND_DEPLOY, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  /**
   * Process the deleion of a build async
   * @param job the BullMQ job with the buildId
   */
  processDeleteQueue = async (job) => {
    try {
      const buildId = job.data.buildId;
      const build = await this.db.models.Build.query().findOne({
        id: buildId,
      });
      await this.db.services.BuildService.deleteBuild(build);
    } catch (error) {
      logger.error(`Error processing delete queue for build ${job.data.buildId}:`, error);
    }
  };

  /**
   * Kicks off the process of actually deploying a build to the kubernetes cluster
   * @param job the BullMQ job with the buildID
   */
  processBuildQueue = async (job) => {
    // No retry behavior - catch errors and log them
    const buildId = job.data.buildId;
    const githubRepositoryId = job?.data?.githubRepositoryId;
    let build;
    try {
      build = await this.db.models.Build.query().findOne({
        id: buildId,
      });

      await build?.$fetchGraph('[pullRequest, environment]');
      await build.pullRequest.$fetchGraph('[repository]');

      await this.importYamlConfigFile(build?.environment, build);
      const deploys = await this.db.services.Deploy.findOrCreateDeploys(build?.environment, build);

      build.$setRelated('deploys', deploys);
      await build?.$fetchGraph('deploys.[service, deployable]');

      await this.db.services.BuildService.resolveAndDeployBuild(
        build,
        build?.pullRequest?.deployOnUpdate,
        githubRepositoryId
      );
    } catch (error) {
      if (error instanceof ParsingError || error instanceof ValidationError) {
        this.updateStatusAndComment(build, BuildStatus.CONFIG_ERROR, build?.runUUID, true, true, error);
      } else {
        logger.fatal(`[BUILD ${build?.uuid}] Uncaught exception: ${error}`);
      }
    }
  };

  /**
   * Initial step in routing a build into the build queue. A job will either get enqueue in the build queue
   * after this job
   * @param job the Bull job with the buildID
   * @param done the Bull callback to invoke when we're done
   */
  processResolveAndDeployBuildQueue = async (job) => {
    let jobId;
    let buildId: number;
    try {
      jobId = job?.data?.buildId;
      const githubRepositoryId = job?.data?.githubRepositoryId;
      if (!jobId) throw new Error('jobId is required but undefined');
      const build = await this.db.models.Build.query().findOne({
        id: jobId,
      });

      await build?.$fetchGraph('[pullRequest, environment]');
      await build.pullRequest.$fetchGraph('[repository]');
      buildId = build?.id;
      if (!buildId) throw new Error('buildId is required but undefined');

      if (!build.pullRequest.deployOnUpdate) {
        logger.info(`[BUILD ${build.uuid}] Pull request does not have deployOnUpdate enabled. Skipping build.`);
        return;
      }
      // Enqueue a standard resolve build
      await this.db.services.BuildService.buildQueue.add('build', { buildId, githubRepositoryId });
    } catch (error) {
      const text = `[BUILD ${buildId}][processResolveAndDeployBuildQueue] error processing buildId with the jobId, ${jobId}`;
      logger.child({ error }).error(text);
    }
  };
}
