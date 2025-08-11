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

import Deploy from 'server/models/Deploy';
import GlobalConfigService from 'server/services/globalConfig';
import { ChartType, REPO_MAPPINGS, STATIC_ENV_JOB_TTL_SECONDS, HELM_JOB_TIMEOUT_SECONDS } from './constants';
import { mergeKeyValueArrays, getResourceType } from 'shared/utils';
import { merge } from 'lodash';
import { renderTemplate, generateTolerationsCustomValues, generateNodeSelector } from 'server/lib/helm/utils';
import {
  createServiceAccountUsingExistingFunction,
  setupDeployServiceAccountInNamespace,
} from 'server/lib/kubernetes/rbac';
import { HelmConfigBuilder } from 'server/lib/config/ConfigBuilder';
import rootLogger from 'server/lib/logger';
import { shellPromise } from 'server/lib/shell';
import { normalizeKubernetesLabelValue } from 'server/lib/kubernetes/utils';

const logger = rootLogger.child({
  filename: 'lib/nativeHelm/utils.ts',
});

export interface HelmReleaseState {
  status: 'deployed' | 'pending-install' | 'pending-upgrade' | 'pending-rollback' | 'failed' | 'unknown';
  revision: number;
  description: string;
}

export async function getHelmReleaseStatus(releaseName: string, namespace: string): Promise<HelmReleaseState | null> {
  try {
    const helmStatusOutput = await shellPromise(`helm status ${releaseName} -n ${namespace} --output json`);
    const status = JSON.parse(helmStatusOutput);

    return {
      status: status.info?.status || 'unknown',
      revision: status.version || 0,
      description: status.info?.description || '',
    };
  } catch (error) {
    if (error.message?.includes('release: not found')) {
      return null;
    }
    logger.warn(`[HELM] Failed to get status for release ${releaseName}: ${error.message}`);
    return null;
  }
}

export async function isReleaseBlocked(releaseState: HelmReleaseState | null): Promise<boolean> {
  if (!releaseState) return false;

  const blockedStates = ['pending-install', 'pending-upgrade', 'pending-rollback'];
  return blockedStates.includes(releaseState.status);
}

export async function uninstallHelmRelease(releaseName: string, namespace: string): Promise<void> {
  logger.info(`[HELM] Uninstalling release ${releaseName} in namespace ${namespace}`);

  try {
    await shellPromise(`helm uninstall ${releaseName} -n ${namespace} --wait --timeout 5m`);
    logger.info(`[HELM] Successfully uninstalled release ${releaseName}`);
  } catch (error) {
    if (error.message?.includes('release: not found')) {
      logger.info(`[HELM] Release ${releaseName} not found, nothing to uninstall`);
      return;
    }
    throw error;
  }
}

export async function killHelmJobsAndPods(releaseName: string, namespace: string): Promise<void> {
  logger.info(`[HELM ${releaseName}] Checking for existing helm jobs`);

  try {
    const existingJobs = await shellPromise(
      `kubectl get jobs -n ${namespace} -l lc-uuid=${releaseName},app.kubernetes.io/name=native-helm -o json`
    );
    const jobsData = JSON.parse(existingJobs);

    if (jobsData.items && jobsData.items.length > 0) {
      logger.warn(`[HELM ${releaseName}] Found ${jobsData.items.length} existing job(s), terminating`);

      for (const job of jobsData.items) {
        const jobName = job.metadata.name;

        try {
          await shellPromise(
            `kubectl annotate job ${jobName} -n ${namespace} ` +
              `lifecycle.goodrx.com/termination-reason=superseded-by-retry ` +
              `lifecycle.goodrx.com/termination-time="${new Date().toISOString()}" ` +
              `--overwrite`
          );
        } catch (annotateError) {
          logger.warn(`[HELM ${releaseName}] Failed to annotate job ${jobName}: ${annotateError.message}`);
        }

        const podsOutput = await shellPromise(`kubectl get pods -n ${namespace} -l job-name=${jobName} -o json`);
        const podsData = JSON.parse(podsOutput);

        if (podsData.items && podsData.items.length > 0) {
          for (const pod of podsData.items) {
            const podName = pod.metadata.name;
            try {
              await shellPromise(`kubectl delete pod ${podName} -n ${namespace} --force --grace-period=0`);
            } catch (podError) {
              logger.warn(`[HELM ${releaseName}] Failed to delete pod ${podName}: ${podError.message}`);
            }
          }
        }

        try {
          await shellPromise(`kubectl delete job ${jobName} -n ${namespace} --force --grace-period=0`);
        } catch (jobError) {
          logger.warn(`[HELM ${releaseName}] Failed to delete job ${jobName}: ${jobError.message}`);
        }
      }
    }
  } catch (error) {
    logger.warn(`[HELM ${releaseName}] Error checking for existing jobs: ${error.message}`);
  }
}

export async function resolveHelmReleaseConflicts(releaseName: string, namespace: string): Promise<void> {
  logger.info(`[HELM ${releaseName}] Resolving release conflicts`);

  await killHelmJobsAndPods(releaseName, namespace);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const releaseState = await getHelmReleaseStatus(releaseName, namespace);

  if (!releaseState) {
    return;
  }

  if (await isReleaseBlocked(releaseState)) {
    logger.warn(`[HELM ${releaseName}] Release blocked (${releaseState.status}), uninstalling`);

    await uninstallHelmRelease(releaseName, namespace);

    const maxWaitTime = 30000;
    const pollInterval = 2000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const currentState = await getHelmReleaseStatus(releaseName, namespace);
      if (!currentState) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Helm release ${releaseName} uninstall timed out after ${maxWaitTime / 1000} seconds`);
  }
}

export async function checkIfJobWasSuperseded(jobName: string, namespace: string): Promise<boolean> {
  try {
    const annotations = await shellPromise(
      `kubectl get job ${jobName} -n ${namespace} ` +
        `-o jsonpath='{.metadata.annotations.lifecycle\\.goodrx\\.com/termination-reason}'`
    );

    return annotations === 'superseded-by-retry';
  } catch (error) {
    logger.debug(`Could not check job supersession status for ${jobName}: ${error.message}`);
    return false;
  }
}

export interface HelmDeployOptions {
  namespace: string;
  deploymentMethod?: 'native' | 'ci';
}

export interface HelmConfiguration {
  chartType: ChartType;
  customValues: string[];
  valuesFiles: string[];
  chartPath: string;
  releaseName: string;
  helmVersion: string;
}

export function constructHelmCommand(
  action: string,
  chartPath: string,
  releaseName: string,
  namespace: string,
  customValues: string[],
  valuesFiles: string[],
  chartType: ChartType,
  args?: string,
  chartRepoUrl?: string,
  defaultArgs?: string
): string {
  let command = `helm ${action} ${releaseName}`;

  if (chartType === ChartType.LOCAL) {
    const normalizedPath = chartPath.startsWith('./') || chartPath.startsWith('../') ? chartPath : `./${chartPath}`;
    command += ` ${normalizedPath}`;
  } else if (chartType === ChartType.PUBLIC) {
    const isOciChart = chartRepoUrl?.startsWith('oci://');

    if (isOciChart) {
      command += ` ${chartRepoUrl}`;
    } else if (chartPath.includes('/')) {
      command += ` ${chartPath}`;
    } else if (chartRepoUrl) {
      const repoAlias = getRepoAliasFromUrl(chartRepoUrl);
      command += ` ${repoAlias}/${chartPath}`;
    } else {
      command += ` ${chartPath}`;
    }
  } else {
    command += ` ${chartPath}`;
  }

  command += ` --namespace ${namespace}`;

  customValues.forEach((value) => {
    const equalIndex = value.indexOf('=');
    if (equalIndex > -1) {
      const key = value.substring(0, equalIndex);
      const val = value.substring(equalIndex + 1);
      const escapedVal = escapeHelmValue(val);
      command += ` --set "${key}=${escapedVal}"`;
    } else {
      command += ` --set "${value}"`;
    }
  });

  valuesFiles.forEach((file) => {
    if (chartType === ChartType.LOCAL) {
      const normalizedFile = file.startsWith('./') || file.startsWith('../') ? file : `./${file}`;
      command += ` -f ${normalizedFile}`;
    } else {
      command += ` -f ${file}`;
    }
  });
  const allArgs = [defaultArgs, args].filter(Boolean).join(' ');
  if (allArgs) {
    command += ` ${allArgs}`;
  }

  return command;
}

export function generateHelmInstallScript(
  repoName: string,
  chartPath: string,
  releaseName: string,
  namespace: string,
  customValues: string[],
  valuesFiles: string[],
  chartType: ChartType,
  args?: string,
  chartRepoUrl?: string,
  defaultArgs?: string
): string {
  const helmCommand = constructHelmCommand(
    'upgrade --install',
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

  let script = `
set -e
echo "Starting helm deployment for ${releaseName}"

`;

  if (repoName !== 'no-repo' && repoName.includes('/')) {
    script += `cd /workspace
echo "Current directory: $(pwd)"
echo "Directory contents:"
ls -la

`;
  }

  if (chartType === ChartType.PUBLIC) {
    const isOciChart = chartRepoUrl?.startsWith('oci://');

    if (!isOciChart) {
      if (chartPath.includes('/')) {
        const [repoName] = chartPath.split('/');
        const repoUrl = getRepoUrl(repoName);
        script += `
echo "Adding helm repository ${repoName}: ${repoUrl}"
helm repo add ${repoName} ${repoUrl}
helm repo update
`;
      } else if (chartRepoUrl) {
        const repoAlias = getRepoAliasFromUrl(chartRepoUrl);
        script += `
echo "Adding helm repository ${repoAlias}: ${chartRepoUrl}"
helm repo add ${repoAlias} ${chartRepoUrl}
helm repo update
`;
      }
    }
  }

  script += `
echo "Executing: ${helmCommand}"
${helmCommand}

echo "Helm deployment completed successfully"
`;

  return script.trim();
}

export async function getHelmConfiguration(deploy: Deploy): Promise<HelmConfiguration> {
  const mergedHelmConfig = await mergeHelmConfigWithGlobal(deploy);

  const chartType = await determineChartType(deploy);
  const customValues = await constructHelmCustomValues(deploy, chartType);

  const helmVersion = mergedHelmConfig.version || mergedHelmConfig.nativeHelm?.defaultHelmVersion || '3.12.0';

  return {
    chartType,
    customValues,
    valuesFiles: mergedHelmConfig.chart?.valueFiles || [],
    chartPath: mergedHelmConfig.chart?.name || 'local',
    releaseName: deploy.uuid.toLowerCase(),
    helmVersion,
  };
}

export async function mergeHelmConfigWithGlobal(deploy: Deploy): Promise<any> {
  const { deployable } = deploy;
  const helm: any = deployable.helm || {};
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  const chartName = helm?.chart?.name;

  const globalConfig = configs[chartName];
  if (!globalConfig) {
    return helm;
  }

  // Use builder pattern for cleaner configuration merging
  const builder = new HelmConfigBuilder(helm);

  // Apply global config with proper precedence
  if (globalConfig.version && !helm.version) {
    builder.set('helmVersion', globalConfig.version);
  }
  if (globalConfig.args && !helm.args) {
    builder.set('args', globalConfig.args);
  }

  // Build merged config with original structure
  const mergedConfig = {
    ...helm,

    ...(globalConfig.version && { version: globalConfig.version }),
    ...(globalConfig.args && { args: globalConfig.args }),
    ...(globalConfig.action && { action: globalConfig.action }),

    label: globalConfig.label,
    tolerations: globalConfig.tolerations,
    affinity: globalConfig.affinity,
    nodeSelector: globalConfig.nodeSelector,

    grpc: helm.grpc,
    disableIngressHost: helm.disableIngressHost,
    deploymentMethod: helm.deploymentMethod,
    nativeHelm: helm.nativeHelm,
    type: helm.type,
    docker: helm.docker,
    envMapping: helm.envMapping,

    ...(helm.version && { version: helm.version }),
    ...(helm.args && { args: helm.args }),
    ...(helm.action && { action: helm.action }),
  };

  if (globalConfig.chart || helm.chart) {
    mergedConfig.chart = mergeChartConfig(helm.chart, globalConfig.chart);
  }

  return mergedConfig;
}

function mergeChartConfig(helmChart: any, globalChart: any): any {
  return {
    ...(helmChart || {}),

    ...(globalChart || {}),

    ...(helmChart?.name && { name: helmChart.name }),
    ...(helmChart?.repoUrl && { repoUrl: helmChart.repoUrl }),
    ...(helmChart?.version && { version: helmChart.version }),

    values:
      helmChart?.values && helmChart.values.length > 0
        ? mergeKeyValueArrays(globalChart?.values || [], helmChart.values, '=')
        : globalChart?.values || helmChart?.values || [],

    valueFiles:
      helmChart?.valueFiles && helmChart.valueFiles.length > 0
        ? helmChart.valueFiles
        : globalChart?.valueFiles || helmChart?.valueFiles || [],
  };
}

export async function setupServiceAccountInNamespace(
  namespace: string,
  serviceAccountName: string,
  role: string
): Promise<void> {
  await createServiceAccountUsingExistingFunction(namespace, serviceAccountName, role);
  await setupDeployServiceAccountInNamespace(namespace, serviceAccountName, role);
  logger.info(`[RBAC] Setup complete for '${serviceAccountName}' in ${namespace}`);
}

export async function createNamespacedRoleAndBinding(namespace: string, serviceAccountName: string): Promise<void> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);

  const roleName = 'native-helm-role';
  const roleBindingName = `native-helm-binding-${serviceAccountName}`;

  const role = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: {
      name: roleName,
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'native-helm',
        'app.kubernetes.io/component': 'rbac',
      },
    },
    rules: [
      {
        apiGroups: ['*'],
        resources: ['*'],
        verbs: ['*'],
      },
    ],
  };

  const roleBinding = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: roleBindingName,
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'native-helm',
        'app.kubernetes.io/component': 'rbac',
      },
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: serviceAccountName,
        namespace: namespace,
      },
    ],
    roleRef: {
      kind: 'Role',
      name: roleName,
      apiGroup: 'rbac.authorization.k8s.io',
    },
  };

  try {
    logger.info(`[NS ${namespace}] Creating Role and RoleBinding for: ${serviceAccountName}`);

    try {
      await rbacApi.readNamespacedRole(roleName, namespace);
      await rbacApi.replaceNamespacedRole(roleName, namespace, role);
    } catch (error) {
      if (error?.response?.statusCode === 404) {
        await rbacApi.createNamespacedRole(namespace, role);
      } else {
        throw error;
      }
    }

    try {
      await rbacApi.readNamespacedRoleBinding(roleBindingName, namespace);
      await rbacApi.replaceNamespacedRoleBinding(roleBindingName, namespace, roleBinding);
    } catch (error) {
      if (error?.response?.statusCode === 404) {
        await rbacApi.createNamespacedRoleBinding(namespace, roleBinding);
      } else {
        throw error;
      }
    }

    try {
      await rbacApi.readNamespacedRole(roleName, namespace);
      await rbacApi.readNamespacedRoleBinding(roleBindingName, namespace);
    } catch (verifyError) {
      logger.error(`[NS ${namespace}] Failed to verify RBAC resources:`, verifyError.message);
    }
  } catch (error) {
    logger.warn(error);
    logger.error(`[NS ${namespace}] Error creating namespace-scoped RBAC:`, {
      error,
      statusCode: error?.response?.statusCode,
      statusMessage: error?.response?.statusMessage,
      body: error?.response?.body,
      serviceAccountName,
      namespace,
      roleName,
      roleBindingName,
    });

    logger.warn(
      `[NS ${namespace}] ⚠️ RBAC setup failed, helm deployment may have permission issues. Consider updating lifecycle-app service account permissions to allow Role/RoleBinding creation.`
    );
  }
}

export function calculateJobTTL(isStatic: boolean): number | undefined {
  if (isStatic) {
    return STATIC_ENV_JOB_TTL_SECONDS;
  }
  return undefined;
}

export function createHelmJob(
  name: string,
  namespace: string,
  gitUsername: string,
  gitToken: string,
  cloneScript: string,
  containers: any[],
  volumeConfig: any,
  isStatic: boolean,
  serviceAccountName: string = 'default',
  serviceName: string,
  buildUUID: string,
  deployMetadata?: {
    sha: string;
    branch: string;
    deployId?: string;
    deployableId: string;
  },
  includeGitClone: boolean = true
): any {
  const ttl = calculateJobTTL(isStatic);

  const labels: Record<string, string> = {
    'app.kubernetes.io/name': 'native-helm',
    'app.kubernetes.io/component': 'deployment',
    'lc-uuid': buildUUID,
    service: serviceName,
  };

  if (deployMetadata) {
    labels['git-sha'] = deployMetadata.sha;
    labels['git-branch'] = normalizeKubernetesLabelValue(deployMetadata.branch);
    labels['deploy-id'] = deployMetadata.deployId || '';
    labels['deployable-id'] = deployMetadata.deployableId;
  }

  const jobSpec: any = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace,
      labels,
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: HELM_JOB_TIMEOUT_SECONDS,
      ...(ttl && { ttlSecondsAfterFinished: ttl }),
      template: {
        spec: {
          serviceAccountName,
          terminationGracePeriodSeconds: 300,
          tolerations: [
            {
              key: 'builder',
              operator: 'Equal',
              value: 'yes',
              effect: 'NoSchedule',
            },
          ],
          containers: containers.map((container) => ({
            ...container,
            resources: {
              requests: {
                cpu: '200m',
                memory: '256Mi',
              },
              limits: {
                cpu: '1000m',
                memory: '1Gi',
              },
            },
          })),
          restartPolicy: 'Never',
          volumes: volumeConfig.volumes,
        },
      },
    },
  };

  if (includeGitClone) {
    jobSpec.spec.template.spec.initContainers = [
      {
        name: 'clone-repo',
        image: 'alpine/git:latest',
        env: [
          {
            name: 'GIT_USERNAME',
            value: gitUsername,
          },
          {
            name: 'GIT_PASSWORD',
            value: gitToken,
          },
        ],
        command: ['/bin/sh', '-c'],
        args: [cloneScript],
        resources: {
          requests: {
            cpu: '100m',
            memory: '128Mi',
          },
          limits: {
            cpu: '500m',
            memory: '512Mi',
          },
        },
        volumeMounts: [
          {
            name: volumeConfig.workspaceName,
            mountPath: '/workspace',
          },
        ],
      },
    ];
  }

  return jobSpec;
}

export async function constructHelmCustomValues(deploy: Deploy, chartType: ChartType): Promise<string[]> {
  let customValues: string[] = [];
  const { deployable, build } = deploy;

  const helm = await mergeHelmConfigWithGlobal(deploy);
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  const chartName = helm?.chart?.name;

  if (chartType === ChartType.ORG_CHART) {
    const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();
    const initEnvVars = merge(deploy.initEnv || {}, build.commentRuntimeEnv || {});
    const appEnvVars = merge(deploy.env, build.commentRuntimeEnv || {});
    const resourceType = getResourceType(helm?.type);

    const partialCustomValues = mergeKeyValueArrays(
      configs[orgChartName]?.chart?.values || [],
      helm?.chart?.values || [],
      '='
    );
    const templateResolvedValues = await renderTemplate(deploy.build, partialCustomValues);
    customValues = templateResolvedValues;

    if (deploy.dockerImage) {
      const version = constructImageVersion(deploy.dockerImage);
      customValues.push(`${resourceType}.appImage=${deploy.dockerImage}`, `version=${version}`);
    }

    if (deploy.initDockerImage) {
      const initVersion = constructImageVersion(deploy.initDockerImage);
      customValues.push(
        `${resourceType}.initImage=${deploy.initDockerImage}`,
        `${resourceType}.version=${initVersion}`
      );
      Object.entries(initEnvVars).forEach(([key, value]) => {
        customValues.push(`${resourceType}.initEnv.${key.replace(/_/g, '__')}=${value}`);
      });
    } else {
      customValues.push(`${resourceType}.disableInit=true`);
    }

    Object.entries(appEnvVars).forEach(([key, value]) => {
      customValues.push(`${resourceType}.env.${key.replace(/_/g, '__')}="${value}"`);
    });

    customValues.push(
      `env=lifecycle-${deployable.buildUUID}`,
      `${resourceType}.enableServiceLinks=disabled`,
      `lc__uuid=${deployable.buildUUID}`
    );

    if (build?.isStatic) {
      customValues.push(
        `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=eks.amazonaws.com/capacityType`,
        `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In`,
        `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=ON_DEMAND`,
        `${resourceType}.tolerations[0].key=static_env`,
        `${resourceType}.tolerations[0].operator=Equal`,
        `${resourceType}.tolerations[0].value=yes`,
        `${resourceType}.tolerations[0].effect=NoSchedule`
      );
    }
  } else if (chartType === ChartType.PUBLIC) {
    const templateResolvedValues = await renderTemplate(deploy.build, helm?.chart?.values || []);
    customValues = mergeKeyValueArrays(configs[chartName]?.chart?.values || [], templateResolvedValues, '=');

    const customLabels = [];
    if (configs[chartName]?.label) {
      customLabels.push(
        `${configs[chartName].label}.name=${deployable.buildUUID}`,
        `${configs[chartName].label}.lc__uuid=${deployable.buildUUID}`
      );
    }

    customValues.push(
      `fullnameOverride=${deploy.uuid}`,
      `commonLabels.name=${deployable.buildUUID}`,
      `commonLabels.lc__uuid=${deployable.buildUUID}`,
      ...customLabels
    );

    if (build?.isStatic) {
      const { tolerations, nodeSelector } = configs[chartName] || {};
      if (tolerations) {
        const staticEnvTolerations = [{ key: 'static_env', operator: 'Equal', value: 'yes', effect: 'NoSchedule' }];
        customValues = customValues.concat(generateTolerationsCustomValues(tolerations, staticEnvTolerations));
      }
      if (nodeSelector) {
        customValues = customValues.concat(generateNodeSelector(nodeSelector, 'lifecycle-static-env'));
      }
    }
  } else if (chartType === ChartType.LOCAL) {
    const templateResolvedValues = await renderTemplate(deploy.build, helm?.chart?.values || []);
    customValues = templateResolvedValues;

    customValues.push(
      `fullnameOverride=${deploy.uuid}`,
      `commonLabels.name=${deployable.buildUUID}`,
      `commonLabels.lc__uuid=${deployable.buildUUID}`
    );

    // Handle environment variables for LOCAL charts with envMapping
    if (helm?.envMapping && helm?.docker) {
      const initEnvVars = merge(deploy.initEnv || {}, build.commentRuntimeEnv || {});
      const appEnvVars = merge(deploy.env, build.commentRuntimeEnv || {});

      // Process app environment variables
      if (helm.envMapping.app && Object.keys(appEnvVars).length > 0) {
        const appEnvCustomValues = transformEnvVarsToHelmFormat(
          appEnvVars,
          helm.envMapping.app.format,
          helm.envMapping.app.path
        );
        customValues.push(...appEnvCustomValues);
      }

      // Process init environment variables
      if (helm.envMapping.init && Object.keys(initEnvVars).length > 0) {
        const initEnvCustomValues = transformEnvVarsToHelmFormat(
          initEnvVars,
          helm.envMapping.init.format,
          helm.envMapping.init.path
        );
        customValues.push(...initEnvCustomValues);
      }
    }
  }

  return customValues;
}

/**
 * Transform environment variables to the specified Helm format
 * @param envVars - Key-value pairs of environment variables
 * @param format - Either 'array' or 'map' format
 * @param path - The Helm path where the values should be set
 */
function transformEnvVarsToHelmFormat(
  envVars: Record<string, string>,
  format: 'array' | 'map',
  path: string
): string[] {
  const values: string[] = [];

  if (format === 'array') {
    // Array format: path[0].name=KEY, path[0].value=VALUE
    let index = 0;
    for (const [key, value] of Object.entries(envVars)) {
      values.push(`${path}[${index}].name=${key}`);
      values.push(`${path}[${index}].value=${value}`);
      index++;
    }
  } else if (format === 'map') {
    // Map format: path.KEY=VALUE
    for (const [key, value] of Object.entries(envVars)) {
      // Replace underscores with double underscores for Helm compatibility
      const helmKey = key.replace(/_/g, '__');
      values.push(`${path}.${helmKey}="${value}"`);
    }
  }

  return values;
}

export function getRepoUrl(repoName: string): string {
  return REPO_MAPPINGS[repoName] || repoName;
}

export function getRepoAliasFromUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const pathParts = url.pathname.split('/').filter((part) => part.length > 0);
    return pathParts[pathParts.length - 1] || 'default-repo';
  } catch (error) {
    const cleanUrl = repoUrl.replace(/[^a-zA-Z0-9]/g, '');
    return cleanUrl.toLowerCase().substring(0, 20) || 'default-repo';
  }
}

export function constructImageVersion(dockerImage: string): string {
  const parts = dockerImage.split(':');
  return parts.length > 1 ? parts[parts.length - 1] : 'latest';
}

export function escapeHelmValue(value: string): string {
  // Escape forward slashes to prevent helm from interpreting them as nested paths
  return value.replace(/\//g, '\\/');
}

export async function validateHelmConfiguration(deploy: Deploy): Promise<string[]> {
  const errors: string[] = [];
  const { deployable } = deploy;
  const helm = deployable.helm;

  if (!helm) {
    errors.push('Helm configuration is missing');
    return errors;
  }

  if (!helm.chart?.name) {
    errors.push('Helm chart name is required');
  }

  // Check for helm version in multiple locations
  const helmVersion = helm.version || helm.nativeHelm?.defaultHelmVersion;
  if (!helmVersion) {
    errors.push('Helm version is required');
  }

  const chartType = await determineChartType(deploy);
  if (chartType === ChartType.ORG_CHART && !deploy.dockerImage) {
    errors.push('Docker image is required for org chart deployments');
  }

  return errors;
}

export { ChartType } from './constants';

export async function determineChartType(deploy: Deploy): Promise<ChartType> {
  const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();
  const helm = deploy.deployable.helm;
  const chartName = helm?.chart?.name;

  if (chartName === orgChartName && helm?.docker) {
    return ChartType.ORG_CHART;
  }

  if (chartName === 'local' || chartName?.startsWith('./') || chartName?.startsWith('../')) {
    return ChartType.LOCAL;
  }

  return ChartType.PUBLIC;
}
