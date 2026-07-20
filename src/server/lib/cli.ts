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

import { merge } from 'lodash';
import { Build, Deploy, Deployable } from 'server/models';
import { CLIDeployTypes, DeployTypes } from 'shared/constants';
import { shellPromise } from './shell';
import { getLogger, withLogContext, updateLogContext } from './logger';
import GlobalConfigService from 'server/services/globalConfig';
import { DatabaseSettings } from 'server/services/types/globalConfig';
import {
  cleanupCodefreshExternalSecrets,
  hasCodefreshExternalSecretRefs,
  resolveCodefreshExternalSecrets,
} from 'server/lib/codefreshExternalSecrets';

/**
 * Deploys the build
 * @param build the build to deploy
 */

export async function deployBuild(build: Build) {
  await Promise.all(
    build.deploys
      ?.filter((d) => {
        const serviceType: DeployTypes = d.deployable.type;

        return CLIDeployTypes.has(serviceType);
      })
      .map(async (deploy) => {
        return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () =>
          cliDeploy(deploy)
        );
      })
  );
}

/**
 * Shells out to run a CLI command
 * @param deploy the deploy to run
 */
export async function cliDeploy(deploy: Deploy) {
  await deploy.$fetchGraph('[build, deployable]');

  const { deployable } = deploy;
  const serviceCommand: string = deployable.command;
  const { settings, region } = await getSettingsFor(serviceCommand);
  return await shellPromise(
    `AWS_REGION=${region} pnpm run babel-node -- ${serviceCommand} deploy ${contextForDeploy(deploy, settings)}`
  );
}

/**
 * Shells out to run the codefresh deploy
 * @param deploy the deploy to run
 */
export async function codefreshDeploy(deploy: Deploy, build: Build, deployable: Deployable) {
  const buildUuid = build?.uuid;
  updateLogContext({ buildUuid });
  getLogger().debug('Invoking the codefresh CLI to deploy this deploy');

  const envVariables = merge(deploy.env || {}, deploy.build.commentRuntimeEnv);
  const serviceName = deployable?.name;
  const globalConfigs = hasCodefreshExternalSecretRefs(envVariables)
    ? await GlobalConfigService.getInstance().getAllConfigs()
    : undefined;
  const resolvedEnv = await resolveCodefreshExternalSecrets({
    env: envVariables,
    serviceName,
    namespace: build?.namespace,
    buildUuid: build?.uuid,
    staticEnv: build?.isStatic,
    secretProviders: globalConfigs?.secretProviders,
  });
  const { variables, redactedVariables } = codefreshVariables(resolvedEnv.env, resolvedEnv.secretEnvKeys);

  const deployTrigger = deployable.deployTrigger ? `--trigger ${deployable.deployTrigger}` : ``;
  const serviceDeployPipelineId = deployable.deployPipelineId;

  const command = `codefresh run ${shellQuote(serviceDeployPipelineId)} -b ${shellQuote(
    deploy.branchName
  )} ${variables.join(' ')} ${deployTrigger} -d`;
  const redactedCommand = `codefresh run ${shellQuote(serviceDeployPipelineId)} -b ${shellQuote(
    deploy.branchName
  )} ${redactedVariables.join(' ')} ${deployTrigger} -d`;
  getLogger().debug(`About to run codefresh command: command=${redactedCommand}`);
  const output = await shellPromise(command, { redactCommand: redactedCommand });
  getLogger().debug(`Codefresh run output: output=${output}`);
  const id = output.trim();
  return id;
}

/**
 * Shells out to destroy the codefresh deploy
 * @param deploy the deploy to run
 */
export async function codefreshDestroy(deploy: Deploy) {
  const buildUuid = deploy?.build?.uuid;
  updateLogContext({ buildUuid });
  getLogger().debug('Invoking the codefresh CLI to delete this deploy');

  try {
    /** Reset the SHA so we will re-run the pipelines post destroy */
    await deploy.$query().patch({
      sha: null,
    });

    /* Always pass in a BUILD UUID & BUILD SHA as those are critical keys */
    const envVariables = merge(
      {
        BUILD_UUID: buildUuid,
        BUILD_SHA: deploy?.build?.sha,
      },
      deploy.env || {},
      deploy.build.commentRuntimeEnv
    );
    const serviceName = deploy.deployable?.name;
    const hasExternalSecretRefs = hasCodefreshExternalSecretRefs(envVariables);
    const globalConfigs = hasExternalSecretRefs ? await GlobalConfigService.getInstance().getAllConfigs() : undefined;

    try {
      const resolvedEnv = await resolveCodefreshExternalSecrets({
        env: envVariables,
        serviceName,
        namespace: deploy.build?.namespace,
        buildUuid: deploy.build?.uuid,
        staticEnv: deploy.build?.isStatic,
        secretProviders: globalConfigs?.secretProviders,
      });
      const { variables, redactedVariables } = codefreshVariables(resolvedEnv.env, resolvedEnv.secretEnvKeys);

      const destroyTrigger = deploy.deployable.destroyTrigger ? `--trigger ${deploy.deployable.destroyTrigger}` : ``;
      const destroyPipelineId = deploy.deployable.destroyPipelineId;
      const serviceBranchName = deploy.deployable.branchName;

      const command = `codefresh run ${shellQuote(destroyPipelineId)} -b ${shellQuote(
        serviceBranchName
      )} ${variables.join(' ')} ${destroyTrigger} -d`;
      const redactedCommand = `codefresh run ${shellQuote(destroyPipelineId)} -b ${shellQuote(
        serviceBranchName
      )} ${redactedVariables.join(' ')} ${destroyTrigger} -d`;
      getLogger().debug(`Destroy command: command=${redactedCommand}`);
      const output = await shellPromise(command, { redactCommand: redactedCommand });
      const id = output?.trim();
      return id;
    } finally {
      if (hasExternalSecretRefs) {
        await cleanupCodefreshExternalSecrets({
          env: envVariables,
          serviceName,
          namespace: deploy.build?.namespace,
        });
      }
    }
  } catch (error) {
    getLogger({ error }).error('Codefresh: pipeline destroy failed');
    throw error;
  }
}

function codefreshVariables(envVariables: Record<string, any>, secretEnvKeys: Set<string>) {
  const variables = Object.keys(envVariables).map((key) => codefreshVariable(key, envVariables[key]));
  const redactedVariables = Object.keys(envVariables).map((key) =>
    codefreshVariable(key, secretEnvKeys.has(key) ? '[REDACTED]' : envVariables[key])
  );

  return { variables, redactedVariables };
}

function codefreshVariable(key: string, value: any) {
  const variableValue = typeof value === 'object' ? JSON.stringify(value) : value;
  return ` -v ${shellQuote(key)}=${shellQuote(variableValue)}`;
}

function shellQuote(value: string | number | boolean | null | undefined): string {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

/**
 * Waits for codefresh to successfully complete
 * @param id the codefresh ID to watch
 * @returns whether or not it's successful
 */
export async function waitForCodefresh(id: string) {
  try {
    await shellPromise(`codefresh wait -t 60 ${id}`);
    const status = await shellPromise(`codefresh get build ${id} --output json | jq -r ".status"`);
    return status?.includes('success');
  } catch (error) {
    throw new Error(`Codefresh Pipeline Failure. Status was ${error}`);
  }
}

/**
 * Deletes CLI based services for this build
 * @param build the build to delete CLI services from
 */
export async function deleteBuild(build: Build) {
  const buildUuid = build?.uuid;
  updateLogContext({ buildUuid });
  try {
    const buildId = build?.id;

    const deploys = await Deploy.query().where({ buildId }).withGraphFetched({
      build: true,
      deployable: true,
    });
    await Promise.all(
      deploys
        ?.filter((d) => {
          const serviceType: DeployTypes = d.deployable.type;
          return CLIDeployTypes.has(serviceType) && d.active;
        })
        .map(async (deploy) => {
          return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () => {
            const serviceType: DeployTypes = deploy.deployable.type;
            getLogger().info('CLI: deleting');
            return serviceType === DeployTypes.CODEFRESH ? codefreshDestroy(deploy) : deleteDeploy(deploy);
          });
        })
    );
    getLogger().info('CLI: deleted');
  } catch (e) {
    getLogger({ error: e }).error('CLI: delete failed');
  }
}

/**
 * Returns the context parameters for a deploy
 * @param deploy the deploy to get the context parameters for
 */
function contextForDeploy(deploy: Deploy, settings: string) {
  const stackName = `${deploy.build.uuid}-${deploy.build.sha}`;
  const serviceName = deploy.deployable.name;
  const serviceArgs = deploy.deployable.arguments;
  return `--stackName ${stackName} --serviceName ${serviceName} --buildUUID ${deploy.build.uuid} ${serviceArgs} --settings '${settings}'`;
}

/**
 * Deletes a CLI deploy
 * @param deploy cli deploys to delete
 */
export async function deleteDeploy(deploy: Deploy) {
  const serviceCmd = deploy.deployable.command;

  const { settings, region } = await getSettingsFor(serviceCmd);
  return await shellPromise(
    `AWS_REGION=${region} pnpm run babel-node -- ${serviceCmd} destroy ${contextForDeploy(deploy, settings)}`
  );
}

async function getSettingsFor(serviceCommand: string): Promise<{ settings: string; region: string }> {
  const { auroraRestoreSettings, rdsRestoreSettings } = await GlobalConfigService.getInstance().getAllConfigs();
  let settings: DatabaseSettings;
  if (serviceCommand.includes('aurora-helper')) {
    settings = auroraRestoreSettings;
  } else if (serviceCommand.includes('rds-helper')) {
    settings = rdsRestoreSettings;
  }
  return {
    settings: JSON.stringify(settings),
    region: settings.region,
  };
}
