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
import { Build, Deploy, Service, Deployable } from 'server/models';
import { CLIDeployTypes, DeployTypes } from 'shared/constants';
import { shellPromise } from './shell';
import { getLogger, withLogContext, updateLogContext } from './logger/index';
import GlobalConfigService from 'server/services/globalConfig';
import { DatabaseSettings } from 'server/services/types/globalConfig';

/**
 * Deploys the build
 * @param build the build to deploy
 */

export async function deployBuild(build: Build) {
  await Promise.all(
    build.deploys
      ?.filter((d) => {
        const serviceType: DeployTypes = build.enableFullYaml ? d.deployable.type : d.service.type;

        return CLIDeployTypes.has(serviceType);
      })
      .map(async (deploy) => {
        return withLogContext(
          { deployUuid: deploy.uuid, serviceName: deploy.deployable?.name || deploy.service?.name },
          async () => cliDeploy(deploy)
        );
      })
  );
}

/**
 * Shells out to run a CLI command
 * @param deploy the deploy to run
 */
export async function cliDeploy(deploy: Deploy) {
  await deploy.$fetchGraph('[build, service, deployable]');

  const { build, service, deployable } = deploy;
  const serviceCommand: string = build.enableFullYaml ? deployable.command : service.command;
  const { settings, region } = await getSettingsFor(serviceCommand);
  return await shellPromise(
    `AWS_REGION=${region} pnpm run babel-node -- ${serviceCommand} deploy ${contextForDeploy(deploy, settings)}`
  );
}

/**
 * Shells out to run the codefresh deploy
 * @param deploy the deploy to run
 */
export async function codefreshDeploy(deploy: Deploy, build: Build, service: Service, deployable: Deployable) {
  const buildUuid = build?.uuid;
  updateLogContext({ buildUuid });
  getLogger().debug('Invoking the codefresh CLI to deploy this deploy');

  const envVariables = merge(deploy.env || {}, deploy.build.commentRuntimeEnv);

  const variables = Object.keys(envVariables).map((key) => {
    return ` -v '${key}'='${
      typeof envVariables[key] === 'object' ? JSON.stringify(envVariables[key]) : envVariables[key]
    }'`;
  });

  let deployTrigger: string;
  let serviceDeployPipelineId: string;
  if (build?.enableFullYaml) {
    deployTrigger = deployable.deployTrigger ? `--trigger ${deployable.deployTrigger}` : ``;
    serviceDeployPipelineId = deployable.deployPipelineId;
  } else {
    deployTrigger = service.deployTrigger ? `--trigger ${service.deployTrigger}` : ``;
    serviceDeployPipelineId = service.deployPipelineId;
  }

  const command = `codefresh run ${serviceDeployPipelineId} -b "${deploy.branchName}" ${variables.join(
    ' '
  )} ${deployTrigger} -d`;
  getLogger().debug(`About to run codefresh command: command=${command}`);
  const output = await shellPromise(command);
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

    const variables = Object.keys(envVariables).map((key) => {
      return ` -v '${key}'='${
        typeof envVariables[key] === 'object' ? JSON.stringify(envVariables[key]) : envVariables[key]
      }'`;
    });

    let destroyTrigger: string;
    let destroyPipelineId: string;
    let serviceBranchName: string;
    if (deploy.build.enableFullYaml) {
      destroyTrigger = deploy.deployable.destroyTrigger ? `--trigger ${deploy.deployable.destroyTrigger}` : ``;
      destroyPipelineId = deploy.deployable.destroyPipelineId;
      serviceBranchName = deploy.deployable.branchName;
    } else {
      destroyTrigger = deploy.service.destroyTrigger ? `--trigger ${deploy.service.destroyTrigger}` : ``;
      destroyPipelineId = deploy.service.destroyPipelineId;
      serviceBranchName = deploy.service.branchName;
    }

    const command = `codefresh run ${destroyPipelineId} -b "${serviceBranchName}" ${variables.join(
      ' '
    )} ${destroyTrigger} -d`;
    getLogger().debug(`Destroy command: command=${command}`);
    const output = await shellPromise(command);
    const id = output?.trim();
    return id;
  } catch (error) {
    getLogger({ error }).error('Error destroying Codefresh pipeline');
    throw error;
  }
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
      service: true,
      build: true,
      deployable: true,
    });
    await Promise.all(
      deploys
        ?.filter((d) => {
          const serviceType: DeployTypes = build.enableFullYaml ? d.deployable.type : d.service.type;
          return CLIDeployTypes.has(serviceType) && d.active;
        })
        .map(async (deploy) => {
          return withLogContext(
            { deployUuid: deploy.uuid, serviceName: deploy.deployable?.name || deploy.service?.name },
            async () => {
              const serviceType: DeployTypes = build.enableFullYaml ? deploy.deployable.type : deploy.service.type;
              getLogger().info('CLI: deleting');
              return serviceType === DeployTypes.CODEFRESH ? codefreshDestroy(deploy) : deleteDeploy(deploy);
            }
          );
        })
    );
    getLogger().info('CLI: deleted');
  } catch (e) {
    getLogger({ error: e }).error('Error deleting CLI resources');
  }
}

/**
 * Returns the context parameters for a deploy
 * @param deploy the deploy to get the context parameters for
 */
function contextForDeploy(deploy: Deploy, settings: string) {
  const stackName = `${deploy.build.uuid}-${deploy.build.sha}`;
  const serviceName = deploy.build.enableFullYaml ? deploy.deployable.name : deploy.service.name;
  const serviceArgs = deploy.build.enableFullYaml ? deploy.deployable.arguments : deploy.service.arguments;
  return `--stackName ${stackName} --serviceName ${serviceName} --buildUUID ${deploy.build.uuid} ${serviceArgs} --settings '${settings}'`;
}

/**
 * Deletes a CLI deploy
 * @param deploy cli deploys to delete
 */
async function deleteDeploy(deploy: Deploy) {
  const serviceCmd = deploy.build.enableFullYaml ? deploy.deployable.command : deploy.service.command;

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
