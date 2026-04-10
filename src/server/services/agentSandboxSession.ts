/**
 * Copyright 2026 GoodRx, Inc.
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
import { customAlphabet, nanoid } from 'nanoid';
import BaseService from './_service';
import BuildService from './build';
import AgentSessionService from './agentSession';
import {
  mergeAgentSessionReadinessForServices,
  mergeAgentSessionResources,
  type ResolvedAgentSessionReadinessConfig,
  type ResolvedAgentSessionResources,
} from 'server/lib/agentSession/runtimeConfig';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import { getLogger } from 'server/lib/logger';
import { Build, Deploy, Deployable } from 'server/models';
import { fetchLifecycleConfig, getDeployingServicesByName, type LifecycleConfig } from 'server/models/yaml';
import {
  hasLifecycleManagedDockerBuild,
  type DependencyService,
  type DevConfig,
  type Service as LifecycleService,
} from 'server/models/yaml/YamlService';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import DeployService from './deploy';
import type { SandboxLaunchStage } from 'server/lib/agentSession/sandboxLaunchState';
import type { RequestUserIdentity } from 'server/lib/get-user';
import type { RequestedAgentSessionServiceRef } from './agentSessionCandidates';

const randomSha = customAlphabet('1234567890abcdef', 6);

export interface SandboxServiceCandidate {
  name: string;
  type: DeployTypes;
  repo: string;
  branch: string;
}

interface ResolvedSandboxService {
  name: string;
  devConfig: DevConfig;
  baseDeploy: Deploy;
  serviceRepo: string;
  serviceBranch: string;
  yamlService: LifecycleService;
}

interface EnvironmentSource {
  repo: string;
  branch: string;
}

interface CreatedSandboxBuild {
  build: Build;
  sandboxDeploysByBaseDeployId: Map<number, Deploy>;
}

export type RequestedSandboxService = string | RequestedAgentSessionServiceRef;
export type RequestedSandboxServices = RequestedSandboxService[];

function normalizeOptionalString(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRepoKey(value: string): string {
  return value.trim().toLowerCase();
}

export function formatRequestedSandboxServiceLabel(service?: RequestedSandboxService | null): string {
  if (!service) {
    return 'unknown service';
  }

  if (typeof service === 'string') {
    return service;
  }

  const repo = normalizeOptionalString(service.repo);
  const branch = normalizeOptionalString(service.branch);

  if (!repo && !branch) {
    return service.name;
  }

  return `${service.name} (${repo ?? 'unknown-repo'}${branch ? `:${branch}` : ''})`;
}

export function summarizeRequestedSandboxServices(services?: RequestedSandboxServices | null): string {
  if (!services || services.length === 0) {
    return 'unknown service';
  }

  if (services.length === 1) {
    return typeof services[0] === 'string' ? services[0] : services[0].name;
  }

  return `${services.length} services`;
}

export function formatRequestedSandboxServicesLabel(services?: RequestedSandboxServices | null): string {
  if (!services || services.length === 0) {
    return 'unknown service';
  }

  const labels = services.map((service) => formatRequestedSandboxServiceLabel(service));
  if (labels.length <= 2) {
    return labels.join(', ');
  }

  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2} more`;
}

export interface LaunchSandboxSessionOptions {
  userId: string;
  userIdentity?: RequestUserIdentity;
  githubToken?: string | null;
  requestApiKey?: string | null;
  requestApiKeyProvider?: string | null;
  baseBuildUuid: string;
  services?: RequestedSandboxServices;
  model?: string;
  workspaceImage?: string;
  workspaceEditorImage?: string;
  workspaceGatewayImage?: string;
  nodeSelector?: Record<string, string>;
  readiness: ResolvedAgentSessionReadinessConfig;
  resources: ResolvedAgentSessionResources;
  onProgress?: (stage: SandboxLaunchStage, message: string) => Promise<void> | void;
}

export type LaunchSandboxSessionResult =
  | {
      status: 'needs_service_selection';
      services: SandboxServiceCandidate[];
    }
  | {
      status: 'created';
      service: string;
      buildUuid: string;
      namespace: string;
      session: Awaited<ReturnType<typeof AgentSessionService.createSession>>;
      services: string[];
    };

export default class AgentSandboxSessionService extends BaseService {
  private readonly buildService = new BuildService(this.db, this.redis, this.redlock, this.queueManager);
  private readonly deployService = new DeployService(this.db, this.redis, this.redlock, this.queueManager);

  async launch(opts: LaunchSandboxSessionOptions): Promise<LaunchSandboxSessionResult> {
    const { baseBuild, environmentSource, lifecycleConfig, candidates } = await this.loadBaseBuildAndCandidates(opts);
    if (candidates.length === 0) {
      throw new Error(
        `No dev-mode sandboxable services were found in ${environmentSource.repo}:${environmentSource.branch}`
      );
    }

    const selectedServices = opts.services != null ? this.resolveSelectedServices(opts.services, candidates) : [];

    if (selectedServices.length === 0) {
      return {
        status: 'needs_service_selection',
        services: candidates
          .map((candidate) => ({
            name: candidate.name,
            type: getDeployTypeFromBaseDeploy(candidate.baseDeploy),
            repo: candidate.serviceRepo,
            branch: candidate.serviceBranch,
          }))
          .sort((a, b) =>
            a.name === b.name
              ? `${a.repo}:${a.branch}`.localeCompare(`${b.repo}:${b.branch}`)
              : a.name.localeCompare(b.name)
          ),
      };
    }

    const selectedServiceSummary = summarizeRequestedSandboxServices(
      selectedServices.map((service) => ({
        name: service.name,
        repo: service.serviceRepo,
        branch: service.serviceBranch,
      }))
    );

    getLogger().info(
      `Sandbox: starting baseBuildUuid=${opts.baseBuildUuid} services=${selectedServices
        .map((service) => `${service.name}@${service.serviceRepo}:${service.serviceBranch}`)
        .join(',')}`
    );

    await opts.onProgress?.('creating_sandbox_build', `Creating sandbox build for ${selectedServiceSummary}`);
    const { build: sandboxBuild, sandboxDeploysByBaseDeployId } = await this.createSandboxBuild({
      baseBuild,
      environmentSource,
      selectedServices,
    });

    try {
      const runUUID = nanoid();
      await sandboxBuild.$query().patch({ runUUID, status: BuildStatus.QUEUED });
      await sandboxBuild.$fetchGraph('[environment, pullRequest.[repository], deploys.[deployable, repository]]');

      await opts.onProgress?.('resolving_environment', `Resolving environment variables for ${selectedServiceSummary}`);
      await new BuildEnvironmentVariables(this.db).resolve(sandboxBuild);

      await this.buildService.updateStatusAndComment(sandboxBuild, BuildStatus.DEPLOYING, runUUID, false, false);
      await opts.onProgress?.('deploying_resources', `Deploying sandbox resources for ${selectedServiceSummary}`);
      const deployed = await this.buildService.generateAndApplyManifests({
        build: sandboxBuild,
        githubRepositoryId: null,
        namespace: sandboxBuild.namespace,
      });

      await this.buildService.updateStatusAndComment(
        sandboxBuild,
        deployed ? BuildStatus.DEPLOYED : BuildStatus.ERROR,
        runUUID,
        false,
        false
      );

      if (!deployed) {
        throw new Error(`Sandbox deployment failed for ${sandboxBuild.uuid}`);
      }

      const selectedSandboxServices = this.resolveSelectedSandboxDeploys(
        selectedServices,
        sandboxDeploysByBaseDeployId
      );

      await opts.onProgress?.('opening_session', `Opening sandbox for ${selectedServiceSummary}`);
      const session = await AgentSessionService.createSession({
        userId: opts.userId,
        buildUuid: sandboxBuild.uuid,
        buildKind: BuildKind.SANDBOX,
        githubToken: opts.githubToken,
        requestApiKey: opts.requestApiKey,
        requestApiKeyProvider: opts.requestApiKeyProvider,
        services: selectedSandboxServices.map(({ selectedService, sandboxDeploy }) => ({
          name: selectedService.name,
          deployId: sandboxDeploy.id,
          devConfig: selectedService.devConfig,
          resourceName: sandboxDeploy.uuid || undefined,
          repo: selectedService.serviceRepo,
          branch: selectedService.baseDeploy.branchName || selectedService.serviceBranch,
          revision: selectedService.baseDeploy.sha || undefined,
        })),
        model: opts.model,
        environmentSkillRefs: lifecycleConfig.environment?.agentSession?.skills,
        prNumber: baseBuild.pullRequest?.pullRequestNumber,
        namespace: sandboxBuild.namespace,
        workspaceImage: opts.workspaceImage,
        workspaceEditorImage: opts.workspaceEditorImage,
        workspaceGatewayImage: opts.workspaceGatewayImage,
        nodeSelector: opts.nodeSelector,
        readiness: mergeAgentSessionReadinessForServices(
          opts.readiness,
          selectedServices.map((service) => service.devConfig.agentSession?.readiness)
        ),
        resources: mergeAgentSessionResources(opts.resources, lifecycleConfig.environment?.agentSession?.resources),
        userIdentity: opts.userIdentity,
      });

      getLogger().info(
        `Sandbox: ready baseBuildUuid=${opts.baseBuildUuid} buildUuid=${sandboxBuild.uuid} sessionId=${
          session.uuid
        } services=${selectedServices.map((service) => service.name).join(',')}`
      );

      return {
        status: 'created',
        service: selectedServiceSummary,
        buildUuid: sandboxBuild.uuid,
        namespace: sandboxBuild.namespace,
        session,
        services: selectedServices.map((service) => service.name),
      };
    } catch (error) {
      await this.buildService.deleteBuild(sandboxBuild).catch((cleanupError) => {
        getLogger().warn(
          { error: cleanupError, buildUuid: sandboxBuild.uuid },
          `Sandbox: cleanup failed action=launch_rollback buildUuid=${sandboxBuild.uuid}`
        );
      });
      throw error;
    }
  }

  async getServiceCandidates({
    baseBuildUuid,
    onProgress,
  }: Pick<LaunchSandboxSessionOptions, 'baseBuildUuid' | 'onProgress'>) {
    const { candidates } = await this.loadBaseBuildAndCandidates({
      baseBuildUuid,
      onProgress,
    });

    return candidates
      .map((candidate) => ({
        name: candidate.name,
        type: getDeployTypeFromBaseDeploy(candidate.baseDeploy),
        repo: candidate.serviceRepo,
        branch: candidate.serviceBranch,
      }))
      .sort((a, b) =>
        a.name === b.name
          ? `${a.repo}:${a.branch}`.localeCompare(`${b.repo}:${b.branch}`)
          : a.name.localeCompare(b.name)
      );
  }

  private async loadBaseBuildAndCandidates({
    baseBuildUuid,
    onProgress,
  }: Pick<LaunchSandboxSessionOptions, 'baseBuildUuid' | 'onProgress'>) {
    await onProgress?.('resolving_base_build', `Loading base build ${baseBuildUuid}`);
    const baseBuild = await Build.query()
      .findOne({ uuid: baseBuildUuid })
      .withGraphFetched('[environment, pullRequest.[repository], deploys.[deployable, repository]]');

    if (!baseBuild) {
      throw new Error('Base build not found');
    }

    if (baseBuild.kind === BuildKind.SANDBOX) {
      throw new Error('Sandbox builds cannot be used as sandbox bases');
    }

    const environmentSource = this.getEnvironmentSource(baseBuild);
    await onProgress?.(
      'resolving_services',
      `Reading environment config for ${environmentSource.repo} on ${environmentSource.branch}`
    );
    const lifecycleConfig = await fetchLifecycleConfig(environmentSource.repo, environmentSource.branch);
    if (!lifecycleConfig) {
      throw new Error(`Lifecycle config not found for ${environmentSource.repo}:${environmentSource.branch}`);
    }

    return {
      baseBuild,
      environmentSource,
      lifecycleConfig,
      candidates: await this.resolveCandidateServices(baseBuild, lifecycleConfig, environmentSource),
    };
  }

  private async resolveCandidateServices(
    baseBuild: Build,
    lifecycleConfig: LifecycleConfig,
    environmentSource: EnvironmentSource
  ): Promise<ResolvedSandboxService[]> {
    const configCache = new Map<string, Promise<LifecycleConfig>>();
    const activeDeploys = this.getActiveDeploys(baseBuild);
    const resolvedCandidates: ResolvedSandboxService[] = [];

    for (const serviceRef of this.getEnvironmentServiceReferences(lifecycleConfig)) {
      const serviceName = serviceRef.name;
      if (!serviceName) {
        continue;
      }

      const baseDeploy = this.findActiveDeployForReference(activeDeploys, serviceRef);
      if (!baseDeploy) {
        continue;
      }

      try {
        const serviceSource = await this.resolveServiceSource({
          serviceRef,
          baseDeploy,
          fallbackSource: environmentSource,
          configCache,
        });

        if (!serviceSource.yamlService?.dev || !hasLifecycleManagedDockerBuild(serviceSource.yamlService)) {
          continue;
        }

        resolvedCandidates.push({
          name: serviceSource.yamlService.name,
          devConfig: serviceSource.yamlService.dev,
          baseDeploy,
          serviceRepo: serviceSource.repo,
          serviceBranch: serviceSource.branch,
          yamlService: serviceSource.yamlService,
        });
      } catch (error) {
        getLogger({ buildUuid: baseBuild.uuid, serviceName, error }).warn(
          `Sandbox: candidate skipped service=${serviceName} buildUuid=${baseBuild.uuid} reason=config_error`
        );
      }
    }

    return resolvedCandidates;
  }

  private resolveSelectedServices(
    requestedServices: RequestedSandboxServices,
    candidates: ResolvedSandboxService[]
  ): ResolvedSandboxService[] {
    const selectedServices: ResolvedSandboxService[] = [];
    const seenServiceKeys = new Set<string>();

    for (const requestedService of requestedServices) {
      const selectedService = this.resolveSelectedService(requestedService, candidates);
      const serviceKey = this.getResolvedSandboxServiceKey(selectedService);

      if (seenServiceKeys.has(serviceKey)) {
        continue;
      }

      seenServiceKeys.add(serviceKey);
      selectedServices.push(selectedService);
    }

    return selectedServices;
  }

  private resolveSelectedService(
    requestedService: RequestedSandboxService,
    candidates: ResolvedSandboxService[]
  ): ResolvedSandboxService {
    const serviceName = typeof requestedService === 'string' ? requestedService : requestedService.name;
    const requestedRepo =
      typeof requestedService === 'string' ? undefined : normalizeOptionalString(requestedService.repo);
    const requestedBranch =
      typeof requestedService === 'string' ? undefined : normalizeOptionalString(requestedService.branch);

    const matches = candidates.filter((candidate) => {
      if (candidate.name !== serviceName) {
        return false;
      }

      if (requestedRepo && normalizeRepoKey(candidate.serviceRepo) !== normalizeRepoKey(requestedRepo)) {
        return false;
      }

      if (requestedBranch && candidate.serviceBranch !== requestedBranch) {
        return false;
      }

      return true;
    });

    if (matches.length === 0) {
      throw new Error(`Unknown sandbox service: ${formatRequestedSandboxServiceLabel(requestedService)}`);
    }

    if (matches.length > 1) {
      throw new Error(`Multiple sandbox services matched ${formatRequestedSandboxServiceLabel(requestedService)}`);
    }

    return matches[0];
  }

  private async createSandboxBuild({
    baseBuild,
    environmentSource,
    selectedServices,
  }: {
    baseBuild: Build;
    environmentSource: EnvironmentSource;
    selectedServices: ResolvedSandboxService[];
  }): Promise<CreatedSandboxBuild> {
    const includedDeployIds = await this.resolveDependencyClosure(baseBuild, selectedServices, environmentSource);
    const baseDeploys = (baseBuild.deploys || []).filter(
      (deploy) => deploy.active && Boolean(deploy.id) && includedDeployIds.has(deploy.id)
    );

    if (baseDeploys.length !== includedDeployIds.size) {
      const foundDeployIds = new Set(
        baseDeploys.map((deploy) => deploy.id).filter((deployId): deployId is number => Boolean(deployId))
      );
      const missingDeployIds = [...includedDeployIds].filter((deployId) => !foundDeployIds.has(deployId));
      throw new Error(`Base build is missing active deploys for sandbox dependencies: ${missingDeployIds.join(', ')}`);
    }

    const haikunator = new Haikunator({
      defaults: {
        tokenLength: 6,
      },
    });
    const sandboxUuid = haikunator.haikunate();
    const sandboxNamespace = `sbx-${sandboxUuid}`;

    return Build.transaction(async (trx) => {
      const sandboxDeploysByBaseDeployId = new Map<number, Deploy>();
      const baseBuildJson = baseBuild.$toJson() as Record<string, unknown>;
      const {
        id: _baseBuildId,
        uuid: _baseBuildUuid,
        deploys: _deploys,
        services: _services,
        buildServiceOverrides: _buildServiceOverrides,
        pullRequest: _pullRequest,
        environment: _environment,
        deployables: _buildDeployables,
        baseBuild: _parentBuild,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        deletedAt: _deletedAt,
        ...restBuild
      } = baseBuildJson;

      const sandboxBuild = await Build.query(trx).insertAndFetch({
        ...restBuild,
        uuid: sandboxUuid,
        namespace: sandboxNamespace,
        sha: randomSha(),
        kind: BuildKind.SANDBOX,
        baseBuildId: baseBuild.id,
        status: BuildStatus.QUEUED,
        githubDeployments: false,
        isStatic: false,
        dashboardLinks: {},
      } as unknown as Partial<Build>);

      const deployableIdByBaseId = new Map<number, number>();
      for (const baseDeploy of baseDeploys) {
        const baseDeployable = baseDeploy.deployable;
        if (!baseDeployable) {
          throw new Error(`Deployable missing for base deploy ${baseDeploy.uuid}`);
        }

        const baseDeployableJson = baseDeployable.$toJson() as Record<string, unknown>;
        const {
          id: _id,
          buildId: _buildId,
          buildUUID: _buildUUID,
          repository: _repository,
          environment: _deployableEnvironment,
          serviceDisks: _serviceDisks,
          createdAt: _deployableCreatedAt,
          updatedAt: _deployableUpdatedAt,
          deletedAt: _deployableDeletedAt,
          ...restDeployable
        } = baseDeployableJson;

        const sandboxDeployable = await Deployable.query(trx).insertAndFetch({
          ...restDeployable,
          buildId: sandboxBuild.id,
          buildUUID: sandboxBuild.uuid,
          active: true,
          ipWhitelist: toPostgresTextArrayLiteral(restDeployable.ipWhitelist),
        } as Partial<Deployable>);

        deployableIdByBaseId.set(baseDeployable.id, sandboxDeployable.id);
      }

      for (const baseDeploy of baseDeploys) {
        const baseDeployable = baseDeploy.deployable;
        if (!baseDeployable) {
          throw new Error(`Deployable missing for base deploy ${baseDeploy.uuid}`);
        }

        const sandboxDeployableId = deployableIdByBaseId.get(baseDeployable.id);
        if (!sandboxDeployableId) {
          throw new Error(`Cloned deployable not found for ${baseDeployable.name}`);
        }

        const deployJson = baseDeploy.$toJson() as Record<string, unknown>;
        const {
          id: _deployId,
          buildId: _deployBuildId,
          deployableId: _deployableId,
          service: _service,
          build: _deployBuild,
          deployable: _deployDeployable,
          repository: _deployRepository,
          agentSession: _agentSession,
          createdAt: _deployCreatedAt,
          updatedAt: _deployUpdatedAt,
          deletedAt: _deployDeletedAt,
          ...restDeploy
        } = deployJson;

        const sandboxDeploy = await Deploy.query(trx).insertAndFetch({
          ...restDeploy,
          buildId: sandboxBuild.id,
          deployableId: sandboxDeployableId,
          uuid: `${baseDeployable.name}-${sandboxBuild.uuid}`,
          internalHostname: `${baseDeployable.name}-${sandboxBuild.uuid}`,
          active: true,
          status: DeployStatus.PENDING,
          statusMessage: '',
          buildLogs: '',
          containerLogs: '',
          manifest: '',
          buildPipelineId: '',
          buildOutput: '',
          buildJobName: '',
          deployPipelineId: '',
          deployOutput: '',
          devMode: false,
          devModeSessionId: null,
        } as unknown as Partial<Deploy>);
        sandboxDeploysByBaseDeployId.set(baseDeploy.id, sandboxDeploy);

        const sandboxDeployable = await Deployable.query(trx).findById(sandboxDeployableId);
        if (!sandboxDeployable) {
          throw new Error(`Sandbox deployable disappeared for ${baseDeployable.name}`);
        }

        await sandboxDeploy.$query(trx).patch({
          publicUrl: this.deployService.hostForDeployableDeploy(sandboxDeploy, sandboxDeployable),
        });
      }

      for (const baseDeploy of baseDeploys) {
        const baseDeployable = baseDeploy.deployable;
        if (!baseDeployable || !baseDeployable.dependsOnDeployableId) {
          continue;
        }

        const sandboxDeployableId = deployableIdByBaseId.get(baseDeployable.id);
        const sandboxDependsOnId = deployableIdByBaseId.get(baseDeployable.dependsOnDeployableId);
        if (!sandboxDeployableId || !sandboxDependsOnId) {
          continue;
        }

        await Deployable.query(trx).findById(sandboxDeployableId).patch({
          dependsOnDeployableId: sandboxDependsOnId,
        });
      }

      await sandboxBuild.$fetchGraph('[pullRequest.[repository], environment, deploys.[deployable, repository]]');
      return {
        build: sandboxBuild,
        sandboxDeploysByBaseDeployId,
      };
    });
  }

  private resolveSelectedSandboxDeploys(
    selectedServices: ResolvedSandboxService[],
    sandboxDeploysByBaseDeployId: Map<number, Deploy>
  ): Array<{
    selectedService: ResolvedSandboxService;
    sandboxDeploy: Deploy;
  }> {
    return selectedServices.map((selectedService) => {
      const baseDeployId = selectedService.baseDeploy.id;
      const sandboxDeploy = baseDeployId ? sandboxDeploysByBaseDeployId.get(baseDeployId) : undefined;

      if (!sandboxDeploy?.id) {
        throw new Error(`Sandbox deploy not found for ${selectedService.name} in ${selectedService.serviceRepo}`);
      }

      return {
        selectedService,
        sandboxDeploy,
      };
    });
  }

  private async resolveDependencyClosure(
    baseBuild: Build,
    selectedServices: ResolvedSandboxService[],
    environmentSource: EnvironmentSource
  ): Promise<Set<number>> {
    const activeDeploys = this.getActiveDeploys(baseBuild);
    const configCache = new Map<string, Promise<LifecycleConfig>>();
    const includedDeployIds = new Set<number>();
    const queue: Array<{
      serviceRef: DependencyService;
      baseDeploy: Deploy;
      resolvedSource?: ResolvedLifecycleServiceSource;
    }> = selectedServices.map((selectedService) => ({
      serviceRef: {
        name: selectedService.name,
        repository: selectedService.serviceRepo,
        branch: selectedService.serviceBranch,
      },
      baseDeploy: selectedService.baseDeploy,
      resolvedSource: {
        repo: selectedService.serviceRepo,
        branch: selectedService.serviceBranch,
        yamlService: selectedService.yamlService,
      },
    }));

    while (queue.length > 0) {
      const current = queue.shift();
      const serviceName = current?.serviceRef.name;
      if (!current || !serviceName) {
        continue;
      }

      const baseDeploy = current.baseDeploy;
      if (!baseDeploy?.id || !baseDeploy.deployable) {
        throw new Error(`Active deploy not found for dependency ${serviceName} in base build ${baseBuild.uuid}`);
      }

      const serviceSource =
        current.resolvedSource ??
        (await this.resolveServiceSource({
          serviceRef: current.serviceRef,
          baseDeploy,
          fallbackSource: environmentSource,
          configCache,
        }));
      if (includedDeployIds.has(baseDeploy.id)) {
        continue;
      }

      includedDeployIds.add(baseDeploy.id);

      const yamlService = serviceSource.yamlService;
      for (const requiredService of yamlService?.requires || []) {
        if (requiredService.name) {
          const dependencyDeploy = this.findActiveDeployForReference(activeDeploys, requiredService);
          if (!dependencyDeploy) {
            throw new Error(
              `Active deploy not found for dependency ${requiredService.name} in base build ${baseBuild.uuid}`
            );
          }

          queue.push({
            serviceRef: requiredService,
            baseDeploy: dependencyDeploy,
          });
        }
      }
    }

    return includedDeployIds;
  }

  private getEnvironmentSource(baseBuild: Build): EnvironmentSource {
    const repo = baseBuild.pullRequest?.fullName;
    const branch = baseBuild.pullRequest?.branchName;
    if (!repo || !branch) {
      throw new Error('Base environment build is missing source repository/branch');
    }

    return {
      repo,
      branch,
    };
  }

  private getEnvironmentServiceReferences(lifecycleConfig: LifecycleConfig): DependencyService[] {
    const seen = new Set<string>();
    const references = [
      ...(lifecycleConfig.environment?.defaultServices ?? []),
      ...(lifecycleConfig.environment?.optionalServices ?? []),
    ];

    return references.filter((reference) => {
      const key = `${reference.name ?? ''}:${reference.repository ?? ''}:${reference.branch ?? ''}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  private getActiveDeploys(baseBuild: Build): Deploy[] {
    return (baseBuild.deploys || []).filter((deploy) => deploy.active && deploy.deployable?.name);
  }

  private getResolvedSandboxServiceKey(
    service: Pick<ResolvedSandboxService, 'name' | 'serviceRepo' | 'serviceBranch'>
  ): string {
    return `${normalizeRepoKey(service.serviceRepo)}::${service.serviceBranch}::${service.name}`;
  }

  private findActiveDeployForReference(activeDeploys: Deploy[], serviceRef: DependencyService): Deploy | null {
    if (!serviceRef.name) {
      return null;
    }

    const matchesByName = activeDeploys.filter((deploy) => deploy.deployable?.name === serviceRef.name);
    const repoMatches = serviceRef.repository
      ? matchesByName.filter((deploy) => deploy.repository?.fullName === serviceRef.repository)
      : matchesByName;
    const requestedBranch = normalizeOptionalString(serviceRef.branch);
    const matches = requestedBranch
      ? repoMatches.filter((deploy) => normalizeOptionalString(deploy.branchName) === requestedBranch)
      : repoMatches;

    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple active deploys matched sandbox service ${serviceRef.name}${
          serviceRef.repository ? ` in ${serviceRef.repository}` : ''
        }${requestedBranch ? ` on ${requestedBranch}` : ''}`
      );
    }

    return matches[0];
  }

  private async resolveServiceSource({
    serviceRef,
    baseDeploy,
    fallbackSource,
    configCache,
  }: {
    serviceRef: DependencyService;
    baseDeploy: Deploy;
    fallbackSource: EnvironmentSource;
    configCache: Map<string, Promise<LifecycleConfig>>;
  }): Promise<ResolvedLifecycleServiceSource> {
    const serviceName = serviceRef.name || baseDeploy.deployable?.name;
    const repo = serviceRef.repository || baseDeploy.repository?.fullName || fallbackSource.repo;
    const branch = serviceRef.branch || baseDeploy.branchName || fallbackSource.branch;

    if (!serviceName || !repo || !branch) {
      throw new Error(`Unable to resolve sandbox service source for ${serviceName ?? 'unknown service'}`);
    }

    const lifecycleConfig = await this.fetchCachedLifecycleConfig(repo, branch, configCache);
    const yamlService = getDeployingServicesByName(lifecycleConfig, serviceName);
    if (!yamlService) {
      throw new Error(`Service ${serviceName} not found in ${repo}:${branch}`);
    }

    return {
      repo,
      branch,
      yamlService,
    };
  }

  private async fetchCachedLifecycleConfig(
    repo: string,
    branch: string,
    configCache: Map<string, Promise<LifecycleConfig>>
  ): Promise<LifecycleConfig> {
    const cacheKey = `${repo}::${branch}`;
    let configPromise = configCache.get(cacheKey);
    if (!configPromise) {
      configPromise = fetchLifecycleConfig(repo, branch).then((config) => {
        if (!config) {
          throw new Error(`Lifecycle config not found for ${repo}:${branch}`);
        }

        return config;
      });
      configCache.set(cacheKey, configPromise);
    }

    return configPromise;
  }
}

interface ResolvedLifecycleServiceSource extends EnvironmentSource {
  yamlService: LifecycleService;
}

function getDeployTypeFromBaseDeploy(deploy: Deploy): DeployTypes {
  return deploy.deployable?.type || deploy.service?.type || DeployTypes.GITHUB;
}

function toPostgresTextArrayLiteral(value: unknown): unknown {
  if (value == null || !Array.isArray(value)) {
    return value;
  }

  const escapedValues = value.map((entry) => `"${String(entry).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escapedValues.join(',')}}`;
}
