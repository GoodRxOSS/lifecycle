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
import { TMP_PATH } from 'shared/config';
import { DeployStatus } from 'shared/constants';
import { getLogger } from 'server/lib/logger';
import { shellPromise } from 'server/lib/shell';
import { kubeContextStep } from 'server/lib/codefresh';
import Build from 'server/models/Build';
import { staticEnvTolerations } from './constants';
import { getResourceType, mergeKeyValueArrays } from 'shared/utils';
import { generateNodeSelector, generateTolerationsCustomValues, renderTemplate } from 'server/lib/helm/utils';
import { generateCheckoutStep } from 'server/lib/codefresh/utils';
import { merge } from 'lodash';
import {
  deletePendingHelmReleaseStep,
  waitForInProgressDeploys,
} from 'server/lib/codefresh/utils/generateCodefreshCmd';
import { randomAlphanumeric } from '../random';

const CODEFRESH_PATH = `${TMP_PATH}/codefresh`;

/**
 * Generates codefresh deployment step for public Helm charts.
 * We are manily using the `helm` column from deployable table.
 *
 * @param {Deploy} deploy - The deploy object containing deployment details.
 * @returns {Promise<Record<string, unknown>>} A promise that resolves to the deployment step configuration.
 */
export async function helmPublicDeployStep(deploy: Deploy): Promise<Record<string, unknown>> {
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  const { lifecycleDefaults } = configs;
  await deploy.$fetchGraph('build');
  const { deployable, build } = deploy;
  const { helm } = deployable || {};
  const { chart } = helm || {};

  const templateResolvedValues = await renderTemplate(deploy.build, chart.values);
  let customValues = mergeKeyValueArrays(configs[chart?.name]?.chart?.values, templateResolvedValues, '=');
  const chartName = helm?.chart?.name;
  const customLabels = [];
  if (configs[chartName]?.label) {
    customLabels.push(
      `${configs[chartName].label}.name=${deployable.buildUUID}`,
      `${configs[chartName].label}.lc__uuid=${deployable.buildUUID}`
    );
  }
  // add node nodeSelector and tolerations for static env deploys, so they are scheduled on static env nodes
  if (build?.isStatic) {
    const { tolerations, nodeSelector } = configs[chartName] || {};
    if (tolerations)
      customValues = customValues.concat(generateTolerationsCustomValues(tolerations, staticEnvTolerations));
    if (nodeSelector) customValues = customValues.concat(generateNodeSelector(nodeSelector, 'lifecycle-static-env'));
  }

  return {
    stage: 'Deploy',
    type: helm?.cfStepType || configs?.lifecycleDefaults?.cfStepType,
    working_directory: '${{Checkout}}',
    arguments: {
      chart_name: chartName,
      chart_repo_url: chart?.repoUrl,
      chart_version: chart?.version,
      release_name: deploy.uuid.toLowerCase(),
      helm_version: helm?.version,
      kube_context: `${deploy.uuid}-${lifecycleDefaults.deployCluster}`,
      namespace: build.namespace,
      cmd_ps: helm?.args,
      action: helm?.action,
      custom_values: [
        `fullnameOverride=${deploy.uuid}`,
        `commonLabels.name=${deployable.buildUUID}`,
        `commonLabels.lc__uuid=${deployable.buildUUID}`,
        ...customLabels,
        ...customValues,
      ],
      custom_value_files: [...(chart?.valueFiles || [])],
    },
  };
}

/**
 * Generates codefesh deployment step for org's custom Helm charts.
 *
 * @param {Deploy} deploy - The deploy object containing deployment details.
 * @returns {Promise<Record<string, any>>} A promise that resolves to the deployment step configuration.
 */
export async function helmOrgAppDeployStep(deploy: Deploy): Promise<Record<string, any>> {
  await deploy.$fetchGraph('build');
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  const { lifecycleDefaults } = configs;
  const { deployable, build } = deploy;
  const { helm } = deployable || {};
  const { chart } = helm || {};
  const resourceType = getResourceType(helm?.type);

  const templateResolvedValues = await renderTemplate(deploy?.build, chart?.values);

  const initEnvVars = merge(deploy.initEnv || {}, build.commentRuntimeEnv || {});
  const appEnvVars = merge(deploy.env, build.commentRuntimeEnv || {});
  const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();

  const partialCustomValues = mergeKeyValueArrays(configs[orgChartName].chart?.values, chart?.values, '=');
  const customValues = mergeKeyValueArrays(partialCustomValues, templateResolvedValues, '=');
  if (build?.isStatic) {
    // add node affinity for static env deploys, so they are scheduled on static env nodes
    // Note: this assumes we always have a eks.amazonaws.com/capacityType IN 'ON_DEMAND' affinity in the custom values file for each service
    customValues.push(
      `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=eks.amazonaws.com/capacityType`,
      `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In`,
      `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=ON_DEMAND`,
      `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].key=app-long`,
      `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].operator=In`,
      `${resourceType}.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].values[0]=lifecycle-static-env`
    );

    // add toleration for static envs
    customValues.push(...generateTolerationsCustomValues(`${resourceType}.tolerations`, staticEnvTolerations));
  }
  let version = constructImageVersion(deploy.dockerImage);
  customValues.push(`${resourceType}.appImage=${deploy.dockerImage}`, `version=${version}`);
  if (deploy?.initDockerImage) {
    version = constructImageVersion(deploy.initDockerImage);
    customValues.push(
      `${resourceType}.initImage=${deploy.initDockerImage}`,
      `${resourceType}.version=${version}`,
      ...Object.entries(initEnvVars).map(
        ([key, value]) => `${resourceType}.initEnv.${key.replace(/_/g, '__')}=${value}`
      )
    );
  } else {
    // if there is no init image, we need to disable init container
    customValues.push(`${resourceType}.disableInit=true`);
  }
  const isDisableIngressHost: boolean | undefined = helm?.disableIngressHost;
  const grpc: boolean | undefined = helm?.grpc;
  const ingress = await httpIngress(deploy);
  if (grpc) {
    const mappings = await grpcMapping(deploy);
    customValues.push(...mappings);
    if (isDisableIngressHost === false) customValues.push(...ingress, ...addHelmCustomValues(deploy));
  } else if (!isDisableIngressHost && resourceType === 'deployment') {
    customValues.push(...ingress, ...addHelmCustomValues(deploy));
  }

  const chartName = helm?.chart?.name;

  const workDir = '${{Checkout}}';

  return {
    stage: 'Deploy',
    type: helm?.cfStepType || configs?.lifecycleDefaults?.cfStepType,
    working_directory: workDir,
    arguments: {
      chart_name: chartName,
      chart_version: chart?.version,
      chart_repo_url: chart?.repoUrl,
      release_name: deploy.uuid.toLowerCase(),
      helm_version: helm?.version,
      kube_context: `${deploy.uuid}-${lifecycleDefaults.deployCluster}`,
      namespace: build.namespace,
      cmd_ps: helm?.args,
      action: helm?.action,
      custom_values: [
        `env=lifecycle-${deploy.deployable.buildUUID}`,
        `${resourceType}.enableServiceLinks=disabled`,
        // we have to replace _ with __ because codefresh helm step will turn ingle _ into . (dot).
        // double __ will be replaced by _
        `lc__uuid=${deploy.deployable.buildUUID}`,
        ...Object.entries(appEnvVars).map(
          ([key, value]) => `${resourceType}.env.${key.replace(/_/g, '__')}="${value}"`
        ),
        ...customValues,
      ],
      custom_value_files: [...(chart?.valueFiles || [])],
    },
  };
}

/**
 * constructImageVersion
 * @description Extracts the version from the image name
 * @example imageName: 'lfc:lfc-init-stuff-1.0.0' => 'stuff-1.0.0'
 * @param imageName string
 * @returns string
 */
export const constructImageVersion = (imageName: string = '') => {
  // removes lfc: prefix
  const imageNameWithoutPrefix = imageName?.split(':')?.[1];
  if (!imageNameWithoutPrefix) return imageName;
  const imageNameParts = imageNameWithoutPrefix.split('-');
  if (imageNameParts?.length === 0) return imageNameWithoutPrefix;
  // filters out main, init, lfc
  const imageNameWithoutImageType = imageNameParts.filter((part) => !['main', 'init', 'lfc'].includes(part));
  const jobId = randomAlphanumeric(4).toLowerCase();
  imageNameWithoutImageType.unshift(jobId);
  return imageNameWithoutImageType.join('-');
};

/**
 * Determines the appropriate Helm deployment step based on the deployable type.
 * Public or org's app chart.
 *
 * @param {Deploy} deploy - The deploy object containing deployment details.
 * @returns {Promise<Record<string, any>>} A promise that resolves to the deployment step configuration.
 */
export async function helmDeployStep(deploy: Deploy): Promise<Record<string, any>> {
  const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();
  const isOrgAppChart = deploy?.deployable?.helm?.chart?.name === orgChartName && deploy?.deployable?.helm?.docker;

  if (isOrgAppChart) {
    return await helmOrgAppDeployStep(deploy);
  }
  return await helmPublicDeployStep(deploy);
}

/**
 * Deploys Helm charts for the provided deploys array.
 * Supports both native helm and Codefresh deployment methods.
 *
 * @param {Deploy[]} deploys - An array of deploy objects.
 */
export async function deployHelm(deploys: Deploy[]) {
  const { deployHelm: nativeDeployHelm } = await import('server/lib/nativeHelm/helm');
  return await nativeDeployHelm(deploys);
}
/**
 * Make request with interval of 10 seconds until return 200 status code for Keda Scale to Zero
 *
 * @param  url - The url to fetch until success.
 * @param  interval - The interval to fetch the url in ms
 */

export async function fetchUntilSuccess(url, retries, deploy, namespace) {
  getLogger().debug(`Helm: waiting for pods url=${url} maxRetries=${retries}`);
  for (let i = 0; i < retries; i++) {
    const pods = await shellPromise(
      `kubectl get deploy ${deploy} -n ${namespace} -o jsonpath='{.status.availableReplicas}'`
    );
    try {
      const response = await fetch(url);
      if (1 <= parseInt(pods, 10)) {
        getLogger().debug(`Pods: available deploy=${deploy} pods=${pods}`);
        return;
      } else {
        getLogger().debug(`Pods: unavailable deploy=${deploy}`);
        getLogger().error(`Helm: request failed url=${url} status=${response.status}`);
      }
    } catch (error) {
      getLogger().error({ error }, `Helm: fetch failed url=${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
/**
 * Generates the Codefresh YAML configuration for Helm deployment, stores it in a temporary file,
 * and retunrs the run command for that yaml file.
 *
 * @param {Deploy} deploy - The deploy object containing deployment details.
 * @returns {Promise<string>} A promise that resolves to the generated Codefresh command.
 */
export async function generateCodefreshRunCommand(deploy: Deploy): Promise<string> {
  const hasValueFiles = deploy?.deployable?.helm?.chart?.valueFiles?.length > 0;
  await deploy.$fetchGraph('build');
  const yamlContent = hasValueFiles
    ? await generateHelmCodefreshYamlWithCheckout(deploy)
    : await generateHelmCodefreshYamlNoCheckout(deploy);

  const generatedYaml = yaml.dump(yamlContent);
  const configPath = `${CODEFRESH_PATH}/helm-deploy-${deploy.uuid}.yaml`;

  try {
    await fs.promises.mkdir(CODEFRESH_PATH, { recursive: true });
    await fs.promises.writeFile(configPath, generatedYaml, 'utf8');
  } catch (error) {
    getLogger({ error }).error(`Codefresh: config write failed`);
    throw error;
  }
  const { lifecycleDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const command = `codefresh run ${lifecycleDefaults.helmDeployPipeline} -b "${deploy.branchName}" -y ${configPath} -v ENV=lfc -d`;

  return command;
}

/**
 * Generates the Codefresh YAML configuration for Helm deployment without checkout step.
 * If there are no values file we do not need to checkout the repo.
 *
 * @param {Deploy} deploy - The deploy object containing deployment details.
 * @returns {Promise<Record<string, unknown>>} A promise that resolves to the YAML configuration.
 */
export async function generateHelmCodefreshYamlNoCheckout(deploy: Deploy): Promise<Record<string, unknown>> {
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  const kubeContext = await kubeContextStep({ context: deploy.uuid, cluster: configs.lifecycleDefaults.deployCluster });
  const helmDeploy = await helmDeployStep(deploy);
  delete helmDeploy.working_directory;
  kubeContext['stage'] = 'Checkout';
  const addHelmReleaseDeletionStep = deploy?.build?.isStatic
    ? configs?.deletePendingHelmReleaseStep?.static_delete
    : configs?.deletePendingHelmReleaseStep?.delete;

  const annotationsObj = {
    uuid: deploy.deployable?.buildUUID,
    deployUUID: deploy.uuid,
    eksCluster: configs?.lifecycleDefaults?.deployCluster || 'unknown',
  };
  const annotations = Object.keys(annotationsObj)
    .filter((key) => annotationsObj[key])
    .map((key) => ({ [key]: annotationsObj[key] }));

  return {
    version: '1.0',
    hooks: {
      on_elected: {
        annotations: {
          set: [{ annotations, display: 'deployUUID' }],
        },
      },
    },
    stages: ['Wait', 'Checkout', 'Cleanup', 'Deploy'],
    steps: {
      wait: waitForInProgressDeploys({
        deployUUID: deploy.uuid,
        pipelineId: configs.lifecycleDefaults.helmDeployPipeline,
      }),
      kubeContext,
      ...(addHelmReleaseDeletionStep
        ? { uninstall: deletePendingHelmReleaseStep({ deploy, namespace: deploy.build.namespace }) }
        : {}),
      deploy: helmDeploy,
    },
  };
}

/**
 * Generates the Codefresh YAML configuration for Helm deployment with checkout.
 * If there are values file we need to checkout the repo.
 *
 * @param {Deploy} deploy - The deploy object containing deployment details.
 * @returns {Promise<Record<string, unknown>>} A promise that resolves to the YAML configuration.
 */
export async function generateHelmCodefreshYamlWithCheckout(deploy: Deploy): Promise<Record<string, unknown>> {
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  await deploy.$fetchGraph('repository');

  const repositoryName = deploy?.repository?.fullName;
  const revision = deploy.sha;
  const gitOrg = (configs?.app_setup?.org && configs.app_setup.org.trim()) || 'REPLACE_ME_ORG';

  const Checkout = generateCheckoutStep(revision, repositoryName, gitOrg);
  delete Checkout.stage;
  const kubeContext = await kubeContextStep({ context: deploy.uuid, cluster: configs.lifecycleDefaults.deployCluster });
  const addHelmReleaseDeletionStep = deploy?.build?.isStatic
    ? configs?.deletePendingHelmReleaseStep?.static_delete
    : configs?.deletePendingHelmReleaseStep?.delete;
  const deployStep = await helmDeployStep(deploy);

  const annotationsObj = {
    uuid: deploy.deployable?.buildUUID,
    deployUUID: deploy.uuid,
    eksCluster: configs?.lifecycleDefaults?.deployCluster || 'unknown',
  };
  const annotations = Object.keys(annotationsObj)
    .filter((key) => annotationsObj[key])
    .map((key) => ({ [key]: annotationsObj[key] }));

  return {
    version: '1.0',
    hooks: {
      on_elected: {
        annotations: {
          set: [{ annotations, display: 'deployUUID' }],
        },
      },
    },
    stages: ['Wait', 'Checkout', 'Cleanup', 'Deploy'],
    steps: {
      wait: waitForInProgressDeploys({
        deployUUID: deploy.uuid,
        pipelineId: configs.lifecycleDefaults.helmDeployPipeline,
      }),
      clone: {
        type: 'parallel',
        stage: 'Checkout',
        steps: {
          Checkout,
          kubeContext,
        },
      },
      ...(addHelmReleaseDeletionStep
        ? { uninstall: deletePendingHelmReleaseStep({ deploy, namespace: deploy.build.namespace }) }
        : {}),
      deploy: deployStep,
    },
  };
}

/**
 * Uninstalls Helm releases associated with the provided build.
 *
 * @param {Build} build - The build object containing build details.
 */
export async function uninstallHelmReleases(build: Build) {
  try {
    const buildId = build?.id;
    const deploys = (await Deploy.query().where({ buildId }).withGraphFetched({
      service: true,
      build: true,
      deployable: true,
    })) as Deploy[];

    const helmDeploys = deploys.filter((d) => d.deployable.helm && Object.keys(d.deployable.helm).length > 0);

    for (const deploy of helmDeploys) {
      if (!deploy.active || deploy.status === DeployStatus.QUEUED) continue;

      try {
        await shellPromise(`helm uninstall ${deploy.uuid} --namespace ${build.namespace}`);
        await deploy.$query().patch({ statusMessage: 'Uninstalled via Helm' });
      } catch (error) {
        if (error.includes('release: not found')) {
          getLogger().debug(`Helm: release not found, skipping uninstall`);
          await deploy.$query().patch({ statusMessage: 'Helm release not found, skipping uninstall.' });
        } else {
          getLogger({ error }).error(`Helm: uninstall failed`);
          await deploy.$query().patch({ statusMessage: `Failed to uninstall via Helm\n${error}` });
          throw error;
        }
      }
    }

    getLogger().debug(`Helm: releases uninstalled`);
  } catch (error) {
    getLogger().error({ error }, `Helm: uninstall releases failed`);
  }
}

/**
 * Add helm Custom Values to use in helm install --set flag to override defalt values or values.yaml
 *
 * @param {Deploy} deploy - The deploy object containing deploy details.
 */
function addHelmCustomValues(deploy: Deploy): string[] {
  getLogger().debug(
    `Helm: custom values kedaScaleToZeroType=${deploy?.kedaScaleToZero?.type} isStatic=${deploy?.build?.isStatic}`
  );
  if (
    deploy?.kedaScaleToZero?.type === 'http' &&
    deploy.build.isStatic == false &&
    deploy?.build.isStatic != undefined
  ) {
    getLogger().debug(`Helm: enabling autoscaling for KEDA scale-to-zero`);
    return ['autoscaling.enabled=true'];
  }
  return [];
}

export async function grpcMapping(deploy: Deploy): Promise<string[]> {
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

async function httpIngress(deploy: Deploy): Promise<string[]> {
  let ingressValues = [];

  const { serviceDefaults, domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  ingressValues = [`ingress.host=${deploy.uuid}.${domainDefaults.http}`];
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
  if (
    deploy?.kedaScaleToZero?.type === 'http' &&
    deploy.build.isStatic === false &&
    deploy?.build.isStatic != undefined
  ) {
    ingressValues.push(`ingress.backendService=${deploy.uuid}-external-service`, 'ingress.port=8080');
    getLogger().debug(`Helm: redirecting ingress to KEDA proxy`);
  }

  return ingressValues;
}

export const constructHelmDeploysBuildMetaData = async (deploys: Deploy[]) => {
  try {
    const deploy = deploys?.[0];
    let build = deploy?.build;
    if (!build) {
      await deploy?.$fetchGraph('build.pullRequest');
    }
    build = deploy?.build;
    const pullRequest = build?.pullRequest;
    if (!build || !pullRequest) {
      throw new Error('no_related_build_found');
    }
    const uuid = build?.uuid;
    const branchName = pullRequest?.branchName;
    const fullName = pullRequest?.fullName;
    const sha = pullRequest?.latestCommit;
    return {
      uuid,
      branchName,
      fullName,
      sha,
      error: '',
    };
  } catch (error) {
    getLogger().error({ error }, `Helm: metadata construction failed`);
    return {
      uuid: '',
      branchName: '',
      fullName: '',
      sha: '',
      error: error?.message ?? 'unknown_related_build_error',
    };
  }
};
