/**
 * Copyright 2026 Lifecycle contributors
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
import { extractContextForQueue, getLogger, updateLogContext } from 'server/lib/logger';
import { validateBuildUuidFormat } from 'server/lib/validation/buildUuidValidator';
import { Build, Deploy, PullRequest } from 'server/models';
import * as k8s from 'server/lib/kubernetes';
import DeployService from './deploy';
import * as psl from 'psl';
import { DeployTypes } from 'shared/constants';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface UpdateResult {
  build: Build;
  deploysUpdated: number;
}

export interface ServiceOverrideInput {
  active: boolean;
  serviceName: string;
  branchOrExternalUrl: string;
}

export interface BuildOverrideInput {
  serviceOverrides: ServiceOverrideInput[];
  vanityUrl: string | null;
  envOverrides: Record<string, any>;
  redeployOnPush: boolean;
}

export interface BuildConfigPatchInput {
  uuid?: string;
  isStatic?: boolean;
  trackDefaultBranches?: boolean;
  commentRuntimeEnv?: Record<string, any>;
  commentInitEnv?: Record<string, any>;
}

export interface ApplyBuildOverridesArgs {
  build: Build;
  deploys: Deploy[];
  pullRequest?: PullRequest | null;
  overrides: BuildOverrideInput;
  runUuid: string;
}

export interface ApplyBuildConfigPatchArgs {
  build: Build;
  pullRequest?: PullRequest | null;
  patch: BuildConfigPatchInput;
  runUuid: string;
}

export interface ServiceOverridePatchInput {
  name: string;
  active?: boolean;
  branchOrExternalUrl?: string;
}

export interface ApplyServiceOverridesArgs {
  build: Build;
  deploys: Deploy[];
  pullRequest?: PullRequest | null;
  serviceOverrides: ServiceOverridePatchInput[];
  runUuid: string;
}

export interface OverrideApplyResult {
  buildUuid: string;
  queued: boolean;
  status: 'success';
}

export interface BuildServiceOverrideState {
  name: string;
  active: boolean;
  branchOrExternalUrl: string | null;
  status: string | null;
  statusMessage: string | null;
  updatedAt: string | Date | null;
  group: 'default' | 'optional';
  editable: boolean;
}

export class BuildUuidValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildUuidValidationError';
  }
}

export class ServiceOverrideNotFoundError extends Error {
  constructor(serviceName: string) {
    super(`Service ${serviceName} not found in build`);
    this.name = 'ServiceOverrideNotFoundError';
  }
}

export class ServiceOverrideNotEditableError extends Error {
  constructor(serviceName: string) {
    super(`Service ${serviceName} branchOrExternalUrl is not editable`);
    this.name = 'ServiceOverrideNotEditableError';
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isBranchOrExternalUrlEditable(deployType?: DeployTypes): boolean {
  if (!deployType) {
    return false;
  }

  return [DeployTypes.GITHUB, DeployTypes.HELM, DeployTypes.EXTERNAL_HTTP].includes(deployType);
}

function getDockerDisplayValue(dockerImage?: string | null, defaultTag?: string | null): string | null {
  if (dockerImage && defaultTag) {
    return `${dockerImage}@${defaultTag}`;
  }

  return dockerImage || defaultTag || null;
}

function getBranchOrExternalUrl(deploy: Deploy, deployConfig?: any): string | null | undefined {
  switch (deployConfig?.type) {
    case DeployTypes.GITHUB:
      return deploy.branchName ?? deploy.publicUrl ?? null;
    case DeployTypes.HELM:
    case DeployTypes.CODEFRESH:
    case DeployTypes.CONFIGURATION:
      return deploy.branchName ?? null;
    case DeployTypes.EXTERNAL_HTTP:
      return deploy.publicUrl ?? deployConfig.defaultPublicUrl ?? null;
    case DeployTypes.DOCKER:
      return getDockerDisplayValue(deployConfig.dockerImage, deployConfig.defaultTag);
    default:
      return undefined;
  }
}

function sortServiceOverrideStates(left: BuildServiceOverrideState, right: BuildServiceOverrideState): number {
  if (left.group !== right.group) {
    return left.group === 'default' ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

export default class OverrideService extends BaseService {
  async applyBuildOverrides({
    build,
    deploys,
    pullRequest,
    overrides,
    runUuid,
  }: ApplyBuildOverridesArgs): Promise<void> {
    if (!build.id) {
      getLogger().error('Build: missing for comment edit overrides');
      return;
    }

    const requestedUuid = overrides.vanityUrl && overrides.vanityUrl !== build.uuid ? overrides.vanityUrl : null;

    if (requestedUuid) {
      const validation = await this.validateUuid(requestedUuid, build.id);
      if (!validation.valid) {
        getLogger().warn(`UUID: comment override rejected newUuid=${requestedUuid} error=${validation.error}`);
        return;
      }
    }

    getLogger().debug(`Parsed environment overrides: ${JSON.stringify(overrides.envOverrides)}`);

    await build.$query().patch({
      commentInitEnv: overrides.envOverrides,
      commentRuntimeEnv: overrides.envOverrides,
      trackDefaultBranches: overrides.redeployOnPush,
    });

    getLogger().debug(`Service overrides: ${JSON.stringify(overrides.serviceOverrides)}`);

    await Promise.all(
      overrides.serviceOverrides.map((serviceOverride) => this.patchServiceOverride(build, deploys, serviceOverride))
    );

    if (requestedUuid) {
      await this.updateBuildUuid(build, requestedUuid);
    }

    await this.enqueueRedeployIfEnabled(build, pullRequest, runUuid);
  }

  async applyBuildConfigPatch({ build, pullRequest, patch, runUuid }: ApplyBuildConfigPatchArgs): Promise<Build> {
    if (!build.id) {
      getLogger().error('Build: missing for build config patch');
      throw new Error('Build id is required');
    }

    const requestedUuid = hasOwn(patch, 'uuid') ? patch.uuid : undefined;
    if (requestedUuid != null) {
      if (requestedUuid === build.uuid) {
        throw new BuildUuidValidationError('UUID must be different');
      }

      const validation = await this.validateUuid(requestedUuid, build.id);
      if (!validation.valid) {
        throw new BuildUuidValidationError(validation.error || 'Invalid UUID');
      }
    }

    const buildPatch: Record<string, any> = {};
    if (hasOwn(patch, 'isStatic')) {
      buildPatch.isStatic = patch.isStatic;
    }
    if (hasOwn(patch, 'trackDefaultBranches')) {
      buildPatch.trackDefaultBranches = patch.trackDefaultBranches;
    }
    if (hasOwn(patch, 'commentRuntimeEnv')) {
      buildPatch.commentRuntimeEnv = patch.commentRuntimeEnv;
    }
    if (hasOwn(patch, 'commentInitEnv')) {
      buildPatch.commentInitEnv = patch.commentInitEnv;
    }

    if (Object.keys(buildPatch).length > 0) {
      await build.$query().patch(buildPatch);
      Object.assign(build, buildPatch);
    }

    let updatedBuild = build;
    if (requestedUuid) {
      const result = await this.updateBuildUuid(build, requestedUuid);
      updatedBuild = result.build;
    }

    await this.enqueueRedeployIfEnabled(updatedBuild, pullRequest, runUuid);
    return updatedBuild;
  }

  async applyServiceOverrides({
    build,
    deploys,
    pullRequest,
    serviceOverrides,
    runUuid,
  }: ApplyServiceOverridesArgs): Promise<OverrideApplyResult> {
    if (!build.id) {
      getLogger().error('Build: missing for service override');
      throw new Error('Build id is required');
    }

    if (!serviceOverrides.length) {
      throw new Error('serviceOverrides is required');
    }

    const overrideStates = await this.getServiceOverrideStates(build, deploys);
    const overrideStateByName = new Map(overrideStates.map((state) => [state.name, state]));
    const sanitizedServiceOverrides: ServiceOverridePatchInput[] = [];

    for (const serviceOverride of serviceOverrides) {
      if (serviceOverride.active == null && serviceOverride.branchOrExternalUrl == null) {
        throw new Error('active or branchOrExternalUrl is required');
      }

      if (!this.findDeployForService(build, deploys, serviceOverride.name)) {
        throw new ServiceOverrideNotFoundError(serviceOverride.name);
      }

      const overrideState = overrideStateByName.get(serviceOverride.name);
      if (!overrideState) {
        throw new ServiceOverrideNotFoundError(serviceOverride.name);
      }

      const sanitizedServiceOverride = { ...serviceOverride };
      if (serviceOverride.branchOrExternalUrl != null && !overrideState.editable) {
        if (serviceOverride.branchOrExternalUrl !== overrideState.branchOrExternalUrl) {
          throw new ServiceOverrideNotEditableError(serviceOverride.name);
        }

        delete sanitizedServiceOverride.branchOrExternalUrl;
      }

      if (sanitizedServiceOverride.active != null || sanitizedServiceOverride.branchOrExternalUrl != null) {
        sanitizedServiceOverrides.push(sanitizedServiceOverride);
      }
    }

    if (sanitizedServiceOverrides.length === 0) {
      return {
        buildUuid: build.uuid,
        queued: false,
        status: 'success',
      };
    }

    await Promise.all(
      sanitizedServiceOverrides.map((serviceOverride) =>
        this.patchServiceOverride(
          build,
          deploys,
          {
            ...serviceOverride,
            serviceName: serviceOverride.name,
          },
          true,
          true
        )
      )
    );

    const queued = await this.enqueueRedeployIfEnabled(build, pullRequest, runUuid);
    return {
      buildUuid: build.uuid,
      queued,
      status: 'success',
    };
  }

  async getServiceOverrideStates(build: Build, deploys: Deploy[]): Promise<BuildServiceOverrideState[]> {
    if (build.enableFullYaml) {
      return deploys
        .map((deploy) => this.getFullYamlServiceOverrideState(deploy))
        .filter((state): state is BuildServiceOverrideState => state != null)
        .sort(sortServiceOverrideStates);
    }

    const groups = await this.getClassicServiceGroups(build);

    return deploys
      .map((deploy) => this.getClassicServiceOverrideState(deploy, groups))
      .filter((state): state is BuildServiceOverrideState => state != null)
      .sort(sortServiceOverrideStates);
  }

  private async patchServiceOverride(
    build: Build,
    deploys: Deploy[],
    {
      active,
      serviceName,
      branchOrExternalUrl,
    }: {
      active?: boolean;
      serviceName: string;
      branchOrExternalUrl?: string;
    },
    throwOnMissing = false,
    throwOnPatchFailure = false
  ) {
    getLogger().debug(`Patching service: ${serviceName} active=${active} branch/url=${branchOrExternalUrl}`);

    const deploy = this.findDeployForService(build, deploys, serviceName);

    if (!deploy) {
      getLogger().warn(`Deploy: not found service=${serviceName}`);
      if (throwOnMissing) {
        throw new ServiceOverrideNotFoundError(serviceName);
      }
      return;
    }

    const { service } = deploy;
    const deployable = deploy.deployable!;

    if (branchOrExternalUrl != null && psl.isValid(branchOrExternalUrl)) {
      await this.patchWithFailureMode(
        deploy.$query().patch({
          publicUrl: branchOrExternalUrl,
          branchName: null,
          dockerImage: null,
          ...(active != null ? { active } : {}),
        } as object),
        `Deploy: patch failed service=${serviceName} field=externalUrl`,
        throwOnPatchFailure
      );
    } else if (branchOrExternalUrl != null) {
      getLogger().debug(`Setting branch override: ${branchOrExternalUrl} for deployable: ${deployable?.name}`);
      const deployService =
        this.db.services?.Deploy ?? new DeployService(this.db, this.redis, this.redlock, this.queueManager);

      await this.patchWithFailureMode(
        deployable.$query().patch({ commentBranchName: branchOrExternalUrl }),
        `Deployable: patch failed service=${serviceName} field=branch`,
        throwOnPatchFailure
      );

      await this.patchWithFailureMode(
        deploy.$query().patch({
          branchName: branchOrExternalUrl,
          publicUrl: build.enableFullYaml
            ? deployService.hostForDeployableDeploy(deploy, deployable)
            : deployService.hostForServiceDeploy(deploy, service),
          ...(active != null ? { active } : {}),
        }),
        `Deploy: patch failed service=${serviceName} field=branch`,
        throwOnPatchFailure
      );
    } else if (active != null) {
      await this.patchWithFailureMode(
        deploy.$query().patch({ active }),
        `Deploy: patch failed service=${serviceName} field=active`,
        throwOnPatchFailure
      );
    }

    if (active == null) {
      return;
    }

    if (build.enableFullYaml) {
      const dependents = deploys.filter(
        (d) =>
          d.deployable!.dependsOnDeployableName === deployable.name &&
          d.deployable!.buildUUID === deployable.buildUUID &&
          d.deployable!.buildId === deployable.buildId
      );
      await Promise.all(dependents.map((d) => d.$query().patch({ active })));
    } else {
      const dependents = deploys.filter((d) => d.service.dependsOnServiceId === service.id);
      await Promise.all(dependents.map((d) => d.$query().patch({ active })));
    }
  }

  private async patchWithFailureMode(
    patchPromise: PromiseLike<unknown>,
    failureMessage: string,
    throwOnPatchFailure: boolean
  ): Promise<void> {
    try {
      await patchPromise;
    } catch (error) {
      getLogger().error({ error }, failureMessage);
      if (throwOnPatchFailure) {
        throw error;
      }
    }
  }

  private findDeployForService(build: Build, deploys: Deploy[], serviceName: string): Deploy | undefined {
    return build.enableFullYaml
      ? deploys.find((deploy) => deploy.deployable!.name === serviceName)
      : deploys.find((deploy) => deploy.service.name === serviceName);
  }

  private getFullYamlServiceOverrideState(deploy: Deploy): BuildServiceOverrideState | null {
    const { deployable } = deploy;

    if (!deployable || deployable.dependsOnServiceId != null) {
      return null;
    }

    return this.getServiceOverrideStateForDeploy(deploy, deployable.name, deployable.active ? 'default' : 'optional');
  }

  private async getClassicServiceGroups(build: Build): Promise<{
    defaultServiceIds: Set<number>;
    optionalServiceIds: Set<number>;
  }> {
    if (!build.environment && typeof build.$fetchGraph === 'function') {
      await build.$fetchGraph('environment');
    }

    if (
      build.environment &&
      (!Array.isArray(build.environment.defaultServices) || !Array.isArray(build.environment.optionalServices)) &&
      typeof build.environment.$fetchGraph === 'function'
    ) {
      await build.environment.$fetchGraph('[defaultServices, optionalServices]');
    }

    return {
      defaultServiceIds: new Set((build.environment?.defaultServices || []).map((service) => service.id)),
      optionalServiceIds: new Set((build.environment?.optionalServices || []).map((service) => service.id)),
    };
  }

  private getClassicServiceOverrideState(
    deploy: Deploy,
    {
      defaultServiceIds,
      optionalServiceIds,
    }: {
      defaultServiceIds: Set<number>;
      optionalServiceIds: Set<number>;
    }
  ): BuildServiceOverrideState | null {
    if (!deploy.service) {
      return null;
    }

    const serviceId = deploy.serviceId ?? deploy.service.id;
    const group = defaultServiceIds.has(serviceId) ? 'default' : optionalServiceIds.has(serviceId) ? 'optional' : null;
    if (!group) {
      return null;
    }

    return this.getServiceOverrideStateForDeploy(deploy, deploy.service.name, group);
  }

  private getServiceOverrideStateForDeploy(
    deploy: Deploy,
    name: string,
    group: 'default' | 'optional'
  ): BuildServiceOverrideState | null {
    const deployConfig = deploy.deployable || deploy.service;
    const deployType = deployConfig?.type;
    const branchOrExternalUrl = getBranchOrExternalUrl(deploy, deployConfig);

    if (branchOrExternalUrl === undefined) {
      return null;
    }

    return {
      name,
      active: deploy.active,
      branchOrExternalUrl,
      status: deploy.status ?? null,
      statusMessage: deploy.statusMessage ?? null,
      updatedAt: deploy.updatedAt ?? null,
      group,
      editable: isBranchOrExternalUrlEditable(deployType),
    };
  }

  private async enqueueRedeployIfEnabled(
    build: Build,
    pullRequest: PullRequest | null | undefined,
    runUuid: string
  ): Promise<boolean> {
    if (!pullRequest?.deployOnUpdate) {
      return false;
    }

    const buildService =
      this.db.services?.BuildService ??
      new (await import('./build')).default(this.db, this.redis, this.redlock, this.queueManager);

    await buildService.enqueueResolveAndDeployBuild({
      buildId: build.id,
      runUUID: runUuid,
      ...extractContextForQueue(),
    });
    return true;
  }

  /**
   * Validate UUID format and uniqueness
   * @param uuid The UUID to validate
   * @returns ValidationResult with validation status and error details
   */
  async validateUuid(uuid: string, currentBuildId?: number): Promise<ValidationResult> {
    const formatError = validateBuildUuidFormat(uuid);
    if (formatError) {
      return { valid: false, error: formatError };
    }

    try {
      const existingBuild = await this.db.models.Build.query().findOne({ uuid });

      if (existingBuild && existingBuild.id !== currentBuildId) {
        return { valid: false, error: 'UUID is not available' };
      }
    } catch (error) {
      getLogger().error({ error }, 'UUID: uniqueness check failed');
      return { valid: false, error: 'Unable to validate UUID' };
    }

    return { valid: true };
  }

  /**
   * Update build UUID and all related records
   * @param build The build to update
   * @param newUuid The new UUID to set
   * @returns UpdateResult with updated build and count of updated deploys
   */
  async updateBuildUuid(build: Build, newUuid: string): Promise<UpdateResult> {
    const oldUuid = build.uuid;
    const oldNamespace = build.namespace;

    updateLogContext({ buildUuid: oldUuid, newUuid });
    getLogger().info(`Override: updating newUuid=${newUuid}`);

    try {
      const validation = await this.validateUuid(newUuid, build.id);
      if (!validation.valid) {
        throw new BuildUuidValidationError(validation.error || 'Invalid UUID');
      }

      return await this.db.models.Build.transact(async (trx) => {
        await build.$query(trx).patch({
          uuid: newUuid,
          namespace: `env-${newUuid}`,
        });

        await this.db.models.Deployable.query(trx).where('buildId', build.id).patch({ buildUUID: newUuid });

        const deploys = await this.db.models.Deploy.query(trx)
          .where('buildId', build.id)
          .withGraphFetched('[service, deployable]');

        // Update all deploys
        // this will not work for database configured services
        const deployService = new DeployService();
        const updateDeploys = deploys.map(async (deploy) => {
          const deployName = deploy.deployable?.name ?? deploy.service?.name;
          if (!deployName) {
            getLogger().warn(`Deploy: missing service name while updating build UUID deployId=${deploy.id}`);
            return;
          }

          const newDeployUuid = `${deployName}-${newUuid}`;
          deploy.uuid = newDeployUuid;
          const patchFields: Record<string, string> = {
            uuid: newDeployUuid,
            internalHostname: newDeployUuid,
          };

          const publicUrl =
            build.enableFullYaml && deploy.deployable
              ? deployService.hostForDeployableDeploy(deploy, deploy.deployable)
              : deployService.hostForServiceDeploy(deploy, deploy.service);
          if (publicUrl) {
            patchFields.publicUrl = publicUrl;
          }

          return deploy.$query(trx).patch(patchFields);
        });

        await Promise.all(updateDeploys);

        const updatedBuild = await this.db.models.Build.query(trx).findById(build.id);

        k8s.deleteNamespace(oldNamespace).catch((error) => {
          getLogger().warn({ error }, `Namespace: delete failed name=${oldNamespace}`);
        });
        getLogger().info(`Override: updated oldUuid=${oldUuid} newUuid=${newUuid} deploysUpdated=${deploys.length}`);

        return {
          build: updatedBuild,
          deploysUpdated: deploys.length,
        };
      });
    } catch (error) {
      getLogger().error({ error }, `UUID: update failed newUuid=${newUuid}`);
      throw error;
    }
  }
}
