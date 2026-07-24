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
import { RegistryAuthConfig, generateRegistryLoginScript } from './registryAuth';
import { mergeKeyValueArrays, getResourceType } from 'shared/utils';
import { merge } from 'lodash';
import {
  renderTemplate,
  generateTolerationsCustomValues,
  generateNodeSelector,
  serializeHelmEnvArray,
  serializeHelmEnvMap,
  serializeHelmValues,
  scaffoldHelmSecretRefs,
} from 'server/lib/helm/utils';
import { staticEnvTolerations } from 'server/lib/helm/constants';
import { getLogger } from 'server/lib/logger';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';
import { normalizeKubernetesLabelValue } from 'server/lib/kubernetes/utils';
import {
  NativeHelmConfig as GlobalNativeHelmConfig,
  NativeHelmPostRendererConfig,
} from 'server/services/types/globalConfig';
import { HelmSecretSetFile, HelmValueSecretRef, splitHelmSecretValueRefs } from 'server/lib/helm/secretValueRefs';
import { buildLifecycleGatewayApiConfig } from 'server/lib/helm/gatewayApi';

export type HelmPostRendererConfig = NativeHelmPostRendererConfig;

export interface HelmDeployOptions {
  namespace: string;
  deploymentMethod?: 'native' | 'ci';
}

export interface HelmConfiguration {
  chartType: ChartType;
  customValues: string[];
  helmSecretRefs: HelmValueSecretRef[];
  secretSetFiles: HelmSecretSetFile[];
  valuesFiles: string[];
  chartPath: string;
  releaseName: string;
  helmVersion: string;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPostRendererFlags(postRenderer?: NativeHelmPostRendererConfig): string {
  if (!postRenderer?.command || postRenderer.enabled === false) {
    return '';
  }

  let flags = ` --post-renderer ${shellEscape(postRenderer.command)}`;

  (postRenderer.args || []).forEach((arg) => {
    flags += ` --post-renderer-args ${shellEscape(arg)}`;
  });

  return flags;
}

function mergePostRendererConfig(
  defaults?: NativeHelmPostRendererConfig,
  chartConfig?: NativeHelmPostRendererConfig,
  current?: NativeHelmPostRendererConfig
): NativeHelmPostRendererConfig | undefined {
  if (!defaults && !chartConfig && !current) {
    return undefined;
  }

  return {
    ...defaults,
    ...chartConfig,
    ...current,
    args:
      current?.args !== undefined ? current.args : chartConfig?.args !== undefined ? chartConfig.args : defaults?.args,
  };
}

function mergeNativeHelmConfig(
  defaults?: Partial<GlobalNativeHelmConfig>,
  chartConfig?: Partial<GlobalNativeHelmConfig>,
  current?: Partial<GlobalNativeHelmConfig>
) {
  if (!defaults && !chartConfig && !current) {
    return undefined;
  }

  return {
    ...defaults,
    ...chartConfig,
    ...current,
    postRenderer: mergePostRendererConfig(defaults?.postRenderer, chartConfig?.postRenderer, current?.postRenderer),
  };
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
  defaultArgs?: string,
  chartVersion?: string,
  postRenderer?: NativeHelmPostRendererConfig,
  secretSetFiles: HelmSecretSetFile[] = []
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
    const isOciChart = chartRepoUrl?.startsWith('oci://');
    if (isOciChart) {
      command += ` ${chartRepoUrl}`;
    } else {
      command += ` ${chartPath}`;
    }
  }

  command += ` --namespace ${namespace}`;

  if (chartVersion && (chartType === ChartType.PUBLIC || chartType === ChartType.ORG_CHART)) {
    command += ` --version ${chartVersion}`;
  }

  command += buildPostRendererFlags(postRenderer);

  const appendCustomValue = (value: string) => {
    const equalIndex = value.indexOf('=');
    if (equalIndex > -1) {
      const key = value.substring(0, equalIndex);
      const val = value.substring(equalIndex + 1);
      const escapedVal = escapeHelmValue(val);
      command += ` --set "${key}=${escapedVal}"`;
    } else {
      command += ` --set "${value}"`;
    }
  };

  customValues.forEach((value) => {
    appendCustomValue(value);
  });

  secretSetFiles.forEach((file) => {
    command += ` --set-file "${file.helmKey}=${file.mountPath}"`;
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
  defaultArgs?: string,
  chartVersion?: string,
  registryAuth?: RegistryAuthConfig,
  postRenderer?: NativeHelmPostRendererConfig,
  secretSetFiles: HelmSecretSetFile[] = []
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
    defaultArgs,
    chartVersion,
    postRenderer,
    secretSetFiles
  );

  let script = ['set -e', `echo "Starting helm deployment for ${releaseName}"`, ''].join('\n');

  if (repoName !== 'no-repo' && repoName.includes('/')) {
    script += `cd /workspace
echo "Current directory: $(pwd)"
echo "Directory contents:"
ls -la

`;
  }

  if (chartType === ChartType.PUBLIC || chartType === ChartType.ORG_CHART) {
    const isOciChart = chartRepoUrl?.startsWith('oci://');

    if (!isOciChart) {
      if (chartType === ChartType.PUBLIC && chartPath.includes('/')) {
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

  if (registryAuth) {
    script += `
${generateRegistryLoginScript(registryAuth)}

`;
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
  const customValueConfig = await constructHelmCustomValueConfiguration(deploy, chartType);

  const helmVersion = mergedHelmConfig.version || mergedHelmConfig.nativeHelm?.defaultHelmVersion || '3.12.0';

  return {
    chartType,
    customValues: customValueConfig.customValues,
    helmSecretRefs: customValueConfig.helmSecretRefs,
    secretSetFiles: customValueConfig.secretSetFiles,
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
  const helmDefaults: any = configs.helmDefaults || {};
  const chartConfig: any = chartName ? configs[chartName] || {} : {};

  if (!chartName && !helmDefaults.nativeHelm) {
    return helm;
  }

  const mergedConfig = {
    ...helmDefaults,
    ...chartConfig,
    ...helm,

    label: helm.label ?? chartConfig.label ?? helmDefaults.label,
    tolerations: helm.tolerations ?? chartConfig.tolerations ?? helmDefaults.tolerations,
    affinity: helm.affinity ?? chartConfig.affinity ?? helmDefaults.affinity,
    nodeSelector: helm.nodeSelector ?? chartConfig.nodeSelector ?? helmDefaults.nodeSelector,

    grpc: helm.grpc,
    gatewayApi:
      helmDefaults.gatewayApi || chartConfig.gatewayApi || helm.gatewayApi
        ? {
            ...(helmDefaults.gatewayApi || {}),
            ...(chartConfig.gatewayApi || {}),
            ...(helm.gatewayApi || {}),
          }
        : undefined,
    disableIngressHost: helm.disableIngressHost,
    deploymentMethod: helm.deploymentMethod,
    type: helm.type,
    docker: helm.docker,
    envMapping: helm.envMapping,
    nativeHelm: mergeNativeHelmConfig(helmDefaults.nativeHelm, chartConfig.nativeHelm, helm.nativeHelm),
  };

  if (helmDefaults.chart || chartConfig.chart || helm.chart) {
    mergedConfig.chart = mergeChartConfig(helmDefaults.chart, chartConfig.chart, helm.chart);
  }

  return mergedConfig;
}

function mergeChartConfig(defaultChart: any, chartConfig: any, helmChart: any): any {
  const mergedGlobalValues = chartConfig?.values?.length
    ? mergeKeyValueArrays(defaultChart?.values || [], chartConfig.values, '=')
    : defaultChart?.values || chartConfig?.values || [];

  return {
    ...(defaultChart || {}),
    ...(chartConfig || {}),
    ...(helmChart || {}),

    ...(helmChart?.name && { name: helmChart.name }),
    ...(helmChart?.repoUrl && { repoUrl: helmChart.repoUrl }),
    ...(helmChart?.version && { version: helmChart.version }),

    values:
      helmChart?.values && helmChart.values.length > 0
        ? mergeKeyValueArrays(mergedGlobalValues, helmChart.values, '=')
        : mergedGlobalValues,

    valueFiles:
      helmChart?.valueFiles && helmChart.valueFiles.length > 0
        ? helmChart.valueFiles
        : chartConfig?.valueFiles?.length
        ? chartConfig.valueFiles
        : defaultChart?.valueFiles || helmChart?.valueFiles || [],
  };
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
        ...buildLifecycleLabels(),
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
        ...buildLifecycleLabels(),
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

  const log = getLogger();

  try {
    log.debug(`RBAC: creating role and binding namespace=${namespace} serviceAccount=${serviceAccountName}`);

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
      log.error({ error: verifyError }, `Failed to verify RBAC resources: namespace=${namespace}`);
    }
  } catch (error) {
    log.warn({ error }, `Error creating namespace-scoped RBAC: namespace=${namespace}`);
    log.error(
      {
        error,
        statusCode: error?.response?.statusCode,
        statusMessage: error?.response?.statusMessage,
        serviceAccountName,
        namespace,
        roleName,
        roleBindingName,
      },
      `RBAC creation failed: namespace=${namespace}`
    );

    log.warn(`RBAC setup failed, helm deployment may have permission issues: namespace=${namespace}`);
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

function addNativeHelmCustomValues(): string[] {
  return [];
}

async function constructGatewayApiValues(deploy: Deploy): Promise<string[]> {
  const { domainDefaults, serviceDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const mergedHelmConfig = await mergeHelmConfigWithGlobal(deploy);
  const gatewayApi = mergedHelmConfig?.gatewayApi;

  if (!gatewayApi?.enabled) {
    return [];
  }

  return serializeHelmValues(
    buildLifecycleGatewayApiConfig({
      deploy,
      domainDefaults,
      serviceDefaults,
      helmConfig: mergedHelmConfig,
    }),
    'gatewayApi'
  );
}

async function constructGrpcMappings(deploy: Deploy): Promise<string[]> {
  const { domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const hosts = [domainDefaults.grpc, ...(domainDefaults?.altGrpc || [])];

  const mappings: string[] = [];

  hosts.forEach((host, index) => {
    mappings.push(
      `ambassadorMappings[${index}].name=${deploy.uuid}-${index}`,
      `ambassadorMappings[${index}].env=lifecycle-${deploy.deployable.buildUUID}`,
      `ambassadorMappings[${index}].service=${deploy.uuid}`,
      `ambassadorMappings[${index}].version=${deploy.uuid}`,
      `ambassadorMappings[${index}].host=${deploy.uuid}.${host}:443`,
      `ambassadorMappings[${index}].port=${deploy.deployable.port}`
    );
  });

  return mappings;
}

async function constructHttpIngressValues(deploy: Deploy): Promise<string[]> {
  const ingressValues: string[] = [];
  const { serviceDefaults, domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();

  ingressValues.push(`ingress.host=${deploy.uuid}.${domainDefaults.http}`);

  if (domainDefaults?.altHttp) {
    domainDefaults.altHttp.forEach((host, index) => {
      ingressValues.push(`ingress.altHosts[${index}]=${deploy.uuid}.${host}`);
    });
  }

  if (!deploy.deployable.helm.overrideDefaultIpWhitelist) {
    const ipWhitelist = serviceDefaults.defaultIPWhiteList
      .trim()
      .slice(1, -1)
      .split(',')
      .map((ip, index) => `ingress.ipAllowlist[${index}]=${ip.trim()}`);
    ingressValues.push(...ipWhitelist);
  }

  return ingressValues;
}

export interface HelmCustomValueConfiguration {
  customValues: string[];
  helmSecretRefs: HelmValueSecretRef[];
  secretSetFiles: HelmSecretSetFile[];
}

interface HelmCustomValueEntry {
  value: string;
  parseSecretRefs: boolean;
}

export function resolveHelmCustomValuePrecedence(values: string[]): string[] {
  return resolveHelmCustomValueEntryPrecedence(
    values.map((value) => ({
      value,
      parseSecretRefs: false,
    }))
  ).map((entry) => entry.value);
}

function chartValueEntries(values: string[]): HelmCustomValueEntry[] {
  return values.map((value) => ({
    value,
    parseSecretRefs: true,
  }));
}

function generatedValueEntries(values: string[]): HelmCustomValueEntry[] {
  return values.map((value) => ({
    value,
    parseSecretRefs: false,
  }));
}

function resolveHelmCustomValueEntryPrecedence(values: HelmCustomValueEntry[]): HelmCustomValueEntry[] {
  const lastIndexByKey = new Map<string, number>();

  values.forEach((entry, index) => {
    const equalIndex = entry.value.indexOf('=');

    if (equalIndex === -1) {
      return;
    }

    lastIndexByKey.set(entry.value.substring(0, equalIndex), index);
  });

  return values.filter((entry, index) => {
    const equalIndex = entry.value.indexOf('=');

    if (equalIndex === -1) {
      return true;
    }

    return lastIndexByKey.get(entry.value.substring(0, equalIndex)) === index;
  });
}

export async function constructHelmCustomValueConfiguration(
  deploy: Deploy,
  chartType: ChartType
): Promise<HelmCustomValueConfiguration> {
  let customValues: HelmCustomValueEntry[] = [];
  const { deployable, build } = deploy;

  const helm = await mergeHelmConfigWithGlobal(deploy);
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  const chartName = helm?.chart?.name;
  const serviceName = deployable?.name || deploy.uuid || 'service';

  if (chartType === ChartType.ORG_CHART) {
    const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();
    const initEnvVars = scaffoldHelmSecretRefs(
      merge(deploy.initEnv || {}, build.commentRuntimeEnv || {}),
      deployable?.name,
      deployable?.builder?.engine
    );
    const appEnvVars = scaffoldHelmSecretRefs(
      merge(deploy.env || {}, build.commentRuntimeEnv || {}),
      deployable?.name,
      deployable?.builder?.engine
    );
    const resourceType = getResourceType(helm?.type);

    const partialCustomValues = mergeKeyValueArrays(
      configs[orgChartName]?.chart?.values || [],
      helm?.chart?.values || [],
      '='
    );
    const templateResolvedValues = await renderTemplate(deploy.build, partialCustomValues);
    customValues = chartValueEntries(templateResolvedValues);

    if (deploy.dockerImage) {
      const version = constructImageVersion(deploy.dockerImage);
      customValues.push(
        ...generatedValueEntries([`${resourceType}.appImage=${deploy.dockerImage}`, `version=${version}`])
      );
    }

    if (deploy.initDockerImage) {
      customValues.push(...generatedValueEntries([`${resourceType}.initImage=${deploy.initDockerImage}`]));
      customValues.push(...generatedValueEntries(serializeHelmEnvMap(initEnvVars, `${resourceType}.initEnv`)));
    } else {
      customValues.push(...generatedValueEntries([`${resourceType}.disableInit=true`]));
    }

    customValues.push(
      ...generatedValueEntries(serializeHelmEnvMap(appEnvVars, `${resourceType}.env`, { quoteStringValues: true }))
    );

    const isDisableIngressHost: boolean | undefined = helm?.disableIngressHost;
    const grpc: boolean | undefined = helm?.grpc;
    const ingressValues = await constructHttpIngressValues(deploy);

    if (helm?.gatewayApi?.enabled) {
      customValues.push(...generatedValueEntries(await constructGatewayApiValues(deploy)));
    } else if (grpc) {
      customValues.push(...generatedValueEntries(await constructGrpcMappings(deploy)));
      if (isDisableIngressHost === false) {
        customValues.push(...generatedValueEntries([...ingressValues, ...addNativeHelmCustomValues()]));
      }
    } else if (!isDisableIngressHost && resourceType === 'deployment') {
      customValues.push(...generatedValueEntries([...ingressValues, ...addNativeHelmCustomValues()]));
    }

    customValues.push(
      ...generatedValueEntries([
        `env=lifecycle-${deployable.buildUUID}`,
        `${resourceType}.enableServiceLinks=disabled`,
        `lc__uuid=${deployable.buildUUID}`,
      ])
    );

    if (build?.isStatic) {
      customValues.push(
        ...generatedValueEntries([
          `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=eks.amazonaws.com/capacityType`,
          `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In`,
          `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=ON_DEMAND`,
          `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].key=app-long`,
          `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].operator=In`,
          `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].values[0]=lifecycle-static-env`,
          ...generateTolerationsCustomValues(`${resourceType}.tolerations`, staticEnvTolerations),
        ])
      );
    }
  } else if (chartType === ChartType.PUBLIC) {
    const templateResolvedValues = await renderTemplate(deploy.build, helm?.chart?.values || []);
    customValues = chartValueEntries(
      mergeKeyValueArrays(configs[chartName]?.chart?.values || [], templateResolvedValues, '=')
    );

    const customLabels: string[] = [];
    if (configs[chartName]?.label) {
      customLabels.push(
        `${configs[chartName].label}.name=${deployable.buildUUID}`,
        `${configs[chartName].label}.lc__uuid=${deployable.buildUUID}`
      );
    }

    customValues.push(
      ...generatedValueEntries([
        `fullnameOverride=${deploy.uuid}`,
        `commonLabels.name=${deployable.buildUUID}`,
        `commonLabels.lc__uuid=${deployable.buildUUID}`,
        ...customLabels,
      ])
    );

    if (build?.isStatic) {
      const { tolerations, nodeSelector } = configs[chartName] || {};
      if (tolerations) {
        customValues = customValues.concat(
          generatedValueEntries(generateTolerationsCustomValues(tolerations, staticEnvTolerations))
        );
      }
      if (nodeSelector) {
        customValues = customValues.concat(
          generatedValueEntries([generateNodeSelector(nodeSelector, 'lifecycle-static-env')])
        );
      }
    }
  } else if (chartType === ChartType.LOCAL) {
    const templateResolvedValues = await renderTemplate(deploy.build, helm?.chart?.values || []);
    customValues = chartValueEntries(templateResolvedValues);

    customValues.push(
      ...generatedValueEntries([
        `fullnameOverride=${deploy.uuid}`,
        `commonLabels.name=${deployable.buildUUID}`,
        `commonLabels.lc__uuid=${deployable.buildUUID}`,
      ])
    );

    // Handle environment variables for LOCAL charts with envMapping
    if (helm?.envMapping && helm?.docker) {
      const initEnvVars = merge(deploy.initEnv || {}, build.commentRuntimeEnv || {});
      const appEnvVars = merge(deploy.env || {}, build.commentRuntimeEnv || {});

      // Process app environment variables
      if (helm.envMapping.app && Object.keys(appEnvVars).length > 0) {
        const appEnvCustomValues = transformEnvVarsToHelmFormat(
          appEnvVars,
          helm.envMapping.app.format,
          helm.envMapping.app.path
        );
        customValues.push(...generatedValueEntries(appEnvCustomValues));
      }

      // Process init environment variables
      if (helm.envMapping.init && Object.keys(initEnvVars).length > 0) {
        const initEnvCustomValues = transformEnvVarsToHelmFormat(
          initEnvVars,
          helm.envMapping.init.format,
          helm.envMapping.init.path
        );
        customValues.push(...generatedValueEntries(initEnvCustomValues));
      }
    }
  }

  const finalCustomValues = resolveHelmCustomValueEntryPrecedence(customValues);
  const secretValueRefs = finalCustomValues.reduce(
    (result, entry) => {
      if (!entry.parseSecretRefs) {
        result.plainValues.push(entry.value);
        return result;
      }

      const entrySecretValueRefs = splitHelmSecretValueRefs([entry.value], serviceName);

      result.plainValues.push(...entrySecretValueRefs.plainValues);
      result.secretRefs.push(...entrySecretValueRefs.secretRefs);
      result.secretSetFiles.push(...entrySecretValueRefs.secretSetFiles);

      return result;
    },
    { plainValues: [], secretRefs: [], secretSetFiles: [] } as ReturnType<typeof splitHelmSecretValueRefs>
  );

  return {
    customValues: secretValueRefs.plainValues,
    helmSecretRefs: secretValueRefs.secretRefs,
    secretSetFiles: secretValueRefs.secretSetFiles,
  };
}

export async function constructHelmCustomValues(deploy: Deploy, chartType: ChartType): Promise<string[]> {
  const { customValues } = await constructHelmCustomValueConfiguration(deploy, chartType);

  return customValues;
}

/**
 * Transform environment variables to the specified Helm format
 * @param envVars - Key-value pairs of environment variables
 * @param format - Either 'array' or 'map' format
 * @param path - The Helm path where the values should be set
 */
function transformEnvVarsToHelmFormat(envVars: Record<string, any>, format: 'array' | 'map', path: string): string[] {
  if (format === 'array') {
    return serializeHelmEnvArray(envVars, path);
  }

  return serializeHelmEnvMap(envVars, path, {
    keyTransform: (key) => key.replace(/_/g, '__'),
    quoteStringValues: true,
  });
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
  return value.replace(/\//g, '\\/').replace(/,/g, '\\,');
}

function includesUnsafeSecretHelmArg(args?: string): boolean {
  if (!args) {
    return false;
  }

  return /(^|\s)--(?:debug|dry-run)(?:[=\s]|$)/.test(args);
}

export async function validateHelmConfiguration(deploy: Deploy): Promise<string[]> {
  const errors: string[] = [];
  const helm = await mergeHelmConfigWithGlobal(deploy);

  if (!helm) {
    errors.push('Helm configuration is missing');
    return errors;
  }

  if (!helm.chart?.name) {
    errors.push('Helm chart name is required');
  }

  // Check for helm version in multiple locations
  const helmVersion = helm.version || helm.nativeHelm?.defaultHelmVersion;
  if (!helmVersion && !helm.nativeHelm?.image) {
    errors.push('Helm version is required');
  }

  if (
    helm.nativeHelm?.postRenderer?.enabled !== false &&
    helm.nativeHelm?.postRenderer &&
    !helm.nativeHelm.postRenderer.command
  ) {
    errors.push('Native Helm post-renderer command is required when post-renderer is enabled');
  }

  const chartType = await determineChartType(deploy);
  if (chartType === ChartType.ORG_CHART && !deploy.dockerImage) {
    errors.push('Docker image is required for org chart deployments');
  }

  try {
    const customValueConfig = await constructHelmCustomValueConfiguration(deploy, chartType);
    if (
      customValueConfig.secretSetFiles.length > 0 &&
      (includesUnsafeSecretHelmArg(helm.args) || includesUnsafeSecretHelmArg(helm.nativeHelm?.defaultArgs))
    ) {
      errors.push('Helm args --debug and --dry-run cannot be used with secret-backed Helm custom values');
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
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
