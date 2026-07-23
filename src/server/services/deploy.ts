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
import { Environment, Build, Deploy, Deployable } from 'server/models';
import * as codefresh from 'server/lib/codefresh';
import { getLogger, withLogContext, extractContextForQueue } from 'server/lib/logger';
import hash from 'object-hash';
import { BuildKind, DeployStatus, DeployTypes } from 'shared/constants';
import * as cli from 'server/lib/cli';
import RDS from 'aws-sdk/clients/rds';
import resourceGroupsTagging from 'aws-sdk/clients/resourcegroupstaggingapi';
import { merge } from 'lodash';
import { nanoid } from 'nanoid';
import Objection from 'objection';
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
import { parseSecretRefsFromEnv } from 'server/lib/secretRefs';
import { SecretProcessor } from 'server/services/secretProcessor';
import { fallbackDeployStatusMessage, statusMessageFromError } from 'server/lib/terminalFailure';
import { isNativeBuilderEngine } from 'server/lib/buildEngines';
import { SecretProvidersConfig } from 'server/services/types/globalConfig';
import { createOrUpdateNamespace } from 'server/lib/kubernetes';

export interface DeployOptions {
  ownerId?: number;
  repositoryId?: number;
  installationId?: number;
  repositoryBranchName?: string;
  isDeploy?: boolean;
  pullRequestId?: number;
  environmentId?: number;
  lifecycleConfig?: LifecycleYamlConfigOptions;
}

export interface PipelineWaitItem {
  dependentDeploy: Deploy;
  pipelineId: string;
  serviceName: string;
  patternInfo: PatternInfo[];
}

interface SyncedServiceExternalSecrets {
  secretNames: string[];
  buildSecretEnvKeys: Set<string>;
}

export default class DeployService extends BaseService {
  /**
   * Creates all of the relevant deploys for a build, based on the provided environment, if they do not already exist.
   * @param environment the environment to use as a the template for these deploys
   * @param build the build these deploys will be associated with
   * @param githubRepositoryId optional filter to only update SHA for deploys from this repo
   */
  async findOrCreateDeploys(
    _environment: Environment,
    build: Build,
    githubRepositoryId?: number,
    sourceRef?: string | null,
    sourceBranch?: string | null
  ): Promise<Deploy[]> {
    await build?.$fetchGraph('[deployables.[repository]]');

    const { deployables } = build;

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
        const deployableRepositoryId = Number(deployable.repositoryId);
        const effectiveBranch = deployable.commentBranchName ?? deployable.branchName;
        const isTargetSource =
          !githubRepositoryId ||
          (deployableRepositoryId === githubRepositoryId && (!sourceBranch || effectiveBranch === sourceBranch));

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
          // A missing row is always backfilled below, but existing off-target rows stay untouched.
          if (!isTargetSource) return;
          patchFields.deployableId = deployable?.id ?? null;
          patchFields.publicUrl = this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable);
          patchFields.internalHostname = uuid;
          patchFields.uuid = uuid;
          patchFields.branchName = effectiveBranch;
          patchFields.tag = deployable.defaultTag;
        } else {
          deploy = await this.db.models.Deploy.create({
            buildId,
            deployableId: deployable?.id ?? null,
            uuid,
            internalHostname: uuid,
            githubRepositoryId: deployableRepositoryId,
            active: deployable.active,
          });

          patchFields.branchName = effectiveBranch;
          patchFields.tag = deployable.defaultTag;
          patchFields.publicUrl = this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable);

          deploy.$setRelated('deployable', deployable);
          deploy.$setRelated('build', build);
        }

        if (isTargetSource && [DeployTypes.HELM, DeployTypes.GITHUB, DeployTypes.CODEFRESH].includes(deployable.type)) {
          try {
            const sha =
              this.getApiBuildSourceRef(
                build,
                deployableRepositoryId,
                effectiveBranch,
                sourceRef,
                githubRepositoryId,
                sourceBranch
              ) ?? (await getShaForDeploy(deploy));
            patchFields.sha = sha;
          } catch (error) {
            getLogger().debug({ error }, 'Deploy: SHA fetch failed continuing=true');
          }
        }

        await deploy.$query().patch(patchFields);
      })
    ).catch((error) => {
      getLogger().error({ error }, 'Deploy: create from deployables failed');
    });
    getLogger().info('Deploy: initialized');

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
    return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () => {
      let runUUID = deploy.runUUID;
      try {
        await deploy.reload();
        await deploy.$fetchGraph('[build, deployable]');
        runUUID = deploy.runUUID;

        if (!deploy.deployable) {
          getLogger().error('Aurora: deployable missing for=restore');
          throw new Error('Aurora restore deployable is missing.');
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
        runUUID = nanoid();
        await deploy.$query().patch({
          status: DeployStatus.BUILDING,
          buildLogs: uuid,
          runUUID,
        });
        deploy.runUUID = runUUID;
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
        return this.recordDeployFailure(deploy, runUUID || deploy.runUUID, {
          status: DeployStatus.ERROR,
          error: e,
          fallbackMessage: 'Aurora restore failed.',
        });
      }
    });
  }

  async deployCodefresh(
    deploy: Deploy,
    sourceRef?: string | null,
    sourceGithubRepositoryId?: number | null,
    sourceBranch?: string | null
  ): Promise<boolean> {
    return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () => {
      let result: boolean = false;

      const runUUID = nanoid();
      await deploy.$query().patch({
        runUUID,
      });
      deploy.runUUID = runUUID;

      await deploy.reload();
      await deploy.$fetchGraph('[deployable.[repository], build]');
      const { build, deployable } = deploy;
      const source = deployable;
      const repo = source?.repository?.fullName;

      try {
        const fullSha = await this.resolveSourceSha(
          deploy,
          repo,
          deploy.branchName,
          sourceRef,
          sourceGithubRepositoryId,
          sourceBranch
        );
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

            const pinnedSourceRef = this.getApiBuildSourceRef(
              build,
              deploy.githubRepositoryId,
              deploy.branchName,
              sourceRef,
              sourceGithubRepositoryId,
              sourceBranch
            );
            codefreshBuildId = await cli.codefreshDeploy(deploy, build, deployable, pinnedSourceRef).catch((error) => {
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
      } catch (error) {
        return this.recordDeployFailure(deploy, runUUID, {
          status: DeployStatus.BUILD_FAILED,
          error,
          fallbackMessage: 'CI build failed.',
        });
      }

      return result;
    });
  }

  async deployCLI(
    deploy: Deploy,
    sourceRef?: string | null,
    sourceGithubRepositoryId?: number | null,
    sourceBranch?: string | null
  ): Promise<boolean> {
    if (deploy.deployable != null) {
      if (deploy.deployable.type === DeployTypes.AURORA_RESTORE) {
        return this.deployAurora(deploy);
      } else if (deploy.deployable.type === DeployTypes.CODEFRESH) {
        return this.deployCodefresh(deploy, sourceRef, sourceGithubRepositoryId, sourceBranch);
      }
    }
  }

  /**
   * Builds an image for a given deploy
   * @param deploy the deploy to build an image for
   */
  async buildImage(
    deploy: Deploy,
    _index: number,
    sourceRef?: string | null,
    sourceGithubRepositoryId?: number | null,
    sourceBranch?: string | null
  ): Promise<boolean> {
    return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () => {
      const runUUID = deploy.runUUID ?? nanoid();
      try {
        await deploy.$query().patch({
          runUUID,
        });
        deploy.runUUID = runUUID;

        await deploy.$fetchGraph('[build.[environment], deployable]');
        const { deployable } = deploy;

        switch (deployable.type) {
          case DeployTypes.GITHUB:
            return await this.buildImageForHelmAndGithub(
              deploy,
              runUUID,
              sourceRef,
              sourceGithubRepositoryId,
              sourceBranch
            );
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
                return await this.buildImageForHelmAndGithub(
                  deploy,
                  runUUID,
                  sourceRef,
                  sourceGithubRepositoryId,
                  sourceBranch
                );
              }

              let fullSha = null;

              await deploy.$fetchGraph('deployable.repository');
              if (deploy.deployable?.repository) {
                try {
                  fullSha = await this.resolveSourceSha(
                    deploy,
                    deploy.deployable.repository.fullName,
                    deploy.branchName,
                    sourceRef,
                    sourceGithubRepositoryId,
                    sourceBranch
                  );
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
      } catch (e) {
        getLogger().error({ error: e }, 'Docker: build error');
        return this.recordDeployFailure(deploy, runUUID, {
          status: DeployStatus.BUILD_FAILED,
          error: e,
          fallbackMessage: 'Build failed unexpectedly. Check build logs for details.',
        });
      }
    });
  }

  async recordDeployFailure(
    deploy: Deploy,
    runUUID: string | null | undefined,
    {
      status,
      error,
      fallbackMessage,
    }: {
      status: DeployStatus;
      error?: unknown;
      fallbackMessage: string;
    }
  ): Promise<false> {
    const activeRunUUID = runUUID || deploy.runUUID || nanoid();

    if (deploy.runUUID !== activeRunUUID) {
      await deploy.$query().patch({ runUUID: activeRunUUID });
      deploy.runUUID = activeRunUUID;
    }

    await this.patchAndUpdateActivityFeed(
      deploy,
      {
        status,
        statusMessage: statusMessageFromError(error, fallbackMessage),
      },
      activeRunUUID
    );

    return false;
  }

  private getApiBuildSourceRef(
    build: Build | null | undefined,
    deployGithubRepositoryId: number | null | undefined,
    deployBranchName: string | null | undefined,
    sourceRef?: string | null,
    sourceGithubRepositoryId?: number | null,
    sourceBranch?: string | null
  ): string | null {
    if (
      build?.triggerType === 'api' &&
      sourceRef &&
      sourceGithubRepositoryId != null &&
      deployGithubRepositoryId != null &&
      Number(sourceGithubRepositoryId) === Number(deployGithubRepositoryId) &&
      sourceBranch != null &&
      deployBranchName === sourceBranch
    ) {
      return sourceRef;
    }
    if (
      build?.triggerType !== 'api' ||
      build.githubRepositoryId == null ||
      deployGithubRepositoryId == null ||
      Number(build.githubRepositoryId) !== Number(deployGithubRepositoryId) ||
      build.branchName == null ||
      deployBranchName !== build.branchName
    ) {
      return null;
    }
    const sourceTargetsRoot =
      sourceRef == null ||
      (sourceGithubRepositoryId != null &&
        Number(sourceGithubRepositoryId) === Number(build.githubRepositoryId) &&
        sourceBranch === build.branchName);
    return (sourceTargetsRoot ? sourceRef : null) ?? build.configSha ?? null;
  }

  private async resolveSourceSha(
    deploy: Deploy,
    repo: string | null | undefined,
    branchName: string | null,
    sourceRef?: string | null,
    sourceGithubRepositoryId?: number | null,
    sourceBranch?: string | null
  ): Promise<string> {
    const pinned = this.getApiBuildSourceRef(
      deploy.build,
      deploy.githubRepositoryId,
      deploy.branchName,
      sourceRef,
      sourceGithubRepositoryId,
      sourceBranch
    );
    if (pinned) return pinned;

    const [owner, name] = repo?.split('/') || [];

    if (!owner || !name || !branchName) {
      throw this.sourceResolutionFailure(repo, branchName);
    }

    try {
      const fullSha = await github.getSHAForBranch(branchName, owner, name);
      if (fullSha) return fullSha;
    } catch (error) {
      getLogger().warn({ error, repo, branch: branchName }, 'Git: source resolution failed');
    }

    throw this.sourceResolutionFailure(repo, branchName);
  }

  private sourceResolutionFailure(repo?: string | null, branchName?: string | null): Error {
    const repositoryLabel = repo || 'the selected repository';
    const branchLabel = branchName || 'the selected branch';
    return new Error(
      `Unable to resolve branch "${branchLabel}" in repository "${repositoryLabel}". Verify the branch exists and the repository matches the selected service.`
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
      const failureStatuses = [DeployStatus.ERROR, DeployStatus.BUILD_FAILED, DeployStatus.DEPLOY_FAILED];
      const status = params.status as DeployStatus;
      const fallbackStatusMessage =
        !params.statusMessage && failureStatuses.includes(status) ? fallbackDeployStatusMessage(status) : '';
      const patchParams = fallbackStatusMessage ? { ...params, statusMessage: fallbackStatusMessage } : params;

      await this.db.models.Deploy.query().where({ id, runUUID }).patch(patchParams);
      if (deploy.runUUID !== runUUID) {
        getLogger().debug(`runUUID mismatch: deployRunUUID=${deploy.runUUID} providedRunUUID=${runUUID}`);
        return;
      }

      await deploy.$fetchGraph('build.pullRequest');
      build = deploy?.build;
      const pullRequest = build?.pullRequest;
      const isSandboxBuild = build?.kind === BuildKind.SANDBOX;

      const terminalStatuses = [
        DeployStatus.READY,
        DeployStatus.DEPLOYED,
        DeployStatus.ERROR,
        DeployStatus.BUILD_FAILED,
        DeployStatus.DEPLOY_FAILED,
        DeployStatus.TORN_DOWN,
      ];
      const isTerminalStatus = terminalStatuses.includes(status);

      if (isTerminalStatus && build?.githubDeployments && !isSandboxBuild) {
        await deploy.$fetchGraph('[deployable]');
        if (await this.shouldTriggerGithubDeployment(deploy)) {
          await this.triggerGithubDeploymentUpdate(deploy);
        }
      }

      if (!isSandboxBuild && pullRequest) {
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
      }
    } catch (error) {
      getLogger().warn({ error }, 'ActivityFeed: update failed');
    }
  }

  private async shouldTriggerGithubDeployment(deploy: Deploy): Promise<boolean> {
    if (!deploy?.active) {
      getLogger().debug(`GitHub deployment skipped: deployId=${deploy.id} reason=inactive`);
      return false;
    }

    const { deployable } = deploy;
    const serviceType = deployable?.type;
    const validTypes: string[] = [DeployTypes.DOCKER, DeployTypes.GITHUB, DeployTypes.CODEFRESH, DeployTypes.HELM];

    if (!serviceType || !validTypes.includes(serviceType)) {
      getLogger().debug(`GitHub deployment skipped: deployId=${deploy.id} reason=type type=${serviceType}`);
      return false;
    }

    const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();
    const isOrgHelmChart = orgChartName === deployable?.helm?.chart?.name;
    const isPublicChart = serviceType === DeployTypes.HELM && (await determineChartType(deploy)) === ChartType.PUBLIC;
    const isPublic = deployable?.public || isOrgHelmChart || isPublicChart;

    if (!isPublic) {
      getLogger().debug(`GitHub deployment skipped: deployId=${deploy.id} reason=private`);
      return false;
    }

    return true;
  }

  private async triggerGithubDeploymentUpdate(deploy: Deploy) {
    await this.db.services.GithubService.githubDeploymentQueue
      .add('deployment', { deployId: deploy.id, action: 'create', ...extractContextForQueue() })
      .catch((error) =>
        getLogger().warn(`GitHub deployment queue failed: deployId=${deploy.id} error=${error.message}`)
      );
  }

  private async patchDeployWithTag({ tag, deploy, initTag, ecrDomain }) {
    await deploy.$fetchGraph('[build, deployable]');
    const { deployable } = deploy;
    let ecrRepo = deployable?.ecr as string;

    const serviceName = deployable?.name;
    ecrRepo = constructEcrRepoPath(deployable?.ecr as string, serviceName, ecrDomain);

    const dockerImage = codefresh.getRepositoryTag({ tag, ecrRepo, ecrDomain });

    if (deployable?.initDockerfilePath) {
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

  private async syncServiceExternalSecrets({
    deploy,
    serviceName,
    secretProviders,
    runUUID,
  }: {
    deploy: Deploy;
    serviceName: string;
    secretProviders: SecretProvidersConfig | undefined;
    runUUID: string;
  }): Promise<SyncedServiceExternalSecrets | false> {
    const emptyResult = { secretNames: [], buildSecretEnvKeys: new Set<string>() };

    if (!secretProviders) {
      return emptyResult;
    }

    const buildEnvToProcess = merge({}, deploy.env || {}, deploy.build?.commentRuntimeEnv || {}) as Record<
      string,
      string
    >;
    const initEnvToProcess = merge({}, deploy.initEnv || {}, deploy.build?.commentInitEnv || {}) as Record<
      string,
      string
    >;
    const buildSecretRefs = parseSecretRefsFromEnv(buildEnvToProcess);
    const initSecretRefs = parseSecretRefsFromEnv(initEnvToProcess);
    const buildSecretRefKeys = new Set(buildSecretRefs.map((ref) => ref.envKey));
    const combinedSecretEnvEntries = new Map<string, string>();
    const conflictingSecretEnvKeys = new Set<string>();

    const addSecretRef = (envKey: string, value: string) => {
      const existingValue = combinedSecretEnvEntries.get(envKey);

      if (existingValue && existingValue !== value) {
        conflictingSecretEnvKeys.add(envKey);
        return;
      }

      combinedSecretEnvEntries.set(envKey, value);
    };

    buildSecretRefs.forEach((ref) => addSecretRef(ref.envKey, buildEnvToProcess[ref.envKey]));
    initSecretRefs.forEach((ref) => addSecretRef(ref.envKey, initEnvToProcess[ref.envKey]));

    if (conflictingSecretEnvKeys.size > 0) {
      getLogger().error(
        `Build: secret env conflict service=${serviceName} keys=[${Array.from(conflictingSecretEnvKeys).join(', ')}]`
      );
      await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILD_FAILED }, runUUID);
      return false;
    }

    const envToProcess = Object.fromEntries(combinedSecretEnvEntries);

    if (Object.keys(envToProcess).length === 0) {
      return emptyResult;
    }

    await deploy.$fetchGraph('[build.[pullRequest]]');

    await createOrUpdateNamespace({
      name: deploy.build.namespace,
      buildUUID: deploy.build.uuid,
      staticEnv: deploy.build.isStatic,
      pullRequest: deploy.build.pullRequest,
      waitForReady: true,
    });

    const secretProcessor = new SecretProcessor(secretProviders);

    const secretResult = await secretProcessor.processEnvSecrets({
      env: envToProcess,
      serviceName,
      namespace: deploy.build.namespace,
      buildUuid: deploy.uuid,
    });

    const buildSecretEnvKeys = new Set(
      secretResult.secretRefs.filter((ref) => buildSecretRefKeys.has(ref.envKey)).map((ref) => ref.envKey)
    );

    if (secretResult.warnings.length > 0) {
      getLogger().warn(
        `Build: secret processing warnings service=${serviceName} warnings=${secretResult.warnings.join(', ')}`
      );
    }

    const secretNames = Object.keys(secretResult.expectedKeysPerSecret);

    if (secretNames.length === 0) {
      return { secretNames, buildSecretEnvKeys };
    }

    getLogger().info(`Build: waiting for secrets to sync secrets=[${secretNames.join(', ')}]`);

    const providerTimeouts = Object.values(secretProviders)
      .map((p) => p.secretSyncTimeout)
      .filter((t): t is number => t !== undefined);
    const timeout = providerTimeouts.length > 0 ? Math.max(...providerTimeouts) * 1000 : 60000;

    try {
      await secretProcessor.waitForSecretSync(
        secretResult.expectedKeysPerSecret,
        deploy.build.namespace,
        timeout,
        secretResult.syncTokensPerSecret
      );
      getLogger().info(`Build: secrets synced count=${secretNames.length}`);
      return { secretNames, buildSecretEnvKeys };
    } catch (error) {
      getLogger().error({ error }, `Build: secret sync failed service=${serviceName}`);
      await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILD_FAILED }, runUUID);
      return false;
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

  acmARNForDeploy(deploy: Deploy): string {
    return deploy?.deployable?.acmARN ?? null;
  }

  async buildImageForHelmAndGithub(
    deploy: Deploy,
    runUUID: string,
    sourceRef?: string | null,
    sourceGithubRepositoryId?: number | null,
    sourceBranch?: string | null
  ) {
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
        throw this.sourceResolutionFailure(null, deploy.branchName);
      }

      const repo = repository?.fullName;
      const fullSha = await this.resolveSourceSha(
        deploy,
        repo,
        deploy.branchName,
        sourceRef,
        sourceGithubRepositoryId,
        sourceBranch
      );

      const repositoryName: string = deployable.repository.fullName;
      const branchName: string = deploy.branchName;
      const dockerfilePath: string = deployable.dockerfilePath;
      const initDockerfilePath: string = deployable.initDockerfilePath;

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

      const { lifecycleDefaults, app_setup, buildDefaults, secretProviders } =
        await GlobalConfigService.getInstance().getAllConfigs();
      const { ecrDomain, ecrRegistry: registry } = lifecycleDefaults;

      const serviceName = deployable?.name;
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

        if (isNativeBuilderEngine(deployable.builder?.engine)) {
          getLogger().info(`Image: building engine=${deployable.builder.engine}`);

          const syncedExternalSecrets = await this.syncServiceExternalSecrets({
            deploy,
            serviceName: deployable.name,
            secretProviders,
            runUUID,
          });

          if (!syncedExternalSecrets) {
            return false;
          }

          const filteredEnvVars =
            syncedExternalSecrets.buildSecretEnvKeys.size > 0
              ? Object.fromEntries(
                  Object.entries(buildOptions.envVars || {}).filter(
                    ([key]) => !syncedExternalSecrets.buildSecretEnvKeys.has(key)
                  )
                )
              : buildOptions.envVars;

          const nativeOptions = {
            ...buildOptions,
            envVars: filteredEnvVars,
            namespace: deploy.build.namespace,
            buildId: String(deploy.build.id),
            buildUuid: deploy.build.uuid,
            deployUuid: deploy.uuid,
            cacheRegistry: buildDefaults?.cacheRegistry,
            resources: deployable.builder?.resources,
            podAnnotations: deployable.builder?.podAnnotations,
            secretRefs: syncedExternalSecrets.secretNames,
            secretEnvKeys: Array.from(syncedExternalSecrets.buildSecretEnvKeys),
          };

          if (!initDockerfilePath) {
            nativeOptions.initTag = undefined;
          }

          const result = await buildWithNative(deploy, nativeOptions);

          // Persist build logs so failures stay diagnosable after the build job pod is gone.
          if (result.logs) {
            await deploy.$query().patch({ buildOutput: result.logs.slice(-65536) });
          }

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
        if (isNativeBuilderEngine(deployable.builder?.engine)) {
          const syncedExternalSecrets = await this.syncServiceExternalSecrets({
            deploy,
            serviceName: deployable.name,
            secretProviders,
            runUUID,
          });

          if (!syncedExternalSecrets) {
            return false;
          }
        }
        await this.patchDeployWithTag({ tag, initTag, deploy, ecrDomain });
        await this.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILT }, runUUID);
        return true;
      }
    }
  }

  async waitAndResolveForBuildDependentEnvVars(deploy: Deploy, envVariables: Record<string, string>, runUUID: string) {
    const pipelineIdsToWaitFor: PipelineWaitItem[] = [];
    const { build } = deploy;
    const deploys = build.deploys;
    const servicesToWaitFor = extractEnvVarsWithBuildDependencies(deploy.deployable.env);

    for (const [serviceName, patternsInfo] of Object.entries(servicesToWaitFor)) {
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
            pipelineId: updatedDeploy.buildPipelineId,
            serviceName,
            patternInfo: patternsInfo,
          });
        }
      }
    }

    const extractedValues = {};
    const pipelinePromises = pipelineIdsToWaitFor.map(
      async ({ dependentDeploy, pipelineId, serviceName, patternInfo }: PipelineWaitItem) => {
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
