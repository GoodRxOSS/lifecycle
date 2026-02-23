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
import { ingressBannerSnippet } from 'server/lib/helm/utils';
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
import { withLogContext, getLogger, extractContextForQueue, LogStage, updateLogContext } from 'server/lib/logger';
import { ParsingError, YamlConfigParser } from 'server/lib/yamlConfigParser';
import { ValidationError, YamlConfigValidator } from 'server/lib/yamlConfigValidator';

import Fastly from 'server/lib/fastly';
import { constructBuildLinks, determineIfFastlyIsUsed, insertBuildLink } from 'shared/utils';
import { type LifecycleYamlConfigOptions } from 'server/models/yaml/types';
import { DeploymentManager } from 'server/lib/deploymentManager/deploymentManager';
import { Tracer } from 'server/lib/tracer';
import { redisClient } from 'server/lib/dependencies';
import { generateGraph } from 'server/lib/dependencyGraph';
import GlobalConfigService from './globalConfig';
import { paginate, PaginationMetadata, PaginationParams } from 'server/lib/paginate';
import { getYamlFileContentFromBranch } from 'server/lib/github';
import WebhookService from './webhook';

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
              getLogger().error('Build: id missing for=cleanup');
            }
            getLogger().info('Build: queuing action=delete');
            await this.db.services.BuildService.deleteQueue.add('delete', { buildId, ...extractContextForQueue() });
          }
        }
      } catch (e) {
        getLogger().error({ error: e }, 'Build: cleanup failed');
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
   * Returns a paginated list of all builds, excluding those with specified statuses.
   * By default, pagination is enabled with a limit of 25 items per page.
   * @param excludeStatuses A comma-separated string of build statuses to exclude from the results.
   * @param pagination Pagination parameters including page number and limit.
   * @returns An object containing the list of builds and pagination metadata.
   * */
  async getAllBuilds(
    excludeStatuses: string,
    filterByAuthor?: string,
    search?: string,
    pagination?: PaginationParams
  ): Promise<{
    data: Build[];
    paginationMetadata: PaginationMetadata;
  }> {
    const exclude = excludeStatuses ? excludeStatuses.split(',').map((s) => s.trim()) : [];

    const baseQuery = this.db.models.Build.query()
      .select('id', 'uuid', 'status', 'namespace', 'createdAt', 'updatedAt')
      .whereNotIn('status', exclude)
      .modify((qb) => {
        if (filterByAuthor) {
          qb.whereExists(this.db.models.Build.relatedQuery('pullRequest').where('githubLogin', filterByAuthor));
        }

        const term = (search ?? '').trim();
        if (term) {
          const like = `%${term.toLowerCase()}%`;

          qb.where((w) => {
            // Build table columns
            w.orWhereRaw('LOWER("uuid") LIKE ?', [like]).orWhereRaw('LOWER("namespace") LIKE ?', [like]);

            // Related pullRequest columns
            w.orWhereExists(
              this.db.models.Build.relatedQuery('pullRequest').where((pr) => {
                pr.whereRaw('LOWER("title") LIKE ?', [like])
                  .orWhereRaw('LOWER("fullName") LIKE ?', [like])
                  .orWhereRaw('LOWER("githubLogin") LIKE ?', [like]);
              })
            );
          });
        }
      })
      .withGraphFetched('[pullRequest, deploys.[deployable]]')
      .modifyGraph('pullRequest', (b) => {
        b.select('id', 'title', 'fullName', 'githubLogin', 'pullRequestNumber', 'branchName');
      })
      .modifyGraph('deploys', (b) => {
        b.select('id', 'uuid', 'status', 'active', 'deployableId');
      })
      .modifyGraph('deploys.deployable', (b) => {
        b.select('name');
      })
      .orderBy('updatedAt', 'desc');

    const { data, metadata: paginationMetadata } = await paginate<Build>(baseQuery, pagination);

    return { data, paginationMetadata };
  }

  async getBuildByUUID(uuid: string): Promise<Build | null> {
    const build = await this.db.models.Build.query()
      .findOne({ uuid })
      .select('id', 'uuid', 'status', 'namespace', 'manifest', 'sha', 'createdAt', 'updatedAt', 'dependencyGraph')
      .withGraphFetched('[pullRequest, deploys.[deployable, repository]]')
      .modifyGraph('pullRequest', (b) => {
        b.select('id', 'title', 'fullName', 'githubLogin', 'pullRequestNumber', 'branchName', 'status', 'labels');
      })
      .modifyGraph('deploys', (b) => {
        b.select(
          'id',
          'uuid',
          'status',
          'statusMessage',
          'active',
          'deployableId',
          'branchName',
          'publicUrl',
          'dockerImage',
          'buildLogs',
          'createdAt',
          'updatedAt',
          'sha',
          'initDockerImage'
        );
      })
      .modifyGraph('deploys.deployable', (b) => {
        b.select('name', 'type', 'dockerfilePath', 'deploymentDependsOn', 'builder', 'ecr', 'grpc', 'hostPortMapping');
      })
      .modifyGraph('deploys.repository', (b) => {
        b.select('fullName');
      });

    return build;
  }

  async redeployServiceFromBuild(buildUuid: string, serviceName: string) {
    const build = await this.db.models.Build.query()
      .findOne({
        uuid: buildUuid,
      })
      .withGraphFetched('deploys.deployable');

    if (!build) {
      getLogger().debug(`Build not found for ${buildUuid}.`);
      return {
        status: 'not_found',
        message: `Build not found for ${buildUuid}.`,
      };
    }

    const buildId = build.id;

    const deploy = build.deploys?.find((deploy) => deploy.deployable?.name === serviceName);

    if (!deploy || !deploy.deployable) {
      getLogger().debug(`Deployable ${serviceName} not found for ${buildUuid}.`);
      throw new Error(`Deployable ${serviceName} not found for ${buildUuid}.`);
    }

    const githubRepositoryId = deploy.deployable.repositoryId;

    const runUUID = nanoid();

    await this.resolveAndDeployBuildQueue.add('resolve-deploy', {
      buildId,
      githubRepositoryId,
      runUUID,
      ...extractContextForQueue(),
    });

    getLogger({ stage: LogStage.BUILD_QUEUED }).info(`Build: service redeploy queued service=${serviceName}`);

    const deployService = new DeployService();

    await deploy.$query().patchAndFetch({
      runUUID,
    });

    await deployService.patchAndUpdateActivityFeed(
      deploy,
      {
        status: DeployStatus.QUEUED,
      },
      runUUID,
      githubRepositoryId
    );

    return {
      status: 'success',
      message: `Redeploy for service ${serviceName} in environment ${buildUuid} has been queued`,
    };
  }

  async redeployBuild(buildUuid: string) {
    const correlationId = `api-redeploy-${Date.now()}-${nanoid(8)}`;
    return withLogContext({ correlationId, buildUuid }, async () => {
      const build = await this.db.models.Build.query()
        .findOne({ uuid: buildUuid })
        .withGraphFetched('deploys.deployable');

      if (!build) {
        getLogger().debug(`Build not found for ${buildUuid}.`);
        return {
          status: 'not_found',
          message: `Build not found for ${buildUuid}.`,
        };
      }

      const buildId = build.id;

      await this.resolveAndDeployBuildQueue.add('resolve-deploy', {
        buildId,
        runUUID: nanoid(),
        correlationId,
      });

      getLogger({ stage: LogStage.BUILD_QUEUED }).info('Build: redeploy queued');

      return {
        status: 'success',
        message: `Redeploy for build ${buildUuid} has been queued`,
      };
    });
  }

  async tearDownBuild(uuid: string) {
    return withLogContext({ buildUuid: uuid }, async () => {
      const build = await this.db.models.Build.query()
        .findOne({
          uuid,
        })
        .withGraphFetched('[deploys]');

      if (!build || build.isStatic) {
        getLogger().debug('Build does not exist or is static environment');
        return {
          status: 'not_found',
          message: `Build not found for ${uuid} or is static environment.`,
        };
      }

      const deploysIds = build.deploys?.map((deploy) => deploy.id) ?? [];

      await this.db.models.Build.query().findById(build.id).patch({
        status: BuildStatus.TORN_DOWN,
        statusMessage: 'Namespace was deleted successfully',
      });

      await this.db.models.Deploy.query()
        .whereIn('id', deploysIds)
        .patch({ status: DeployStatus.TORN_DOWN, statusMessage: 'Namespace was deleted successfully' });

      const updatedDeploys = await this.db.models.Deploy.query()
        .whereIn('id', deploysIds)
        .select('id', 'uuid', 'status');

      return {
        status: 'success',
        message: `Build ${uuid} has been torn down`,
        namespacesUpdated: updatedDeploys,
      };
    });
  }

  async invokeWebhooksForBuild(uuid: string) {
    const correlationId = `api-webhook-invoke-${Date.now()}-${nanoid(8)}`;

    return withLogContext({ correlationId, buildUuid: uuid }, async () => {
      const build = await this.db.models.Build.query().findOne({ uuid });

      if (!build) {
        getLogger().debug('Build not found');
        return {
          status: 'not_found',
          message: `Build not found for ${uuid}.`,
        };
      }

      if (!build.webhooksYaml) {
        getLogger().debug('No webhooks found for build');
        return {
          status: 'no_content',
          message: `No webhooks found for build ${uuid}.`,
        };
      }

      const webhookService = new WebhookService();
      await webhookService.webhookQueue.add('webhook', {
        buildId: build.id,
        correlationId,
      });

      getLogger({ stage: LogStage.WEBHOOK_PROCESSING }).info('Webhook invocation queued via API');

      return {
        status: 'success',
        message: `Webhooks for build ${uuid} have been queued`,
      };
    });
  }

  async validateLifecycleSchema(repo: string, branch: string): Promise<{ valid: boolean }> {
    try {
      const content = (await getYamlFileContentFromBranch(repo, branch)) as string;
      const parser = new YamlConfigParser();
      const config = parser.parseYamlConfigFromString(content);
      const isValid = new YamlConfigValidator().validate(config?.version, config);
      return { valid: isValid };
    } catch (error) {
      getLogger().error({ error }, `Build: ${repo}/${branch} lifecycle schema validation failed`);
      return { valid: false };
    }
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
              getLogger().debug(`Deploy active status: deployUuid=${deploy.uuid} active=${deploy.active}`);
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
    await deploy.$fetchGraph('[build.[pullRequest], service, deployable]');
    const { build, service, deployable } = deploy;

    if (!deployable) {
      throw new Error(`Deployable not found for deploy ${deploy.uuid}`);
    }

    const getIngressAnnotations = (baseAnnotations: Record<string, any> | undefined): Record<string, any> => {
      if (build?.enableFullYaml && deployable.envLens) {
        const bannerSnippet = ingressBannerSnippet(deploy);
        const bannerAnnotation = bannerSnippet.metadata?.annotations || {};
        return { ...(baseAnnotations || {}), ...bannerAnnotation };
      }
      return baseAnnotations || {};
    };

    if (build?.enableFullYaml) {
      if (deployable.hostPortMapping && Object.keys(deployable.hostPortMapping).length > 0) {
        return Object.keys(deployable.hostPortMapping).map((key) => {
          return {
            host: `${key}-${this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)}`,
            deployUUID: `${key}-${deploy.uuid}`,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deployable.ipWhitelist,
            ingressAnnotations: getIngressAnnotations(deployable.ingressAnnotations),
            pathPortMapping: {
              '/': parseInt(deployable.hostPortMapping[key], 10),
            },
          };
        });
      } else if (deployable.pathPortMapping && Object.keys(deployable.pathPortMapping).length > 0) {
        return [
          {
            host: `${this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)}`,
            deployUUID: `${deploy.uuid}`,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deployable.ipWhitelist,
            ingressAnnotations: getIngressAnnotations(deployable.ingressAnnotations),
            pathPortMapping: deployable.pathPortMapping,
          },
        ];
      } else {
        return [
          {
            host: this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable),
            deployUUID: deploy.uuid,
            serviceHost: `${deploy.uuid}`,
            ipWhitelist: deployable.ipWhitelist,
            ingressAnnotations: getIngressAnnotations(deployable.ingressAnnotations),
            pathPortMapping: {
              '/': parseInt(deployable.port, 10),
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
      getLogger().debug('Build: no matching environments');
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
      getLogger().fatal({ error: err }, 'Build: create and deploy failed');
    }
  }

  private async importYamlConfigFile(environment: Environment, build: Build, filterGithubRepositoryId?: number) {
    // Write the deployables here for now and not going to use them yet.
    try {
      const buildId = build?.id;
      await this.db.services.Deployable.upsertDeployables(
        buildId,
        build.uuid,
        build.pullRequest,
        environment,
        build,
        filterGithubRepositoryId
      );

      await this.db.services.Webhook.upsertWebhooksWithYaml(build, build.pullRequest);
    } catch (error) {
      if (error instanceof ParsingError) {
        getLogger().error({ error }, 'Config: parsing failed');

        throw error;
      } else if (error instanceof ValidationError) {
        getLogger().error({ error }, 'Config: validation failed');

        throw error;
      } else {
        getLogger().warn({ error }, 'Config: import warning');
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

      if (build?.uuid) {
        updateLogContext({ buildUuid: build.uuid });
      }

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
            getLogger().debug(
              `Setting up default build services: repositoryId=${options.repositoryId} branch=${options.repositoryBranchName}`
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
      getLogger().fatal({ error }, 'Build: create deploys failed');
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

    if (uuid) {
      updateLogContext({ buildUuid: uuid });
    }
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
      const deploys = await this.db.services.Deploy.findOrCreateDeploys(environment, build, githubRepositoryId);
      build?.$setRelated('deploys', deploys);
      await build?.$fetchGraph('pullRequest');
      await new BuildEnvironmentVariables(this.db).resolve(build, githubRepositoryId);
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
        getLogger().warn({ error }, 'Graph: generation failed');
      }

      // Build Docker Images & Deploy CLI Based Infra At the Same Time
      const results = await Promise.all([
        this.buildImages(build, githubRepositoryId),
        this.deployCLIServices(build, githubRepositoryId),
      ]);
      getLogger().debug(`Build results: buildImages=${results[0]} deployCLIServices=${results[1]}`);
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
        getLogger().warn(
          `Build: errored skipping=rollout fullName=${fullName} branchName=${branchName} latestCommit=${latestCommit}`
        );
        await this.updateStatusAndComment(build, BuildStatus.ERROR, runUUID, true, true);
      }
    } catch (error) {
      getLogger().error({ error }, 'Build: deploy failed');
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
    getLogger().info(`Build: created branch=${options.repositoryBranchName}`);
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
      getLogger().error('Build: id missing for=createBuildServiceOverride');
    }
    const serviceId = service?.id;
    if (!serviceId) {
      getLogger().error('Service: id missing for=createBuildServiceOverride');
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

        if (build?.uuid) {
          updateLogContext({ buildUuid: build.uuid });
        }

        getLogger().debug('Build: triggering cleanup');

        await this.updateStatusAndComment(build, BuildStatus.TEARING_DOWN, build.runUUID, true, true).catch((error) => {
          getLogger().warn({ error }, `Build: status update failed status=${BuildStatus.TEARING_DOWN}`);
        });
        await Promise.all([k8s.deleteBuild(build), cli.deleteBuild(build), uninstallHelmReleases(build)]).catch(
          (error) => getLogger().error({ error }, 'Build: cleanup failed')
        );

        await Promise.all(
          build.deploys.map(async (deploy) => {
            await deploy.$query().patch({ status: DeployStatus.TORN_DOWN });
            if (build.githubDeployments)
              await this.db.services.GithubService.githubDeploymentQueue.add('deployment', {
                deployId: deploy.id,
                action: 'delete',
                ...extractContextForQueue(),
              });
          })
        );

        await k8s.deleteNamespace(build.namespace);
        await this.db.services.Ingress.ingressCleanupQueue.add('cleanup', {
          buildId: build.id,
          ...extractContextForQueue(),
        });
        getLogger().info('Build: deleted');
        await this.updateStatusAndComment(build, BuildStatus.TORN_DOWN, build.runUUID, true, true).catch((error) => {
          getLogger().warn({ error }, `Build: status update failed status=${BuildStatus.TORN_DOWN}`);
        });
      } catch (e) {
        getLogger().error({ error: e instanceof LifecycleError ? e.getMessage() : e }, 'Build: delete failed');
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
    return withLogContext({ buildUuid: build.uuid }, async () => {
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
              getLogger().error({ error: err }, 'Fastly: dashboard URL fetch failed');
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
            getLogger().error({ error: e }, 'ActivityStream: update failed');
          });
        }
      } finally {
        getLogger().debug(`Build status changed: status=${build.status}`);

        await this.db.services.Webhook.webhookQueue.add('webhook', { buildId: build.id, ...extractContextForQueue() });
      }
    });
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
      getLogger().info(`Build: config deploys marked built uuids=${configUUIDs}`);
    } catch (error) {
      getLogger().error({ error }, 'Config: deploy update failed');
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
      getLogger().error('Build: id missing for=deployCLIServices');
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
                  getLogger().debug(`Deploy is undefined in deployCLIServices: deploysLength=${deploys.length}`);
                  return false;
                }
                try {
                  const result = await this.db.services.Deploy.deployCLI(deploy);
                  return result;
                } catch (err) {
                  getLogger().error({ error: err }, `CLI: deploy failed uuid=${deploy?.uuid}`);
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
                  getLogger().debug(`Deploy is undefined in deployCLIServices: deploysLength=${deploys.length}`);
                }
                const result = await this.db.services.Deploy.deployCLI(deploy).catch((error) => {
                  getLogger().error({ error }, 'CLI: deploy failed');
                  return false;
                });

                if (!result) getLogger().info(`CLI: deploy failed uuid=${deploy.uuid}`);
                return result;
              })
          )
        );
      }
    } catch (error) {
      getLogger().error({ error }, 'CLI: build failed');
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
      getLogger().error('Build: id missing for=buildImages');
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
        getLogger().debug(
          `Processing deploys for build: count=${deploysToBuild.length} deployUuids=${deploysToBuild
            .map((d) => d.uuid)
            .join(',')}`
        );

        const results = await Promise.all(
          deploysToBuild.map(async (deploy, index) => {
            if (deploy === undefined) {
              getLogger().debug(`Deploy is undefined in buildImages: deploysLength=${build.deploys.length}`);
            }
            await deploy.$query().patchAndFetch({
              deployPipelineId: null,
              deployOutput: null,
            });
            const result = await this.db.services.Deploy.buildImage(deploy, build.enableFullYaml, index);
            getLogger().debug(`buildImage completed: deployUuid=${deploy.uuid} result=${result}`);
            return result;
          })
        );
        const finalResult = _.every(results);
        getLogger().debug(`Build results: results=${results.join(',')} final=${finalResult}`);
        return finalResult;
      } catch (error) {
        getLogger().error({ error }, 'Docker: build error');
        return false;
      }
    } else {
      try {
        const results = await Promise.all(
          deploys
            .filter((d) => {
              getLogger().debug(
                `Check service type for docker builds: deployUuid=${d.uuid} serviceType=${d.service?.type}`
              );
              return d.active && (d.service.type === DeployTypes.DOCKER || d.service.type === DeployTypes.GITHUB);
            })
            .map(async (deploy, index) => {
              if (deploy === undefined) {
                getLogger().debug(`Deploy is undefined in buildImages: deploysLength=${build.deploys.length}`);
              }
              const result = await this.db.services.Deploy.buildImage(deploy, build.enableFullYaml, index);
              getLogger().debug(`buildImage completed: deployUuid=${deploy.uuid} result=${result}`);
              if (!result) getLogger().info(`Build: image failed deployUuid=${deploy.uuid}`);
              return result;
            })
        );
        return _.every(results);
      } catch (error) {
        getLogger().error({ error }, 'Docker: build error');
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
          // we should ignore Codefresh and Configuration services here since we dont deploy anything
          const managedDeploys = activeDeploys.filter(
            (d) => d.deployable.type !== DeployTypes.CODEFRESH && d.deployable.type !== DeployTypes.CONFIGURATION
          );
          const deploymentManager = new DeploymentManager(managedDeploys);
          await deploymentManager.deploy();
        }

        // Queue ingress creation after all deployments
        await this.db.services.Ingress.ingressManifestQueue.add('manifest', {
          buildId,
          ...extractContextForQueue(),
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
        await this.updateDeploysImageDetails(build, githubRepositoryId);
        return true;
      } catch (e) {
        getLogger().warn({ error: e }, 'K8s: deploy failed');
        throw e;
      }
    } else {
      try {
        const buildId = build?.id;
        if (!buildId) {
          getLogger().error('Build: id missing for=generateAndApplyManifests');
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
          ...extractContextForQueue(),
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
          await this.updateDeploysImageDetails(build, githubRepositoryId);
        }

        return true;
      } catch (e) {
        getLogger().warn({ error: e }, 'K8s: deploy failed');
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

  private async updateDeploysImageDetails(build: Build, githubRepositoryId?: number) {
    await build?.$fetchGraph('deploys');
    const deploys = githubRepositoryId
      ? build.deploys.filter((d) => d.githubRepositoryId === githubRepositoryId)
      : build.deploys;
    await Promise.all(
      deploys.map((deploy) => deploy.$query().patch({ isRunningLatest: true, runningImage: deploy?.dockerImage }))
    );
    getLogger().debug('Deploy: updated running image and status');
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
    const { buildId, buildUuid, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, buildUuid, sender, _ddTraceContext }, async () => {
      try {
        const build = await this.db.models.Build.query().findOne({
          id: buildId,
        });

        if (build?.uuid) {
          updateLogContext({ buildUuid: build.uuid });
        }

        getLogger({ stage: LogStage.CLEANUP_STARTING }).info('Build: deleting');
        await this.db.services.BuildService.deleteBuild(build);
        getLogger({ stage: LogStage.CLEANUP_COMPLETE }).info('Build: deleted');
      } catch (error) {
        getLogger({ stage: LogStage.CLEANUP_FAILED }).error(
          { error },
          `Queue: delete processing failed buildId=${buildId}`
        );
      }
    });
  };

  /**
   * Kicks off the process of actually deploying a build to the kubernetes cluster
   * @param job the BullMQ job with the buildID
   */
  processBuildQueue = async (job) => {
    const { buildId, githubRepositoryId, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, sender, _ddTraceContext }, async () => {
      let build;
      try {
        build = await this.db.models.Build.query().findOne({
          id: buildId,
        });

        if (build?.uuid) {
          updateLogContext({ buildUuid: build.uuid });
        }

        getLogger({ stage: LogStage.BUILD_STARTING }).info('Build: started');

        await build?.$fetchGraph('[pullRequest, environment]');
        await build.pullRequest.$fetchGraph('[repository]');

        await this.importYamlConfigFile(build?.environment, build, githubRepositoryId);

        await this.db.services.BuildService.resolveAndDeployBuild(
          build,
          build?.pullRequest?.deployOnUpdate,
          githubRepositoryId
        );

        getLogger({ stage: LogStage.BUILD_COMPLETE }).info('Build: completed');
      } catch (error) {
        if (error instanceof ParsingError || error instanceof ValidationError) {
          this.updateStatusAndComment(build, BuildStatus.CONFIG_ERROR, build?.runUUID, true, true, error);
        } else {
          getLogger({ stage: LogStage.BUILD_FAILED }).fatal({ error }, 'Build: uncaught exception');
        }
      }
    });
  };

  /**
   * Initial step in routing a build into the build queue. A job will either get enqueue in the build queue
   * after this job
   * @param job the Bull job with the buildID
   * @param done the Bull callback to invoke when we're done
   */
  processResolveAndDeployBuildQueue = async (job) => {
    const { sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, sender, _ddTraceContext }, async () => {
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

        if (build?.uuid) {
          updateLogContext({ buildUuid: build.uuid });
        }

        getLogger({ stage: LogStage.BUILD_QUEUED }).info('Build: processing');

        if (!build.pullRequest.deployOnUpdate) {
          getLogger().info('Deploy: skipping reason=deployOnUpdateDisabled');
          return;
        }
        // Enqueue a standard resolve build
        await this.db.services.BuildService.buildQueue.add('build', {
          buildId,
          githubRepositoryId,
          ...extractContextForQueue(),
        });
      } catch (error) {
        getLogger().error({ error }, `Queue: processing failed buildId=${buildId} jobId=${jobId}`);
      }
    });
  };
}
