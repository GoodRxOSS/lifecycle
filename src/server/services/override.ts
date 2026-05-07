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
import { Build, Deploy, PullRequest } from 'server/models';
import * as k8s from 'server/lib/kubernetes';
import DeployService from './deploy';
import * as psl from 'psl';

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
  serviceName: string;
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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

    for (const serviceOverride of serviceOverrides) {
      if (serviceOverride.active == null && serviceOverride.branchOrExternalUrl == null) {
        throw new Error('active or branchOrExternalUrl is required');
      }

      if (!this.findDeployForService(build, deploys, serviceOverride.serviceName)) {
        throw new ServiceOverrideNotFoundError(serviceOverride.serviceName);
      }
    }

    await Promise.all(
      serviceOverrides.map((serviceOverride) => this.patchServiceOverride(build, deploys, serviceOverride, true, true))
    );

    const queued = await this.enqueueRedeployIfEnabled(build, pullRequest, runUuid);
    return {
      buildUuid: build.uuid,
      queued,
      status: 'success',
    };
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
    if (uuid.length < 3 || uuid.length > 50) {
      return { valid: false, error: 'UUID must be between 3 and 50 characters' };
    }

    if (!/^[a-zA-Z0-9-]+$/.test(uuid)) {
      return { valid: false, error: 'UUID can only contain letters, numbers, and hyphens' };
    }

    if (uuid.startsWith('-') || uuid.endsWith('-')) {
      return { valid: false, error: 'UUID cannot start or end with a hyphen' };
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
