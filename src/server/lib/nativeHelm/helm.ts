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

import yaml from 'js-yaml';
import fs from 'fs';
import Deploy from 'server/models/Deploy';
import GlobalConfigService from 'server/services/globalConfig';
import rootLogger from 'server/lib/logger';
import { shellPromise } from 'server/lib/shell';
import { randomAlphanumeric } from 'server/lib/random';
import { nanoid } from 'nanoid';
import { Metrics } from 'server/lib/metrics';
import DeployService from 'server/services/deploy';
import { DeployStatus } from 'shared/constants';
import {
  applyHttpScaleObjectManifestYaml,
  applyExternalServiceManifestYaml,
  patchIngress,
} from 'server/lib/kubernetes';
import { ingressBannerSnippet } from 'server/lib/helm/utils';
import { constructHelmDeploysBuildMetaData } from 'server/lib/helm/helm';
import { fetchUntilSuccess } from 'server/lib/helm/helm';
import {
  HelmDeployOptions,
  ChartType,
  determineChartType,
  getHelmConfiguration,
  generateHelmInstallScript,
  validateHelmConfiguration,
  resolveHelmReleaseConflicts,
} from './utils';
import { HELM_IMAGE_PREFIX } from './constants';
import {
  createCloneScript,
  waitForJobAndGetLogs,
  getGitHubToken,
  GIT_USERNAME,
  MANIFEST_PATH,
} from 'server/lib/nativeBuild/utils';
import { createHelmJob as createHelmJobFromFactory } from 'server/lib/kubernetes/jobFactory';
import { ensureServiceAccountForJob } from 'server/lib/kubernetes/common/serviceAccount';

const logger = rootLogger.child({
  filename: 'lib/nativeHelm/helm.ts',
});

export interface JobResult {
  completed: boolean;
  logs: string;
  status: string;
}

export async function createHelmContainer(
  repoName: string,
  chartPath: string,
  releaseName: string,
  namespace: string,
  helmVersion: string,
  customValues: string[],
  valuesFiles: string[],
  chartType: ChartType,
  args?: string,
  chartRepoUrl?: string,
  defaultArgs?: string
): Promise<any> {
  const script = generateHelmInstallScript(
    repoName,
    chartPath,
    releaseName,
    namespace,
    customValues,
    valuesFiles,
    chartType,
    args,
    chartRepoUrl,
    defaultArgs
  );

  return {
    name: 'helm-deploy',
    image: `${HELM_IMAGE_PREFIX}:${helmVersion}`,
    env: [
      {
        name: 'HELM_CACHE_HOME',
        value: '/workspace/.helm/cache',
      },
      {
        name: 'HELM_CONFIG_HOME',
        value: '/workspace/.helm/config',
      },
    ],
    command: ['/bin/sh', '-c'],
    args: [script],
    volumeMounts: [
      {
        name: 'helm-workspace',
        mountPath: '/workspace',
      },
    ],
  };
}

export async function generateHelmManifest(deploy: Deploy, jobId: string, options: HelmDeployOptions): Promise<string> {
  await deploy.$fetchGraph('deployable.repository');
  await deploy.$fetchGraph('build');

  const { deployable, build } = deploy;
  const repository = deployable.repository;
  const helmConfig = await getHelmConfiguration(deploy);

  const serviceAccountName = await ensureServiceAccountForJob(options.namespace, 'deploy');

  const chartType = await determineChartType(deploy);
  const hasValueFiles = helmConfig.valuesFiles && helmConfig.valuesFiles.length > 0;
  const shouldIncludeGitClone =
    !!(repository?.fullName && deploy.branchName) && (chartType !== ChartType.PUBLIC || hasValueFiles);

  const gitToken = shouldIncludeGitClone ? await getGitHubToken() : '';
  const cloneScript = shouldIncludeGitClone
    ? createCloneScript(repository.fullName, deploy.branchName, deploy.sha)
    : '';

  const { mergeHelmConfigWithGlobal } = await import('./utils');
  const mergedHelmConfig = await mergeHelmConfigWithGlobal(deploy);
  const chartRepoUrl = mergedHelmConfig.chart?.repoUrl;
  const helmArgs = mergedHelmConfig.args;
  const defaultArgs = mergedHelmConfig.nativeHelm?.defaultArgs;

  const helmContainer = await createHelmContainer(
    repository?.fullName || 'no-repo',
    helmConfig.chartPath,
    helmConfig.releaseName,
    options.namespace,
    helmConfig.helmVersion,
    helmConfig.customValues,
    helmConfig.valuesFiles,
    helmConfig.chartType,
    helmArgs,
    chartRepoUrl,
    defaultArgs
  );

  const volumeConfig = {
    workspaceName: 'helm-workspace',
    volumes: [
      {
        name: 'helm-workspace',
        emptyDir: {},
      },
    ],
  };

  const shortSha = deploy.sha ? deploy.sha.substring(0, 7) : 'no-sha';
  let jobName = `${deploy.uuid}-deploy-${jobId}-${shortSha}`.substring(0, 63);
  if (jobName.endsWith('-')) {
    jobName = jobName.slice(0, -1);
  }

  const deployMetadata = {
    sha: deploy.sha || '',
    branch: deploy.branchName || '',
    deployId: deploy.id ? deploy.id.toString() : undefined,
    deployableId: deploy.deployableId.toString(),
  };

  const job = createHelmJobFromFactory({
    name: jobName,
    namespace: options.namespace,
    serviceAccount: serviceAccountName,
    serviceName: deploy.deployable.name,
    buildUUID: build.uuid,
    isStatic: build.isStatic,
    gitUsername: GIT_USERNAME,
    gitToken,
    cloneScript,
    containers: [helmContainer],
    volumes: volumeConfig.volumes,
    deployMetadata,
    includeGitClone: shouldIncludeGitClone,
  });

  return yaml.dump(job);
}

export async function nativeHelmDeploy(deploy: Deploy, options: HelmDeployOptions): Promise<JobResult> {
  await deploy.$fetchGraph('build.pullRequest.repository');
  await deploy.$fetchGraph('deployable.repository');

  const jobId = randomAlphanumeric(4).toLowerCase();
  const { namespace } = options;
  const releaseName = deploy.uuid.toLowerCase();

  await resolveHelmReleaseConflicts(releaseName, namespace);

  await ensureServiceAccountForJob(options.namespace, 'deploy');

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const manifest = await generateHelmManifest(deploy, jobId, options);

  const shortSha = deploy.sha ? deploy.sha.substring(0, 7) : 'no-sha';
  let jobName = `${deploy.uuid}-deploy-${jobId}-${shortSha}`.substring(0, 63);
  if (jobName.endsWith('-')) {
    jobName = jobName.slice(0, -1);
  }

  const localPath = `${MANIFEST_PATH}/helm/${deploy.uuid}-helm-${shortSha}`;
  await fs.promises.mkdir(`${MANIFEST_PATH}/helm/`, { recursive: true });
  await fs.promises.writeFile(localPath, manifest, 'utf8');
  await shellPromise(`kubectl apply -f ${localPath}`);

  const jobResult = await waitForJobAndGetLogs(jobName, options.namespace, `[HELM ${deploy.uuid}]`);

  await deploy.$query().patch({ buildOutput: jobResult.logs });

  return {
    completed: jobResult.success,
    logs: jobResult.logs,
    status: jobResult.status || (jobResult.success ? 'succeeded' : 'failed'),
  };
}

export async function shouldUseNativeHelm(deploy: Deploy): Promise<boolean> {
  if (deploy.deployable.helm?.deploymentMethod) {
    return deploy.deployable.helm.deploymentMethod === 'native';
  }

  if (deploy.deployable.helm?.nativeHelm?.enabled) {
    return true;
  }

  return false;
}

export async function deployNativeHelm(deploy: Deploy): Promise<void> {
  logger.info(`[HELM ${deploy.uuid}] Starting native helm deployment`);

  const { deployable, build } = deploy;

  if (deploy?.kedaScaleToZero?.type === 'http' && !build.isStatic) {
    await applyHttpScaleObjectManifestYaml(deploy, build.namespace);
    await applyExternalServiceManifestYaml(deploy, build.namespace);
  }

  const validationErrors = await validateHelmConfiguration(deploy);
  if (validationErrors.length > 0) {
    throw new Error(`Native helm configuration validation failed: ${validationErrors.join(', ')}`);
  }

  const jobResult = await nativeHelmDeploy(deploy, {
    namespace: build.namespace,
  });

  if (jobResult.status !== 'succeeded') {
    throw new Error(`Native helm deployment failed: ${jobResult.logs}`);
  }

  const { helm } = deployable;

  try {
    if (helm?.envLens) {
      await patchIngress(deploy.uuid, ingressBannerSnippet(deploy), build.namespace);
    }
  } catch (error) {
    logger.warn(`[DEPLOY ${deploy.uuid}] Unable to patch ingress: ${error}`);
  }

  if (deploy?.kedaScaleToZero?.type === 'http' && !build.isStatic) {
    const { domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
    await fetchUntilSuccess(
      `https://${deploy.uuid}.${domainDefaults.http}`,
      deploy.kedaScaleToZero.maxRetries,
      deploy.uuid,
      build.namespace
    );
  }
}

async function deployCodefreshHelm(deploy: Deploy, deployService: DeployService, runUUID: string): Promise<void> {
  const { deployable, build } = deploy;

  if (deploy?.kedaScaleToZero?.type === 'http' && !build.isStatic) {
    await applyHttpScaleObjectManifestYaml(deploy, build.namespace);
    await applyExternalServiceManifestYaml(deploy, build.namespace);
  }

  const { generateCodefreshRunCommand } = await import('server/lib/helm/helm');
  const { getCodefreshPipelineIdFromOutput } = await import('server/lib/codefresh/utils');
  const { checkPipelineStatus } = await import('server/lib/codefresh');

  const codefreshRunCommand = await generateCodefreshRunCommand(deploy);
  const output = await shellPromise(codefreshRunCommand);
  const deployPipelineId = getCodefreshPipelineIdFromOutput(output);

  const statusMessage = 'Starting deployment via Helm';
  logger.info(`[DEPLOY ${deploy.uuid}] Deploying via codefresh build: ${deployPipelineId}`);

  await deployService.patchAndUpdateActivityFeed(
    deploy,
    {
      deployPipelineId,
      statusMessage,
    },
    runUUID
  );

  await checkPipelineStatus(deployPipelineId)();

  const { helm } = deployable;

  try {
    if (helm?.envLens) {
      await patchIngress(deploy.uuid, ingressBannerSnippet(deploy), build.namespace);
    }
  } catch (error) {
    logger.warn(`[DEPLOY ${deploy.uuid}] Unable to patch ingress: ${error}`);
  }

  if (deploy?.kedaScaleToZero?.type === 'http' && !build.isStatic) {
    const { domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
    await fetchUntilSuccess(
      `https://${deploy.uuid}.${domainDefaults.http}`,
      deploy.kedaScaleToZero.maxRetries,
      deploy.uuid,
      build.namespace
    );
  }
}

export async function deployHelm(deploys: Deploy[]): Promise<void> {
  logger.info(`[DEPLOY ${deploys.map((d) => d.uuid).join(', ')}] Deploying with helm`);

  if (deploys?.length === 0) return;

  await Promise.all(
    deploys.map(async (deploy) => {
      const startTime = Date.now();
      const runUUID = deploy.runUUID ?? nanoid();
      const deployService = new DeployService();

      try {
        const useNative = await shouldUseNativeHelm(deploy);
        const method = useNative ? 'Native Helm' : 'Codefresh Helm';

        logger.info(`[DEPLOY ${deploy.uuid}] Using ${method} deployment`);

        await deployService.patchAndUpdateActivityFeed(
          deploy,
          {
            status: DeployStatus.DEPLOYING,
            statusMessage: `Deploying via ${method}`,
          },
          runUUID
        );

        if (useNative) {
          await deployNativeHelm(deploy);
        } else {
          await deployCodefreshHelm(deploy, deployService, runUUID);
        }

        await deployService.patchAndUpdateActivityFeed(
          deploy,
          {
            status: DeployStatus.READY,
            statusMessage: `Successfully deployed via ${method}`,
          },
          runUUID
        );

        await trackHelmDeploymentMetrics(deploy, 'success', Date.now() - startTime);
      } catch (error) {
        await trackHelmDeploymentMetrics(deploy, 'failure', Date.now() - startTime, error.message);

        await deployService.patchAndUpdateActivityFeed(
          deploy,
          {
            status: DeployStatus.DEPLOY_FAILED,
            statusMessage: `Helm deployment failed: ${error.message}`,
          },
          runUUID
        );

        throw error;
      }
    })
  );
}

export async function trackHelmDeploymentMetrics(
  deploy: Deploy,
  result: 'success' | 'failure',
  duration: number,
  error?: string
): Promise<void> {
  const buildData = await constructHelmDeploysBuildMetaData([deploy]);
  const metrics = new Metrics('build.deploy.native-helm', buildData);

  const chartType = await determineChartType(deploy);

  metrics.increment('total', {
    deployUUID: deploy.uuid,
    result: result === 'success' ? 'complete' : 'error',
    error: error || '',
    chartType,
    method: 'native',
    durationMs: duration.toString(),
  });

  const eventDetails = {
    title: 'Native Helm Deploy Finished',
    description: `${buildData?.uuid} native helm deploy ${deploy?.uuid} has finished for ${buildData?.fullName}${
      buildData?.branchName ? ` on branch ${buildData.branchName}` : ''
    } (duration: ${duration}ms)`,
  };

  metrics.event(eventDetails.title, eventDetails.description);
}
