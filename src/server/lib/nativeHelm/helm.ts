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
import Deployable from 'server/models/Deployable';
import GlobalConfigService from 'server/services/globalConfig';
import { getLogger, withSpan, withLogContext } from 'server/lib/logger';
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
  HelmPostRendererConfig,
  determineChartType,
  getHelmConfiguration,
  generateHelmInstallScript,
  validateHelmConfiguration,
} from './utils';
import { detectRegistryAuth, RegistryAuthConfig } from './registryAuth';
import { HELM_IMAGE_PREFIX, HELM_WAIT_IMAGE, HELM_WAIT_TIMEOUT_SECONDS } from './constants';
import { buildDeployJobName } from 'server/lib/kubernetes/jobNames';
import {
  createCloneScript,
  waitForJobAndGetLogs,
  getGitHubToken,
  GIT_USERNAME,
  MANIFEST_PATH,
} from 'server/lib/nativeBuild/utils';
import { createHelmJob as createHelmJobFromFactory } from 'server/lib/kubernetes/jobFactory';
import { ensureServiceAccountForJob } from 'server/lib/kubernetes/common/serviceAccount';
import { getLogArchivalService } from 'server/services/logArchival';

export interface JobResult {
  completed: boolean;
  logs: string;
  status: string;
}

function requireDeployable(deploy: Deploy): Deployable {
  if (!deploy.deployable) {
    throw new Error(`Deployable missing for deploy ${deploy.uuid}`);
  }

  return deploy.deployable;
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
  serviceName: string,
  jobName: string,
  args?: string,
  chartRepoUrl?: string,
  defaultArgs?: string,
  chartVersion?: string,
  registryAuth?: RegistryAuthConfig,
  helmImage?: string,
  postRenderer?: HelmPostRendererConfig
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
    defaultArgs,
    chartVersion,
    registryAuth,
    postRenderer
  );

  return {
    name: 'helm-deploy',
    image: helmImage || `${HELM_IMAGE_PREFIX}:${helmVersion}`,
    env: [
      { name: 'HELM_CACHE_HOME', value: '/workspace/.helm/cache' },
      { name: 'HELM_CONFIG_HOME', value: '/workspace/.helm/config' },
      { name: 'HELM_EXPERIMENTAL_OCI', value: '1' },
      { name: 'LC_SERVICE_NAME', value: serviceName },
      { name: 'LC_JOB_NAME', value: jobName },
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

export function createWaitForPriorDeploysInitContainer(namespace: string, serviceName: string, jobName: string): any {
  const script = [
    'set -euo pipefail',
    `echo "Checking for prior deploy jobs for service=${serviceName}"`,
    `MY_CREATED=$(kubectl get job ${jobName} -n ${namespace} -o jsonpath='{.metadata.creationTimestamp}')`,
    `WAIT_TIMEOUT=${HELM_WAIT_TIMEOUT_SECONDS}`,
    'POLL_INTERVAL=10',
    'wait_start=$(date +%s)',
    'while true; do',
    '  elapsed=$(( $(date +%s) - wait_start ))',
    '  if [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then',
    '    echo "ERROR: Timed out after ${WAIT_TIMEOUT}s waiting for prior deploy jobs to complete"',
    '    exit 1',
    '  fi',
    '',
    `  blocking_jobs=$(kubectl get jobs -n ${namespace} -l "service=${serviceName},app.kubernetes.io/name=native-helm" -o jsonpath='{range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.status.active}{"\\n"}{end}' | awk -v my_name="${jobName}" -v my_ts="$MY_CREATED" '`,
    '    BEGIN { result = "" }',
    '    $1 != my_name && (($2 < my_ts) || ($2 == my_ts && $1 < my_name)) && ($3 + 0) > 0 {',
    '      result = result (result ? " " : "") $1',
    '    }',
    `    END { print result }')`,
    '',
    '  if [ -z "$blocking_jobs" ]; then',
    '    echo "No prior deploy jobs in progress, proceeding"',
    '    break',
    '  fi',
    '',
    '  echo "Waiting for prior deploy jobs to complete: $blocking_jobs (${elapsed}s/${WAIT_TIMEOUT}s)"',
    '  sleep $POLL_INTERVAL',
    'done',
  ].join('\n');

  return {
    name: 'wait-for-prior-deploys',
    image: HELM_WAIT_IMAGE,
    command: ['/bin/bash', '-c'],
    args: [script],
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
  };
}

export async function generateHelmManifest(
  deploy: Deploy,
  jobName: string,
  options: HelmDeployOptions
): Promise<string> {
  await deploy.$fetchGraph('deployable.repository');
  await deploy.$fetchGraph('build');

  const deployable = requireDeployable(deploy);
  const { build } = deploy;
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
  const chartVersion = mergedHelmConfig.chart?.version;
  const helmArgs = mergedHelmConfig.args;
  const defaultArgs = mergedHelmConfig.nativeHelm?.defaultArgs;
  const registryAuth = detectRegistryAuth(chartRepoUrl);
  const helmImage = mergedHelmConfig.nativeHelm?.image;
  const postRenderer = mergedHelmConfig.nativeHelm?.postRenderer;
  const waitForPriorDeploys = createWaitForPriorDeploysInitContainer(options.namespace, deployable.name, jobName);

  const helmContainer = await createHelmContainer(
    repository?.fullName || 'no-repo',
    helmConfig.chartPath,
    helmConfig.releaseName,
    options.namespace,
    helmConfig.helmVersion,
    helmConfig.customValues,
    helmConfig.valuesFiles,
    helmConfig.chartType,
    deployable.name,
    jobName,
    helmArgs,
    chartRepoUrl,
    defaultArgs,
    chartVersion,
    registryAuth,
    helmImage,
    postRenderer
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
    serviceName: deployable.name,
    buildUUID: build.uuid,
    isStatic: build.isStatic,
    gitUsername: GIT_USERNAME,
    gitToken,
    cloneScript,
    initContainers: [waitForPriorDeploys],
    containers: [helmContainer],
    volumes: volumeConfig.volumes,
    deployMetadata,
    includeGitClone: shouldIncludeGitClone,
    registryAuth,
  });

  return yaml.dump(job);
}

export async function nativeHelmDeploy(deploy: Deploy, options: HelmDeployOptions): Promise<JobResult> {
  await deploy.$fetchGraph('build.pullRequest.repository');
  await deploy.$fetchGraph('deployable.repository');

  const deployable = requireDeployable(deploy);
  const jobId = randomAlphanumeric(4).toLowerCase();
  const { namespace } = options;

  await ensureServiceAccountForJob(namespace, 'deploy');

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const shortSha = deploy.sha ? deploy.sha.substring(0, 7) : 'no-sha';
  const jobName = buildDeployJobName({
    deployUuid: deploy.uuid,
    jobId,
    shortSha,
  });
  const manifest = await generateHelmManifest(deploy, jobName, options);

  const localPath = `${MANIFEST_PATH}/helm/${deploy.uuid}-helm-${shortSha}`;
  await fs.promises.mkdir(`${MANIFEST_PATH}/helm/`, { recursive: true });
  await fs.promises.writeFile(localPath, manifest, 'utf8');
  await shellPromise(`kubectl apply -f ${localPath}`);

  const jobResult = await waitForJobAndGetLogs(jobName, namespace, `[HELM ${deploy.uuid}]`);

  await deploy.$query().patch({ buildOutput: jobResult.logs });

  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  if (globalConfig.logArchival?.enabled) {
    try {
      const archivalService = getLogArchivalService();
      await archivalService.archiveLogs(
        {
          jobName,
          jobType: 'deploy',
          serviceName: deployable.name,
          namespace,
          status: jobResult.success ? 'Complete' : 'Failed',
          sha: deploy.sha || '',
          deployUuid: deploy.uuid,
          deploymentType: 'helm',
          startedAt: jobResult.startedAt,
          completedAt: jobResult.completedAt,
          duration: jobResult.duration,
          archivedAt: new Date().toISOString(),
        },
        jobResult.logs
      );
    } catch (archiveError) {
      getLogger().warn({ error: archiveError }, `LogArchival: failed to archive deploy logs jobName=${jobName}`);
    }
  }

  return {
    completed: jobResult.success,
    logs: jobResult.logs,
    status: jobResult.status || (jobResult.success ? 'succeeded' : 'failed'),
  };
}

export async function shouldUseNativeHelm(deploy: Deploy): Promise<boolean> {
  const deployable = deploy.deployable;
  if (!deployable) {
    return false;
  }

  if (deployable.helm?.deploymentMethod) {
    return deployable.helm.deploymentMethod === 'native';
  }

  if (deployable.helm?.nativeHelm?.enabled) {
    return true;
  }

  return false;
}

export async function deployNativeHelm(deploy: Deploy): Promise<void> {
  const deployable = requireDeployable(deploy);
  const { build } = deploy;

  getLogger().info('Helm: deploying method=native');

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
    let errorMessage = 'Deployment failed';
    if (jobResult.logs?.includes('timed out waiting for the condition')) {
      errorMessage +=
        ': Helm upgrade timed out. The deployed pods are not in a healthy state. Check Console > Pods for details';
    }
    throw new Error(errorMessage);
  }

  const { helm } = deployable;

  try {
    if (helm?.envLens) {
      await patchIngress(deploy.uuid, ingressBannerSnippet(deploy), build.namespace);
    }
  } catch (error) {
    getLogger().warn(
      {
        error,
      },
      'Unable to patch ingress'
    );
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
  const deployable = requireDeployable(deploy);
  const { build } = deploy;

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
  getLogger().info(`Helm: deploying method=codefresh`);

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
    getLogger().warn(
      {
        error,
      },
      'Unable to patch ingress'
    );
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
  if (deploys?.length === 0) return;

  getLogger().info(`Helm: deploying services=${deploys.map((d) => d.deployable?.name || d.uuid).join(',')}`);

  await Promise.all(
    deploys.map(async (deploy) => {
      return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () => {
        return withSpan(
          'lifecycle.helm.deploy',
          async () => {
            const startTime = Date.now();
            const runUUID = deploy.runUUID ?? nanoid();
            const deployService = new DeployService();

            try {
              const useNative = await shouldUseNativeHelm(deploy);
              const method = useNative ? 'Native Helm' : 'Codefresh Helm';

              getLogger().debug(`Using ${method}`);

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
                  statusMessage: error.message.includes('timed out')
                    ? error.message
                    : `${error.message}. Check deploy logs in Console > Deploy tab for details.`,
                },
                runUUID
              );

              throw error;
            }
          },
          { resource: deploy.uuid, tags: { 'deploy.uuid': deploy.uuid } }
        );
      });
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
