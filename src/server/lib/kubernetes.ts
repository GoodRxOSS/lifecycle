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

import { getLogger } from './logger';
import yaml from 'js-yaml';
import _ from 'lodash';
import { Build, Deploy, Deployable, Service } from 'server/models';
import { CLIDeployTypes, KubernetesDeployTypes, MEDIUM_TYPE, DEFAULT_TTL_INACTIVITY_DAYS } from 'shared/constants';
import { shellPromise } from './shell';
import { flattenObject, waitUntil } from 'server/lib/utils';
import { ServiceDiskConfig } from 'server/models/yaml';
import * as k8s from '@kubernetes/client-node';
import { HttpError, V1Status, CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { IncomingMessage } from 'http';
import { APP_ENV, TMP_PATH } from 'shared/config';
import fs from 'fs';
import GlobalConfigService from 'server/services/globalConfig';
import { setupServiceAccountWithRBAC } from './kubernetes/rbac';
import { staticEnvTolerations } from './helm/constants';
import { parseSecretRefsFromEnv, SecretRefWithEnvKey } from './secretRefs';
import { generateSecretName } from './kubernetes/externalSecret';

interface VOLUME {
  name: string;
  emptyDir?: {};
  persistentVolumeClaim?: {
    claimName: string;
  };
}

async function namespaceExists(client: k8s.CoreV1Api, name: string): Promise<boolean> {
  try {
    await client.readNamespace(name);
    return true;
  } catch (err) {
    if (err?.response?.statusCode === 404) {
      return false;
    }
    getLogger({ namespace: name, error: err }).error('Namespace: read failed');
    throw err;
  }
}

/**
 * Gets TTL configuration from global config with fallback to defaults
 */
async function getTTLConfig(buildUUID: string): Promise<{ daysToExpire: number }> {
  let daysToExpire = DEFAULT_TTL_INACTIVITY_DAYS;
  try {
    const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
    daysToExpire = globalConfig.ttl_cleanup?.inactivityDays ?? DEFAULT_TTL_INACTIVITY_DAYS;
  } catch (error) {
    getLogger({ error }).warn(`TTL: config fetch failed default=${DEFAULT_TTL_INACTIVITY_DAYS}days`);
  }
  return { daysToExpire };
}

/**
 * Generates TTL-related labels for namespace creation
 */
async function generateTTLLabels({
  uuid,
  staticEnv,
  ttl,
  buildUUID,
}: {
  uuid: string;
  staticEnv: boolean;
  ttl: boolean;
  buildUUID: string;
}): Promise<{ labels: Record<string, string>; logMessage: string }> {
  const baseLabels = { 'lfc/uuid': uuid };

  // Static or TTL disabled - only set enable flag
  if (staticEnv || !ttl) {
    const reason = staticEnv ? 'static env' : 'lifecycle-keep! label present';
    return {
      labels: {
        ...baseLabels,
        'lfc/ttl-enable': 'false',
      },
      logMessage: `with TTL disabled (${reason})`,
    };
  }

  // TTL enabled - set enable flag + expiration timestamps
  const { daysToExpire } = await getTTLConfig(buildUUID);
  const timeToExpire = Date.now() + daysToExpire * 24 * 60 * 60 * 1000;

  return {
    labels: {
      ...baseLabels,
      'lfc/ttl-enable': 'true',
      'lfc/ttl-createdAtUnix': Date.now().toString(),
      'lfc/ttl-createdAt': new Date().toISOString().split('T')[0],
      'lfc/ttl-expireAtUnix': timeToExpire.toString(),
      'lfc/ttl-expireAt': new Date(timeToExpire).toISOString().split('T')[0],
    },
    logMessage: `with TTL enabled (${daysToExpire} day expiration)`,
  };
}

/**
 * Generates patch operations for updating TTL labels on existing namespace
 */
async function generateTTLPatch({
  ttl,
  buildUUID,
}: {
  ttl: boolean;
  buildUUID: string;
}): Promise<{ patch: any[]; logMessage: string }> {
  // TTL disabled - only update enable flag
  if (!ttl) {
    return {
      patch: [
        {
          op: 'add',
          path: '/metadata/labels/lfc~1ttl-enable',
          value: 'false',
        },
      ],
      logMessage: 'to disable TTL (lifecycle-keep! present)',
    };
  }

  // TTL enabled - update enable flag + all expiration timestamps
  const { daysToExpire } = await getTTLConfig(buildUUID);
  const timeToExpire = Date.now() + daysToExpire * 24 * 60 * 60 * 1000;

  return {
    patch: [
      {
        op: 'add',
        path: '/metadata/labels/lfc~1ttl-enable',
        value: 'true',
      },
      {
        op: 'add',
        path: '/metadata/labels/lfc~1ttl-createdAtUnix',
        value: Date.now().toString(),
      },
      {
        op: 'add',
        path: '/metadata/labels/lfc~1ttl-createdAt',
        value: new Date().toISOString().split('T')[0],
      },
      {
        op: 'add',
        path: '/metadata/labels/lfc~1ttl-expireAtUnix',
        value: timeToExpire.toString(),
      },
      {
        op: 'add',
        path: '/metadata/labels/lfc~1ttl-expireAt',
        value: new Date(timeToExpire).toISOString().split('T')[0],
      },
    ],
    logMessage: `with new TTL expiration (${daysToExpire} days)`,
  };
}

/**
 *
 */
export async function createOrUpdateNamespace({
  name,
  buildUUID,
  staticEnv,
  ttl = true,
}: {
  name: string;
  buildUUID: string;
  staticEnv: boolean;
  ttl?: boolean;
}) {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const client = kc.makeApiClient(k8s.CoreV1Api);

  const uuid = name.replace('env-', '');

  // Generate TTL labels using helper function
  const { labels, logMessage } = await generateTTLLabels({
    uuid,
    staticEnv,
    ttl,
    buildUUID,
  });

  getLogger({ namespace: name }).info(`Deploy: creating namespace ${logMessage}`);

  const namespace = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name,
      labels,
    },
  };

  if (await namespaceExists(client, name)) {
    // Only update TTL labels if not static env
    if (!staticEnv) {
      const { patch, logMessage: patchMessage } = await generateTTLPatch({
        ttl,
        buildUUID,
      });

      await client.patchNamespace(name, patch, undefined, undefined, undefined, undefined, undefined, {
        headers: { 'Content-Type': 'application/json-patch+json' },
      });
      getLogger({ namespace: name }).info(`Deploy: updated namespace ${patchMessage}`);
      return;
    } else {
      getLogger({ namespace: name }).info('Deploy: skipped namespace update reason=static');
      return;
    }
  }

  try {
    await client.createNamespace(namespace);
    getLogger({ namespace: name }).debug('Namespace created');
  } catch (err) {
    getLogger({ namespace: name, error: err }).error('Namespace: create failed');
    throw err;
  }
}

export async function createOrUpdateServiceAccount({ namespace, role }: { namespace: string; role: string }) {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const client = kc.makeApiClient(k8s.CoreV1Api);

  // Get the service account name from global config
  const { serviceAccount } = await GlobalConfigService.getInstance().getAllConfigs();
  const serviceAccountName = serviceAccount?.name || 'default';

  const serviceAccountExists = async () => {
    try {
      const saResponse = await client.readNamespacedServiceAccount(serviceAccountName, namespace);
      return Boolean(saResponse?.body);
    } catch (error) {
      return false;
    }
  };

  // If it's not the default service account, create it first
  if (serviceAccountName !== 'default') {
    const serviceAccountManifest = {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: serviceAccountName,
      },
    };

    try {
      if (!(await serviceAccountExists())) {
        getLogger({ namespace, serviceAccountName }).debug('ServiceAccount: creating');
        await client.createNamespacedServiceAccount(namespace, serviceAccountManifest);
        getLogger({ namespace, serviceAccountName }).debug('Created service account');
      } else {
        getLogger({ namespace, serviceAccountName }).debug('Service account already exists');
      }
    } catch (err) {
      getLogger({
        namespace,
        serviceAccountName,
        error: err,
        statusCode: err?.response?.statusCode,
        statusMessage: err?.response?.statusMessage,
      }).error('ServiceAccount: create failed');
      throw err;
    }
  } else {
    try {
      await waitUntil(serviceAccountExists, {
        timeoutMs: 120000,
        intervalMs: 2000,
      });
    } catch (error) {
      getLogger({ namespace, serviceAccountName, error }).error('ServiceAccount: wait timeout');
      throw error;
    }
  }

  // patch the service account with the role
  const patch = {
    metadata: {
      annotations: {
        'eks.amazonaws.com/role-arn': role,
      },
    },
  };

  try {
    await client.patchNamespacedServiceAccount(
      serviceAccountName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    getLogger({ namespace, serviceAccountName }).debug('Annotated service account');

    await setupServiceAccountWithRBAC({
      namespace,
      serviceAccountName,
      awsRoleArn: role,
      permissions: 'deploy',
    });
    getLogger({ namespace, serviceAccountName }).debug('RBAC: configured');
  } catch (err) {
    getLogger({ namespace, serviceAccountName, error: err }).error('ServiceAccount: setup failed');
    throw err;
  }
}

/**
 *
 * @param build
 */
export async function applyManifests(build: Build): Promise<k8s.KubernetesObject[]> {
  if (!build.manifest || build.manifest.trim().length === 0) {
    getLogger().info('Deploy: starting method=deploymentManager');
    return [];
  }

  getLogger().info('Deploy: starting method=legacyManifest');

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const client = k8s.KubernetesObjectApi.makeApiClient(kc);

  const specs: k8s.KubernetesObject[] = yaml.loadAll(build.manifest);
  const validSpecs = specs.filter((s) => s && s.kind && s.metadata);
  const created: k8s.KubernetesObject[] = [];
  for (const spec of validSpecs) {
    try {
      // try to get the resource, if it does not exist an error will be thrown and we will end up in the catch
      await client.read(spec);
      let response: { body: V1Status; response?: IncomingMessage };
      try {
        response = await client.patch(spec, undefined, undefined, undefined, true);
      } catch (e) {
        if (e instanceof HttpError) {
          const options = {
            headers: {
              'Content-type': k8s.PatchUtils.PATCH_FORMAT_JSON_MERGE_PATCH,
            },
          };
          response = await client.patch(spec, undefined, undefined, undefined, undefined, options);
        }
      }
      created.push(response.body);
    } catch (e) {
      try {
        const response = await client.create(spec);
        created.push(response.body);
      } catch (e) {
        getLogger({
          specName: spec?.metadata?.name,
          error: e,
        }).error('kubectl apply unsuccessful');
      }
    }
  }
  return created;
}

export async function applyHttpScaleObjectManifestYaml(deploy: Deploy, namespace: string) {
  const manifest = await generateHttpScaleObject(deploy);
  const scaleHttpObject = yaml.dump(manifest, { skipInvalid: true });
  getLogger({ namespace }).debug('HttpScaleObject: creating');
  try {
    const localPath = `${TMP_PATH}/keda/${deploy.uuid}-scaleHttpObject.yaml`;
    await fs.promises.mkdir(`${TMP_PATH}/keda/`, {
      recursive: true,
    });
    await fs.promises.writeFile(localPath, scaleHttpObject, 'utf8');
    await shellPromise(`kubectl apply -f ${localPath} --namespace ${namespace}`);
    getLogger({ namespace }).debug('HttpScaleObject: applied');
  } catch (error) {
    getLogger({
      namespace,
      error,
    }).error('HttpScaleObject: apply failed');
    throw new Error(`Failed to apply HTTP scale object manifest for deploy ${error}`);
  }
}

export async function applyExternalServiceManifestYaml(deploy: Deploy, namespace: string) {
  const manifest = generateExternalService(deploy);
  const externalService = yaml.dump(manifest, { skipInvalid: true });
  getLogger({ namespace }).debug('ExternalService: creating');
  try {
    const localPath = `${TMP_PATH}/keda/${deploy.uuid}-externalService.yaml`;
    await fs.promises.mkdir(`${TMP_PATH}/keda/`, {
      recursive: true,
    });
    await fs.promises.writeFile(localPath, externalService, 'utf8');
    await shellPromise(`kubectl apply -f ${localPath} --namespace ${namespace}`);
    getLogger({ namespace }).debug('ExternalService: applied');
  } catch (error) {
    getLogger({
      namespace,
      error,
    }).error('ExternalService: apply failed');
    throw new Error(`Failed to apply ExternalService object manifest for deploy ${error}`);
  }
}

async function generateHttpScaleObject(deploy: Deploy): Promise<Record<string, unknown>> {
  const { domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const httpScaledObject = {
    apiVersion: 'http.keda.sh/v1alpha1',
    kind: 'HTTPScaledObject',
    metadata: {
      name: deploy.uuid,
      labels: {
        lc_uuid: deploy.deployable?.buildUUID,
      },
    },
    spec: {
      // this added fastly domain to handle origin and fastly hits
      hosts: [deploy.publicUrl, `fastly-${deploy.deployable.buildUUID}.fastly.${domainDefaults?.http}`],
      scaleTargetRef: {
        name: deploy.uuid,
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        service: deploy.uuid,
        port: parseInt(deploy.deployable.port),
      },
      replicas: {
        min: deploy.kedaScaleToZero.replicas.min,
        max: deploy.kedaScaleToZero.replicas.max,
      },
      scaledownPeriod: deploy.kedaScaleToZero.scaledownPeriod,
      scalingMetric: {
        requestRate: {
          granularity: deploy.kedaScaleToZero.scalingMetric.requestRate.granularity,
          targetValue: deploy.kedaScaleToZero.scalingMetric.requestRate.targetValue,
          window: deploy.kedaScaleToZero.scalingMetric.requestRate.window,
        },
      },
    },
  };
  return httpScaledObject;
}

function generateExternalService(deploy: Deploy): Record<string, unknown> {
  const externalService = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${deploy.uuid}-external-service`,
      labels: {
        lc_uuid: deploy.deployable?.buildUUID,
      },
    },
    spec: {
      type: 'ExternalName',
      externalName: 'keda-add-ons-http-interceptor-proxy.keda.svc.cluster.local',
    },
  };
  return externalService;
}

export const getK8sApi = () => {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CoreV1Api);
};

export const getPods = async ({ uuid, namespace }: { uuid: string; namespace: string }): Promise<k8s.V1Pod[]> => {
  const k8sApi = getK8sApi();
  const resp = await k8sApi?.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `lc_uuid=${uuid}`
  );
  const items = resp?.body?.items || [];
  return items.filter((pod) => pod?.metadata?.name?.includes(uuid));
};

export async function waitForPodReady(build: Build) {
  const { pullRequest, sha, uuid, namespace } = build;
  const { branchName, fullName } = pullRequest || {};

  const logCtx = { namespace, repo: fullName, branch: branchName, sha };

  let retries = 0;
  getLogger(logCtx).info('Deploy: waiting for pods state=creation');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pods = await getPods({ uuid, namespace });

    if (pods.length > 0) {
      getLogger(logCtx).info('Deploy: pods created');
      break;
    } else if (retries < 60) {
      retries += 1;
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      getLogger(logCtx).warn('Pod: not found timeout=5m');
      break;
    }
  }

  retries = 0;

  getLogger(logCtx).info('Deploy: waiting for pods state=ready');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let isReady = false;
    try {
      const pods = await getPods({ uuid, namespace });
      const matches =
        pods?.filter(
          (pod) =>
            pod?.metadata?.name?.includes(uuid) && pod?.metadata?.labels['app.kubernetes.io/managed-by'] !== 'Helm'
        ) || [];
      isReady = matches.every((pod) => {
        const conditions = pod?.status?.conditions || [];
        if (conditions?.length === 0) return false;
        return conditions.some((condition) => condition?.type === 'Ready' && condition?.status === 'True');
      });
    } catch (error) {
      getLogger({ ...logCtx, error, isReady }).warn('Pod: readiness check failed');
    }

    if (isReady) {
      getLogger(logCtx).info('Deploy: pods ready');
      return true;
    }
    if (retries < 180) {
      retries += 1;
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      throw new Error(
        `Pods for build not ready after 15 minutes buildUuid=${uuid} repo=${fullName} branch=${branchName}`
      );
    }
  }
}

/**
 * Deletes pods, services, and deployments, that are related to the given build.
 * @param build the build we want to delete
 */
export async function deleteBuild(build: Build) {
  try {
    await shellPromise(
      `kubectl delete all,pvc,mapping,Httpscaledobjects -l lc_uuid=${build.uuid} --namespace ${build.namespace}`
    );
    getLogger({ namespace: build.namespace }).info('Deploy: resources deleted');
  } catch (e) {
    getLogger({
      namespace: build.namespace,
      error: e,
    }).error('Resources: delete failed');
  }
}

/**
 * Deletes the given namespace
 * @param name namespace to delete
 */
export async function deleteNamespace(name: string) {
  if (!name.startsWith('env-')) return;

  try {
    await shellPromise(`kubectl delete ns ${name} --grace-period 120`);
    getLogger({ namespace: name }).info('Deploy: namespace deleted');
  } catch (e) {
    if (e.includes('Error from server (NotFound): namespaces')) {
      getLogger({ namespace: name }).info('Deploy: namespace skipped reason=notFound');
    } else {
      getLogger({ namespace: name, error: e }).error('Namespace: delete failed');
    }
  }
}

/**
 * Generates a manifest file that defines how a build should be deployment to a kubernetes cluster
 * @param build the build we are generating a manifest for
 */
export function generateManifest({
  build,
  deploys,
  uuid,
  namespace,
  serviceAccountName,
}: {
  build: Build;
  deploys: Deploy[];
  uuid: string;
  namespace: string;
  serviceAccountName: string;
}) {
  // External Service only deployment

  const cliDeploys = deploys.filter((deploy) => {
    return build.enableFullYaml ? CLIDeployTypes.has(deploy.deployable.type) : CLIDeployTypes.has(deploy.service.type);
  });

  const kubernetesDeploys = deploys.filter((deploy) => {
    return (
      (build.enableFullYaml
        ? KubernetesDeployTypes.has(deploy.deployable.type)
        : KubernetesDeployTypes.has(deploy.service.type)) && deploy.dockerImage !== null
    );
  });

  const externalNameServices = generateExternalNameManifests(cliDeploys, uuid, namespace);
  // General Deployment

  const disks = generatePersistentDisks(kubernetesDeploys, uuid, build.enableFullYaml, namespace);
  const builds = generateDeployManifests(
    build,
    kubernetesDeploys,
    uuid,
    build.enableFullYaml,
    namespace,
    serviceAccountName
  );
  const nodePorts = generateNodePortManifests(kubernetesDeploys, uuid, build.enableFullYaml, namespace);
  const grpcMappings = generateGRPCMappings(kubernetesDeploys, uuid, build.enableFullYaml, namespace);
  const loadBalancers = generateLoadBalancerManifests(kubernetesDeploys, uuid, build.enableFullYaml, namespace);
  const manifest = `${disks}---\n${builds}---\n${nodePorts}---\n${grpcMappings}---\n${loadBalancers}---\n${externalNameServices}`;
  const isDev = APP_ENV?.includes('dev') ?? false;
  if (!isDev) {
    getLogger({ manifest }).info('Manifest: generated');
  }
  return manifest;
}

export function generatePersistentDisks(
  deploys: Deploy[],
  buildUUID: string,
  enableFullYaml: boolean,
  namespace: string
) {
  if (enableFullYaml) {
    return deploys
      .filter((deploy) => {
        return deploy.active && deploy.deployable.serviceDisksYaml != null;
      })
      .map((deploy) => {
        const { uuid: name } = deploy;
        const serviceDisks: ServiceDiskConfig[] = JSON.parse(deploy.deployable.serviceDisksYaml);

        return serviceDisks
          .filter((disk) => disk.medium == null || disk.medium === MEDIUM_TYPE.EBS || disk.medium === MEDIUM_TYPE.DISK)
          .map((disk) => {
            return yaml.dump({
              apiVersion: 'v1',
              kind: 'PersistentVolumeClaim',
              metadata: {
                namespace,
                name: `${name}-${disk.name}-claim`,
                labels: {
                  lc_uuid: buildUUID,
                  name: buildUUID,
                },
              },
              spec: {
                accessModes: [disk.accessModes ?? 'ReadWriteOnce'],
                resources: {
                  requests: {
                    storage: disk.storageSize,
                  },
                },
              },
            });
          });
      })
      .join('\n---\n');
  } else {
    return deploys
      .filter((deploy) => {
        return deploy.active && deploy.service.serviceDisks && deploy.service.serviceDisks.length > 0;
      })
      .map((deploy) => {
        const { uuid: name } = deploy;
        return deploy.service.serviceDisks
          .filter((disk) => disk.medium == null || disk.medium === MEDIUM_TYPE.DISK || disk.medium === MEDIUM_TYPE.EBS)
          .map((disk) => {
            return yaml.dump({
              apiVersion: 'v1',
              kind: 'PersistentVolumeClaim',
              metadata: {
                namespace,
                name: `${name}-${disk.name}-claim`,
                labels: {
                  lc_uuid: buildUUID,
                  name: buildUUID,
                },
              },
              spec: {
                accessModes: [disk.accessModes],
                resources: {
                  requests: {
                    storage: disk.storage,
                  },
                },
              },
            });
          });
      })
      .join('\n---\n');
  }
}

/**
 * Generates an affinity block based on the capacity type definition
 * @param capacityType can either be ON_DEMAND or SPOT
 * @param isStatic whether this is a static environment
 * @param customNodeAffinity optional custom node affinity from schema (overrides default)
 * @returns an affinity block using either requirements or preferences
 */
function generateAffinity(capacityType: string, isStatic: boolean, customNodeAffinity?: Record<string, unknown>) {
  // If custom node affinity is provided, use it instead of default
  if (customNodeAffinity) {
    return { nodeAffinity: customNodeAffinity };
  }

  // Existing logic for capacity-type based affinity
  if (capacityType === 'SPOT') {
    return {
      nodeAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          {
            weight: 1,
            preference: {
              matchExpressions: [
                {
                  key: 'eks.amazonaws.com/capacityType',
                  operator: 'In',
                  values: [capacityType],
                },
              ],
            },
          },
        ],
      },
    };
  }
  return {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              {
                key: 'eks.amazonaws.com/capacityType',
                operator: 'In',
                values: [capacityType],
              },
              ...(isStatic
                ? [
                    {
                      key: 'app-long',
                      operator: 'In',
                      values: ['lifecycle-static-env'],
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    },
  };
}

/**
 * Generates a deployment manifest for each of the given deploys, and ties them to a build via the buildUUID.
 * @param deploys the deploys to generate deployment manifests for
 * @param buildUUID a string we will use to tie each of these deployments back to a single build
 */
export function generateDeployManifests(
  build: Build,
  deploys: Deploy[],
  buildUUID: string,
  enableFullYaml: boolean,
  namespace: string,
  serviceAccountName: string
) {
  return deploys
    .filter((deploy) => {
      return deploy.active;
    })
    .map((deploy) => {
      const capacityType = build.capacityType
        ? build.capacityType
        : enableFullYaml
        ? deploy.deployable.capacityType
        : deploy?.service.capacityType;
      const isStatic = build?.isStatic ?? false;

      // Extract custom node affinity from schema
      const customNodeAffinity = enableFullYaml ? deploy.deployable.nodeAffinity : deploy?.service.nodeAffinity;
      const affinity = generateAffinity(capacityType, isStatic, customNodeAffinity);
      // Extract node selector from schema
      const nodeSelector = enableFullYaml ? deploy.deployable.nodeSelector : deploy?.service.nodeSelector;

      const { uuid: name, service, deployable } = deploy;
      const ports = [];

      if (enableFullYaml) {
        if (deploy?.deployable.port) {
          // eslint-disable-next-line no-unsafe-optional-chaining
          for (const port of deploy?.deployable.port.split(',')) {
            ports.push({
              name: `port-${port}`,
              containerPort: Number(port),
            });
          }
        }
      } else {
        if (deploy?.service.port) {
          // eslint-disable-next-line no-unsafe-optional-chaining
          for (const port of deploy?.service.port.split(',')) {
            ports.push({
              name: `port-${port}`,
              containerPort: Number(port),
            });
          }
        }
      }
      const containers = [];
      const initContainers = [];
      /**
       * This chunk of code is hard to read. So here's what it does.
       * 1. It merges the deploy environment with the comment based environment.
       * 2. It then filters out any nested values, which aren't supported in Kubernetes.
       * 3. It then flattens out any nulls
       * 4. Handles cloud secret references ({{aws:path:key}} or {{gcp:path:key}})
       */
      const mergedEnv = _.merge(
        { __NAMESPACE__: 'lifecycle' },
        deploy.env || '{}',
        flattenObject(build.commentRuntimeEnv)
      );
      const secretRefs = parseSecretRefsFromEnv(mergedEnv as Record<string, string>);
      const secretRefMap = new Map<string, SecretRefWithEnvKey>();
      for (const ref of secretRefs) {
        secretRefMap.set(ref.envKey, ref);
      }
      const envServiceName = enableFullYaml ? deploy.deployable?.name : deploy.service?.name;

      const env: Array<Record<string, any>> = _.compact(
        _.flatten(
          Object.entries(mergedEnv).map(([key, value]) => {
            // Filter out nested objects which aren't supported
            if (_.isObject(value) === false) {
              const secretRef = secretRefMap.get(key);
              if (secretRef && envServiceName) {
                const secretName = generateSecretName(envServiceName, secretRef.provider);
                return {
                  name: key,
                  valueFrom: {
                    secretKeyRef: {
                      name: secretName,
                      key: key,
                    },
                  },
                };
              }
              return {
                name: key,
                value,
              };
            } else {
              return null;
            }
          })
        )
      );

      env.push(
        {
          name: 'POD_IP',
          valueFrom: {
            fieldRef: {
              fieldPath: 'status.podIP',
            },
          },
        },
        {
          name: 'DD_AGENT_HOST',
          valueFrom: {
            fieldRef: {
              fieldPath: 'status.hostIP',
            },
          },
        }
      );

      // Grab all of the environment keys being injected into this deployments
      const keys = new Set(
        env.map((entry) => {
          return entry.name;
        })
      );

      // Only add DD_ENV if it's not being hand set
      if (!keys.has('DD_ENV')) {
        env.push({
          name: 'DD_ENV',
          valueFrom: {
            fieldRef: {
              fieldPath: "metadata.labels['tags.datadoghq.com/env']",
            },
          },
        });
      }

      // Only add DD_SERVICE if it's not being hand set
      if (!keys.has('DD_SERVICE')) {
        env.push({
          name: 'DD_SERVICE',
          valueFrom: {
            fieldRef: {
              fieldPath: "metadata.labels['tags.datadoghq.com/service']",
            },
          },
        });
      }

      // Only add DD_VERSION if it's not being hand set
      if (!keys.has('DD_VERSION')) {
        env.push({
          name: 'DD_VERSION',
          valueFrom: {
            fieldRef: {
              fieldPath: "metadata.labels['tags.datadoghq.com/version']",
            },
          },
        });
      }

      if (!keys.has('LC_UUID')) {
        env.push({
          name: 'LC_UUID',
          value: build.uuid,
        });
      }

      const applicationContainer: { [key: string]: any } = {
        name,
        image: deploy.dockerImage,
        resources: {
          requests: enableFullYaml
            ? generateResourceRequestsForDeployable(deployable)
            : generateResourceRequestsForService(service),
          limits: enableFullYaml
            ? generateResourceLimitsForDeployable(deployable)
            : generateResourceLimitsForService(service),
        },
        ports,
        env,
      };

      if (enableFullYaml) {
        if (deployable.readinessHttpGetPort || deployable.readinessTcpSocketPort) {
          applicationContainer.readinessProbe = generateReadinessProbeForDeployable(deployable);
          applicationContainer.livenessProbe = generateReadinessProbeForDeployable(deployable);
          // Restarts a pod only after 10 minutes of being granted readiness time
          applicationContainer.livenessProbe.initialDelaySeconds = 600;
        }

        if (deployable.command) {
          applicationContainer.command = [deployable.command];
        }

        if (deployable.arguments) {
          applicationContainer.args = deployable.arguments.split('%%SPLIT%%');
        }
      } else {
        if (service.readinessHttpGetPort || service.readinessTcpSocketPort) {
          applicationContainer.readinessProbe = generateReadinessProbe(service);
          applicationContainer.livenessProbe = generateReadinessProbe(service);
          // Restarts a pod only after 10 minutes of being granted readiness time
          applicationContainer.livenessProbe.initialDelaySeconds = 600;
        }

        if (service.command) {
          applicationContainer.command = [service.command];
        }

        if (service.arguments) {
          applicationContainer.args = service.arguments.split('%%SPLIT%%');
        }
      }

      /* Code specifically for any init container */
      applicationContainer.volumeMounts = [
        {
          mountPath: '/config',
          name: 'config-volume',
        },
      ];

      if (deploy.initDockerImage) {
        const initEnvMerged = _.merge(
          { __NAMESPACE__: 'lifecycle' },
          deploy.initEnv || '{}',
          flattenObject(build.commentInitEnv)
        );
        const initSecretRefs = parseSecretRefsFromEnv(initEnvMerged as Record<string, string>);
        const initSecretRefMap = new Map<string, SecretRefWithEnvKey>();
        for (const ref of initSecretRefs) {
          initSecretRefMap.set(ref.envKey, ref);
        }

        const initEnv: Array<Record<string, any>> = Object.entries(initEnvMerged).map(([key, value]) => {
          const initSecretRef = initSecretRefMap.get(key);
          if (initSecretRef) {
            const initSecretName = generateSecretName(envServiceName, initSecretRef.provider);
            return {
              name: key,
              valueFrom: {
                secretKeyRef: {
                  name: initSecretName,
                  key: key,
                },
              },
            };
          }
          return {
            name: key,
            value,
          };
        });
        initEnv.push(
          {
            name: 'POD_IP',
            valueFrom: {
              fieldRef: {
                fieldPath: 'status.podIP',
              },
            },
          },
          {
            name: 'DD_AGENT_HOST',
            valueFrom: {
              fieldRef: {
                fieldPath: 'status.hostIP',
              },
            },
          }
        );
        const initContainer: { [key: string]: any } = {
          name: `init-${name}`,
          image: deploy.initDockerImage,
          resources: {
            requests: enableFullYaml
              ? generateResourceRequestsForDeployable(deployable)
              : generateResourceRequestsForService(service),
            limits: enableFullYaml
              ? generateResourceLimitsForDeployable(deployable)
              : generateResourceLimitsForService(service),
          },
          ports,
          env: initEnv,
        };

        if (enableFullYaml) {
          if (deployable.initCommand) {
            initContainer.command = [deployable.initCommand];
          }
          if (deployable.initArguments) {
            initContainer.args = deployable.initArguments.split('%%SPLIT%%');
          }
        } else {
          if (service.initCommand) {
            initContainer.command = [service.initCommand];
          }
          if (service.initArguments) {
            initContainer.args = service.initArguments.split('%%SPLIT%%');
          }
        }

        initContainer.volumeMounts = [
          {
            mountPath: '/config',
            name: 'config-volume',
          },
        ];
        initContainers.push(initContainer);
      }
      /* End of code for init container */

      const volumes: VOLUME[] = [
        {
          emptyDir: {},
          name: 'config-volume',
        },
      ];

      let strategy = {
        rollingUpdate: {
          maxUnavailable: '0%',
        },
      };

      if (enableFullYaml) {
        if (deployable?.serviceDisksYaml != null) {
          const serviceDisks: ServiceDiskConfig[] = JSON.parse(deployable.serviceDisksYaml);
          if (serviceDisks != null && serviceDisks.length > 0) {
            strategy = {
              // @ts-ignore
              type: 'Recreate',
            };

            serviceDisks.forEach((disk) => {
              applicationContainer.volumeMounts.push({
                name: `${name}-${disk.name}`,
                mountPath: disk.mountPath,
              });

              // By default, any services disk is EBS type.
              const diskMedium: string = disk.medium != null ? disk.medium : MEDIUM_TYPE.EBS;
              switch (diskMedium) {
                case MEDIUM_TYPE.EBS:
                case MEDIUM_TYPE.DISK:
                  volumes.push({
                    name: `${name}-${disk.name}`,
                    persistentVolumeClaim: {
                      claimName: `${name}-${disk.name}-claim`,
                    },
                  });
                  break;
                case MEDIUM_TYPE.MEMORY:
                  volumes.push({
                    name: `${name}-${disk.name}`,
                    emptyDir: {
                      medium: 'Memory',
                      sizeLimit: `${disk.storageSize}`,
                    },
                  });
                  break;
                default:
                  getLogger({ medium: disk.medium }).warn(`Disk: unknown medium medium=${disk.medium}`);
              }
            });
          }
        }
      } else {
        getLogger({ serviceDisks: service.serviceDisks }).debug('Processing service disks');
        if (service.serviceDisks && service.serviceDisks.length > 0) {
          strategy = {
            // @ts-ignore
            type: 'Recreate',
          };

          service.serviceDisks.forEach((disk) => {
            applicationContainer.volumeMounts.push({
              name: `${name}-${disk.name}`,
              mountPath: disk.mountPath,
            });

            if (disk.medium == null) {
              disk.medium = MEDIUM_TYPE.DISK;
            }

            switch (disk.medium) {
              case MEDIUM_TYPE.DISK:
              case MEDIUM_TYPE.EBS:
                volumes.push({
                  name: `${name}-${disk.name}`,
                  persistentVolumeClaim: {
                    claimName: `${name}-${disk.name}-claim`,
                  },
                });
                break;
              case MEDIUM_TYPE.MEMORY:
                volumes.push({
                  name: `${name}-${disk.name}`,
                  emptyDir: {
                    medium: 'Memory',
                    sizeLimit: `${disk.storage}`,
                  },
                });
                break;
            }
          });
        }
      }

      containers.push(applicationContainer);

      const annotations = {
        'cluster-autoscaler.kubernetes.io/safe-to-evict': 'true',
      };

      const serviceName: string = enableFullYaml ? deploy.deployable.name : deploy.service.name;

      /**
       * Labels for the Kubernetes deployment
       */
      const labels = {
        name: buildUUID,
        lc_uuid: buildUUID,
        'tags.datadoghq.com/env': `lifecycle-${buildUUID}`,
        'tags.datadoghq.com/service': serviceName,
        'tags.datadoghq.com/version': buildUUID,
      };

      /**
       * Labels to be injected into the metadata block inside the
       * spec template
       */
      const metaDataLabels = {
        name,
        lc_uuid: buildUUID,
        dd_name: `lifecycle-${buildUUID}`,
        'tags.datadoghq.com/env': `lifecycle-${buildUUID}`,
        'tags.datadoghq.com/service': serviceName,
        'tags.datadoghq.com/version': buildUUID,
      };

      if (build.isStatic) getLogger().info('Build: static environment=true');

      const yamlManifest = yaml.dump(
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            namespace,
            name,
            annotations,
            labels,
          },
          spec: {
            selector: {
              matchLabels: {
                name,
              },
            },
            revisionHistoryLimit: 5,
            strategy,
            replicas: deploy.replicaCount,
            rollingUpdate: {
              maxSurge: '1',
              maxUnavailable: 0,
            },
            template: {
              metadata: {
                annotations,
                labels: metaDataLabels,
              },
              spec: {
                affinity,
                ...(nodeSelector && { nodeSelector }),
                securityContext: {
                  fsGroup: 2000,
                },
                serviceAccount: serviceAccountName,
                serviceAccountName,
                containers,
                initContainers,
                volumes,
                ...(build?.isStatic && {
                  tolerations: staticEnvTolerations,
                }),
                enableServiceLinks: false,
              },
            },
          },
        },
        { lineWidth: -1, forceQuotes: true }
      );

      return yamlManifest;
    })
    .join('\n---\n');
}

function generateResourceRequestsForService(service: Service): Record<string, string> {
  return _.pickBy(
    {
      memory: service.memoryRequest,
      cpu: service.cpuRequest,
    },
    _.identity
  );
}

function generateResourceLimitsForService(service: Service): Record<string, string> {
  return _.pickBy(
    {
      memory: service.memoryLimit,
      cpu: service.cpuLimit,
    },
    _.identity
  );
}

function generateResourceRequestsForDeployable(deployable: Deployable): Record<string, string> {
  return _.pickBy(
    {
      memory: deployable.memoryRequest,
      cpu: deployable.cpuRequest,
    },
    _.identity
  );
}

function generateResourceLimitsForDeployable(deployable: Deployable): Record<string, string> {
  return _.pickBy(
    {
      memory: deployable.memoryLimit,
      cpu: deployable.cpuLimit,
    },
    _.identity
  );
}

function generateReadinessProbe({
  readinessInitialDelaySeconds: initialDelaySeconds,
  readinessPeriodSeconds: periodSeconds,
  readinessTimeoutSeconds: timeoutSeconds,
  readinessSuccessThreshold: successThreshold,
  readinessFailureThreshold: failureThreshold,
  readinessHttpGetPath: httpGetPath,
  readinessHttpGetPort: httpGetPort,
  readinessTcpSocketPort,
}: Service) {
  const probe = {
    initialDelaySeconds,
    periodSeconds,
    timeoutSeconds,
    successThreshold,
    failureThreshold,
  };
  if (readinessTcpSocketPort) {
    // TCP Check

    probe['tcpSocket'] = {
      port: readinessTcpSocketPort,
    };
  } else if (httpGetPath && httpGetPort) {
    probe['httpGet'] = {
      path: httpGetPath,
      port: httpGetPort,
    };
  } else {
    return {};
  }
  return probe;
}

export function generateReadinessProbeForDeployable({
  readinessInitialDelaySeconds: initialDelaySeconds,
  readinessPeriodSeconds: periodSeconds,
  readinessTimeoutSeconds: timeoutSeconds,
  readinessSuccessThreshold: successThreshold,
  readinessFailureThreshold: failureThreshold,
  readinessHttpGetPath: httpGetPath,
  readinessHttpGetPort: httpGetPort,
  readinessTcpSocketPort,
}: Deployable) {
  const probe = {
    initialDelaySeconds,
    periodSeconds,
    timeoutSeconds,
    successThreshold,
    failureThreshold,
  };
  if (readinessTcpSocketPort) {
    // TCP Check

    probe['tcpSocket'] = {
      port: readinessTcpSocketPort,
    };
  } else if (httpGetPath && httpGetPort) {
    probe['httpGet'] = {
      path: httpGetPath,
      port: httpGetPort,
    };
  } else {
    return {};
  }
  return probe;
}

/**
 * Generates a local nodeport in the namespace for the given deployment. This is primarily used for private services, like a database, which we aren't exposing via a public DNS via argo.
 * @param deploys the deploys to generate manifests for
 * @param buildUUID the associated buildUUID, which we use for deleting a build
 */
export function generateNodePortManifests(
  deploys: Deploy[],
  buildUUID: string,
  enableFullYamlSupport: boolean,
  namespace: string
) {
  return deploys
    .filter((deploy) => {
      return deploy.active;
    })
    .map((deploy) => {
      const name = deploy.uuid;
      const ports = [];

      const servicePort: string = enableFullYamlSupport ? deploy.deployable.port : deploy.service.port;
      if (servicePort) {
        for (const port of servicePort.split(',')) {
          ports.push({
            name: `provided-${port}`,
            port: Number(port),
            targetPort: Number(port),
            protocol: 'TCP',
          });
        }
      }

      const annotations = {};

      return yaml.dump(
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            namespace,
            name,
            labels: {
              name,
              lc_uuid: buildUUID,
              dd_name: `lifecycle-${buildUUID}`,
              'tags.datadoghq.com/env': 'lifecycle',
              'tags.datadoghq.com/service': name,
              'tags.datadoghq.com/version': buildUUID,
            },
            annotations,
          },
          spec: {
            type: 'NodePort',
            selector: {
              name,
            },
            ports,
          },
        },
        { lineWidth: -1 }
      );
    })
    .join('\n---\n');
}

/**
 * Generates a GRPC mapping for active GRPC services
 * @param deploys the deploys to generate manifests for
 * @param buildUUID the associated buildUUID, which we use for deleting a build
 */
export function generateGRPCMappings(deploys: Deploy[], buildUUID: string, enableFullYaml: boolean, namespace: string) {
  return deploys
    .filter((deploy) => {
      const enableGrpc: boolean = enableFullYaml ? deploy.deployable.grpc : deploy.service.grpc;

      return deploy.active && enableGrpc;
    })
    .map((deploy) => {
      const serviceGrpcHost: string = enableFullYaml ? deploy.deployable.grpcHost : deploy.service.grpcHost;
      const servicePort: string = enableFullYaml ? deploy.deployable.port : deploy.service.port;

      const name = deploy.uuid;
      return yaml.dump(
        {
          apiVersion: 'getambassador.io/v3alpha1',
          kind: 'Mapping',
          metadata: {
            namespace,
            name,
            labels: {
              name,
              lc_uuid: buildUUID,
              dd_name: `lifecycle-${buildUUID}`,
              'tags.datadoghq.com/env': 'lifecycle',
              'tags.datadoghq.com/service': name,
              'tags.datadoghq.com/version': buildUUID,
            },
          },
          spec: {
            grpc: true,
            hostname: `${deploy.uuid}.${serviceGrpcHost}:443`,
            prefix: '/',
            service: `${deploy.uuid}:${servicePort}`,
            timeout_ms: 20000,
          },
        },
        { lineWidth: -1 }
      );
    })
    .join('\n---\n');
}

/**
 * Generates a local nodeport in the namespace for the given deployment. This is primarily used for private services, like a database, which we aren't exposing via a public DNS via argo.
 * @param deploys the deploys to generate manifests for
 * @param buildUUID the associated buildUUID, which we use for deleting a build
 */
export function generateExternalNameManifests(deploys: Deploy[], buildUUID: string, namespace: string) {
  return deploys
    .filter((deploy) => {
      if (deploy.active) {
        getLogger({ deployId: deploy.id, cname: deploy.cname }).debug('Checking deploy for external service');
        return deploy.cname !== undefined && deploy.cname !== null;
      }
    })
    .map((deploy) => {
      const name = deploy.uuid;
      getLogger().debug('Creating external service');
      return yaml.dump(
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            namespace,
            name,
            labels: {
              lc_uuid: buildUUID,
              name: buildUUID,
            },
          },
          spec: {
            type: 'ExternalName',
            externalName: deploy.cname,
          },
        },
        { lineWidth: -1 }
      );
    })
    .join('\n---\n');
}

/**
 * Generates a local nodeport in the namespace for the given deployment. This is primarily used for private services, like a database, which we aren't exposing via a public DNS via argo.
 * @param deploys the deploys to generate manifests for
 * @param buildUUID the associated buildUUID, which we use for deleting a build
 */
export function generateLoadBalancerManifests(
  deploys: Deploy[],
  buildUUID: string,
  enableFullYamlSupport: boolean,
  namespace: string
) {
  return deploys
    .filter((deploy) => {
      return deploy.active;
    })
    .map((deploy) => {
      const name = deploy.uuid;
      const servicePort = enableFullYamlSupport ? deploy.deployable.port : deploy.service.port;

      const ports = [];
      if (servicePort) {
        for (const port of servicePort.split(',')) {
          ports.push({
            name: `http-port-${port}`,
            port: Number(port),
            targetPort: Number(port),
            protocol: 'TCP',
          });
        }
      }

      return yaml.dump(
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            namespace,
            name: `internal-lb-${name}`,
            labels: {
              name: buildUUID,
              lc_uuid: buildUUID,
            },
          },
          spec: {
            selector: {
              name,
            },
            ports,
          },
        },
        { lineWidth: -1 }
      );
    })
    .join('\n---\n');
}
export async function checkKubernetesStatus(build: Build) {
  const command: string = `kubectl --namespace ${build.namespace} get pods | grep ${build.uuid}`;
  let status: string = '';
  try {
    status += (await shellPromise(command)) + '\n';
  } catch (err) {
    getLogger({ command, error: err }).debug('Error executing kubectl command');
  }

  return status;
}

interface IngressData {
  metadata?: {
    annotations?: {
      'nginx.ingress.kubernetes.io/configuration-snippet'?: string;
    };
  };
}

async function getExistingIngress(ingressName: string, namespace: string): Promise<IngressData | null> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const k8sApi = kc.makeApiClient(k8s.NetworkingV1Api);

  try {
    const response = await k8sApi.readNamespacedIngress(ingressName, namespace);
    return response.body;
  } catch (error) {
    getLogger({ ingressName, namespace, error }).warn('Ingress: fetch failed');
    return null;
  }
}

export async function patchIngress(ingressName: string, bannerSnippet: any, namespace: string): Promise<void> {
  try {
    const existingIngress = await getExistingIngress(ingressName, namespace);
    const existingSnippet =
      existingIngress?.metadata?.annotations?.['nginx.ingress.kubernetes.io/configuration-snippet'];

    const newSnippet =
      (bannerSnippet.metadata?.annotations?.['nginx.ingress.kubernetes.io/configuration-snippet'] as string) || '';

    let finalSnippet: string;
    if (existingSnippet) {
      const cleanExistingSnippet = existingSnippet.trim().replace(/;*$/, '');
      const cleanNewSnippet = newSnippet.trim().replace(/;*$/, '');

      finalSnippet = `${cleanExistingSnippet};\n${cleanNewSnippet}`;
    } else {
      finalSnippet = newSnippet;
    }

    if (!finalSnippet.trim().endsWith(';')) {
      finalSnippet = `${finalSnippet.trim()};`;
    }

    const finalPatch = {
      metadata: {
        annotations: {
          'nginx.ingress.kubernetes.io/configuration-snippet': finalSnippet,
        },
      },
    };

    const bannerPatch = yaml.dump(finalPatch, { skipInvalid: true });
    const localPath = `${TMP_PATH}/banner/${ingressName}-banner.yaml`;

    await fs.promises.mkdir(`${TMP_PATH}/banner/`, {
      recursive: true,
    });

    await fs.promises.writeFile(localPath, bannerPatch, 'utf8');

    await shellPromise(
      `kubectl patch ingress ${ingressName} --namespace ${namespace} --type merge --patch-file ${localPath}`
    );

    getLogger({ ingressName, namespace }).info('Deploy: ingress patched');
  } catch (error) {
    getLogger({ ingressName, namespace, error }).warn('Ingress: patch failed (banner may not work)');
    throw error;
  }
}

/**
 * Updates a secret
 * @param secretName the name of the secret
 * @param secretData the data to update the secret with
 * @param namespace the namespace to update the secret in
 */
export async function updateSecret(secretName: string, secretData: Record<string, string>, namespace: string) {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

    const secret = await k8sApi.readNamespacedSecret(secretName, namespace);
    const secretObject = secret.body;

    const existing = secretObject.data;
    const updated = { ...existing };
    for (const [key, value] of Object.entries(secretData)) {
      updated[key] = Buffer.from(String(value), 'utf8').toString('base64');
    }
    secretObject.data = updated;
    await k8sApi.replaceNamespacedSecret(secretName, namespace, secretObject);
  } catch (error) {
    getLogger({ secretName, namespace, error }).error('Secret: update failed');
    throw error;
  }
}

/**
 * Gets the current namespace from the file system
 * This is used to get the namespace of the pod that is running the code
 * @returns the current namespace
 */
export function getCurrentNamespaceFromFile(): string {
  try {
    return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
  } catch (err) {
    getLogger({ error: err }).error('Namespace: file read failed');
    return 'default';
  }
}

export function generateDeployManifest({
  deploy,
  build,
  namespace,
  serviceAccountName,
}: {
  deploy: Deploy;
  build: Build;
  namespace: string;
  serviceAccountName: string;
}): string {
  const manifests: string[] = [];
  const enableFullYaml = build.enableFullYaml;

  // ExternalName service for CLI deploys
  // return the ExternalName service if we have a cname
  if (CLIDeployTypes.has(deploy.deployable?.type)) {
    const externalHost = deploy.cname;
    if (externalHost) {
      return yaml.dump({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          namespace,
          name: deploy.uuid,
          labels: {
            name: build.uuid,
            lc_uuid: build.uuid,
            deploy_uuid: deploy.uuid,
          },
        },
        spec: {
          type: 'ExternalName',
          externalName: externalHost,
        },
      });
    } else {
      getLogger().info('Manifest: skipped reason=empty');
      return '';
    }
  }

  // Reuse existing PVC generation logic
  const pvcManifests = generatePersistentDisks([deploy], build.uuid, enableFullYaml, namespace);
  if (pvcManifests) manifests.push(pvcManifests);

  // Generate deployment with custom node affinity
  const capacityType =
    build.capacityType || (enableFullYaml ? deploy.deployable?.capacityType : deploy.service?.capacityType);

  // Extract custom node affinity from schema
  const customNodeAffinity = enableFullYaml ? deploy.deployable?.nodeAffinity : deploy.service?.nodeAffinity;

  const affinity = generateAffinity(capacityType, build?.isStatic ?? false, customNodeAffinity);

  const deploymentManifest = generateSingleDeploymentManifest({
    deploy,
    build,
    name: deploy.uuid,
    namespace,
    serviceAccountName,
    affinity,
    enableFullYaml,
  });
  manifests.push(deploymentManifest);

  // Reuse existing service generation logic
  const serviceManifests = generateNodePortManifests([deploy], build.uuid, enableFullYaml, namespace);
  if (serviceManifests) manifests.push(serviceManifests);

  const lbManifests = generateLoadBalancerManifests([deploy], build.uuid, enableFullYaml, namespace);
  if (lbManifests) manifests.push(lbManifests);

  const grpcManifests = generateGRPCMappings([deploy], build.uuid, enableFullYaml, namespace);
  if (grpcManifests) manifests.push(grpcManifests);

  return manifests.filter((m) => m).join('---\n');
}

function generateSingleDeploymentManifest({
  deploy,
  build,
  name,
  namespace,
  serviceAccountName,
  affinity,
  enableFullYaml,
}: {
  deploy: Deploy;
  build: Build;
  name: string;
  namespace: string;
  serviceAccountName: string;
  affinity: any;
  enableFullYaml: boolean;
}): string {
  const serviceName = enableFullYaml ? deploy.deployable?.name : deploy.service?.name;
  const serviceMemory = enableFullYaml ? deploy.deployable?.memoryLimit : deploy.service?.memoryLimit;
  const serviceCPU = enableFullYaml ? deploy.deployable?.cpuLimit : deploy.service?.cpuLimit;
  const servicePort = enableFullYaml ? deploy.deployable?.port : deploy.service?.port;
  const replicaCount = deploy.replicaCount ?? 1;

  // Extract node selector from schema
  const nodeSelector = enableFullYaml ? deploy.deployable?.nodeSelector : deploy.service?.nodeSelector;

  const envToUse = deploy.env || {};
  const containers: Array<Record<string, any>> = [];
  const initContainers: Array<Record<string, any>> = [];

  const volumes: VOLUME[] = [
    {
      emptyDir: {},
      name: 'config-volume',
    },
  ];
  const volumeMounts: Array<{ name: string; mountPath: string }> = [];

  const datadogLabels = {
    'tags.datadoghq.com/env': `lifecycle-${build.uuid}`,
    'tags.datadoghq.com/service': serviceName || name,
    'tags.datadoghq.com/version': build.uuid,
  };

  // Handle init container if present
  if (deploy.initDockerImage) {
    const initEnvObj = _.merge(
      { __NAMESPACE__: 'lifecycle' },
      deploy.initEnv || {},
      flattenObject(build.commentInitEnv)
    );

    const initSecretRefs = parseSecretRefsFromEnv(initEnvObj as Record<string, string>);
    const initSecretRefMap = new Map<string, SecretRefWithEnvKey>();
    for (const ref of initSecretRefs) {
      initSecretRefMap.set(ref.envKey, ref);
    }

    const initEnvArray: Array<Record<string, any>> = Object.entries(initEnvObj)
      .filter(([, value]) => !_.isObject(value))
      .map(([key, value]) => {
        const secretRef = initSecretRefMap.get(key);
        if (secretRef) {
          const secretRefName = generateSecretName(serviceName || 'service', secretRef.provider);
          return {
            name: key,
            valueFrom: {
              secretKeyRef: {
                name: secretRefName,
                key: key,
              },
            },
          };
        }
        return {
          name: key,
          value: String(value),
        };
      });

    initEnvArray.push(
      {
        name: 'POD_IP',
        valueFrom: {
          fieldRef: {
            fieldPath: 'status.podIP',
          },
        },
      },
      {
        name: 'DD_AGENT_HOST',
        valueFrom: {
          fieldRef: {
            fieldPath: 'status.hostIP',
          },
        },
      }
    );

    const initContainer: Record<string, any> = {
      name: `init-${serviceName || 'container'}`,
      image: deploy.initDockerImage,
      imagePullPolicy: 'IfNotPresent',
      env: initEnvArray,
      volumeMounts: [
        {
          mountPath: '/config',
          name: 'config-volume',
        },
      ],
    };

    if (serviceCPU || serviceMemory) {
      initContainer.resources = {
        limits: {},
        requests: {},
      };
      if (serviceCPU) {
        initContainer.resources.limits.cpu = serviceCPU;
        initContainer.resources.requests.cpu = serviceCPU;
      }
      if (serviceMemory) {
        initContainer.resources.limits.memory = serviceMemory;
        initContainer.resources.requests.memory = serviceMemory;
      }
    }

    if (servicePort) {
      initContainer.ports = [];
      for (const port of servicePort.split(',')) {
        initContainer.ports.push({
          name: `port-${port}`,
          containerPort: Number(port),
        });
      }
    }

    if (enableFullYaml) {
      if (deploy.deployable?.initCommand) {
        initContainer.command = [deploy.deployable.initCommand];
      }
      if (deploy.deployable?.initArguments) {
        initContainer.args = deploy.deployable.initArguments.split('%%SPLIT%%');
      }
    }

    initContainers.push(initContainer);
  }

  // Handle main container
  const mainEnvObj = _.merge({ __NAMESPACE__: 'lifecycle' }, envToUse, flattenObject(build.commentRuntimeEnv));
  const mainSecretRefs = parseSecretRefsFromEnv(mainEnvObj as Record<string, string>);
  const mainSecretRefMap = new Map<string, SecretRefWithEnvKey>();
  for (const ref of mainSecretRefs) {
    mainSecretRefMap.set(ref.envKey, ref);
  }

  const mainEnvArray: Array<Record<string, any>> = Object.entries(mainEnvObj)
    .filter(([, value]) => !_.isObject(value))
    .map(([key, value]) => {
      const secretRef = mainSecretRefMap.get(key);
      if (secretRef) {
        const secretRefName = generateSecretName(serviceName || 'service', secretRef.provider);
        return {
          name: key,
          valueFrom: {
            secretKeyRef: {
              name: secretRefName,
              key: key,
            },
          },
        };
      }
      return {
        name: key,
        value: String(value),
      };
    });

  // Add Kubernetes field references for pod metadata
  mainEnvArray.push(
    {
      name: 'POD_IP',
      valueFrom: {
        fieldRef: {
          fieldPath: 'status.podIP',
        },
      },
    },
    {
      name: 'DD_AGENT_HOST',
      valueFrom: {
        fieldRef: {
          fieldPath: 'status.hostIP',
        },
      },
    }
  );

  // Add Datadog env vars from labels (only if not already set)
  const existingEnvKeys = new Set(mainEnvArray.map((e) => e.name));
  if (!existingEnvKeys.has('DD_ENV')) {
    mainEnvArray.push({
      name: 'DD_ENV',
      valueFrom: {
        fieldRef: {
          fieldPath: "metadata.labels['tags.datadoghq.com/env']",
        },
      },
    });
  }
  if (!existingEnvKeys.has('DD_SERVICE')) {
    mainEnvArray.push({
      name: 'DD_SERVICE',
      valueFrom: {
        fieldRef: {
          fieldPath: "metadata.labels['tags.datadoghq.com/service']",
        },
      },
    });
  }
  if (!existingEnvKeys.has('DD_VERSION')) {
    mainEnvArray.push({
      name: 'DD_VERSION',
      valueFrom: {
        fieldRef: {
          fieldPath: "metadata.labels['tags.datadoghq.com/version']",
        },
      },
    });
  }
  if (!existingEnvKeys.has('LC_UUID')) {
    mainEnvArray.push({
      name: 'LC_UUID',
      value: build.uuid,
    });
  }

  const mainContainer: any = {
    name: serviceName || 'main',
    image: deploy.dockerImage,
    imagePullPolicy: 'IfNotPresent',
    env: mainEnvArray,
    volumeMounts: [
      {
        mountPath: '/config',
        name: 'config-volume',
      },
    ],
  };

  // Only add resources if they are defined
  if (serviceCPU || serviceMemory) {
    mainContainer.resources = {
      limits: {},
      requests: {},
    };

    if (serviceCPU) {
      mainContainer.resources.limits.cpu = serviceCPU;
      mainContainer.resources.requests.cpu = serviceCPU;
    }

    if (serviceMemory) {
      mainContainer.resources.limits.memory = serviceMemory;
      mainContainer.resources.requests.memory = serviceMemory;
    }
  }

  // Add ports if defined
  if (servicePort) {
    mainContainer.ports = [];
    for (const port of servicePort.split(',')) {
      mainContainer.ports.push({
        name: `port-${port}`,
        containerPort: Number(port),
      });
    }
  }

  // Handle additional volumes (service disks)
  let hasPersistentVolumeClaims = false;

  if (enableFullYaml && deploy.deployable?.serviceDisksYaml) {
    const serviceDisks: ServiceDiskConfig[] = JSON.parse(deploy.deployable.serviceDisksYaml);
    serviceDisks.forEach((disk) => {
      if (disk.medium === MEDIUM_TYPE.MEMORY) {
        volumes.push({
          name: disk.name,
          emptyDir: {},
        });
      } else {
        // EBS or other persistent disk - requires Recreate strategy
        hasPersistentVolumeClaims = true;
        volumes.push({
          name: disk.name,
          persistentVolumeClaim: {
            claimName: `${name}-${disk.name}-claim`,
          },
        });
      }
      volumeMounts.push({
        name: disk.name,
        mountPath: disk.mountPath,
      });
    });
  } else if (!enableFullYaml && deploy.service?.serviceDisks) {
    deploy.service.serviceDisks.forEach((disk) => {
      if (disk.medium === MEDIUM_TYPE.MEMORY) {
        volumes.push({
          name: disk.name,
          emptyDir: {},
        });
      } else {
        // EBS or other persistent disk - requires Recreate strategy
        hasPersistentVolumeClaims = true;
        volumes.push({
          name: disk.name,
          persistentVolumeClaim: {
            claimName: `${name}-${disk.name}-claim`,
          },
        });
      }
      volumeMounts.push({
        name: disk.name,
        mountPath: disk.mountPath,
      });
    });
  }

  // Add additional volume mounts to main container
  if (volumeMounts.length > 0) {
    mainContainer.volumeMounts = [...mainContainer.volumeMounts, ...volumeMounts];
  }

  // Add probes
  if (enableFullYaml) {
    if (deploy.deployable?.livenessProbe) {
      mainContainer.livenessProbe = JSON.parse(deploy.deployable.livenessProbe);
    }
    if (deploy.deployable?.readinessProbe) {
      mainContainer.readinessProbe = JSON.parse(deploy.deployable.readinessProbe);
    }
  } else {
    if (deploy.service?.livenessProbe) {
      mainContainer.livenessProbe = JSON.parse(deploy.service.livenessProbe);
    }
    if (deploy.service?.readinessProbe) {
      mainContainer.readinessProbe = JSON.parse(deploy.service.readinessProbe);
    }
  }

  // Add command/args if specified
  if (enableFullYaml) {
    if (deploy.deployable?.command) {
      mainContainer.command = [deploy.deployable.command];
    }
    if (deploy.deployable?.arguments) {
      mainContainer.args = deploy.deployable.arguments.split('%%SPLIT%%');
    }
  }

  containers.push(mainContainer);

  const deploymentSpec: any = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      namespace,
      name,
      annotations: {
        'cluster-autoscaler.kubernetes.io/safe-to-evict': 'true',
      },
      labels: {
        name,
        lc_uuid: build.uuid,
        deploy_uuid: deploy.uuid,
        dd_name: `lifecycle-${build.uuid}`,
        'app.kubernetes.io/instance': `${serviceName}-${build.uuid}`,
        ...datadogLabels,
      },
    },
    spec: {
      replicas: replicaCount,
      revisionHistoryLimit: 5,
      selector: {
        matchLabels: {
          name,
        },
      },
      // Use Recreate strategy for deployments with PVCs (EBS volumes can only attach to one pod)
      // Use RollingUpdate for all other deployments
      strategy: hasPersistentVolumeClaims ? { type: 'Recreate' } : { rollingUpdate: { maxUnavailable: '0%' } },
      template: {
        metadata: {
          annotations: {
            'cluster-autoscaler.kubernetes.io/safe-to-evict': 'true',
          },
          labels: {
            name,
            lc_uuid: build.uuid,
            deploy_uuid: deploy.uuid,
            dd_name: `lifecycle-${build.uuid}`,
            'app.kubernetes.io/instance': `${serviceName}-${build.uuid}`,
            ...datadogLabels,
          },
        },
        spec: {
          serviceAccountName,
          affinity,
          ...(nodeSelector && { nodeSelector }),
          securityContext: {
            fsGroup: 2000,
          },
          ...(initContainers.length > 0 && { initContainers }),
          containers,
          volumes,
          ...(build?.isStatic && {
            tolerations: staticEnvTolerations,
          }),
          enableServiceLinks: false,
        },
      },
    },
  };

  return yaml.dump(deploymentSpec, { lineWidth: -1 });
}

export async function waitForDeployPodReady(deploy: Deploy): Promise<boolean> {
  const { uuid, build } = deploy;
  const { namespace } = build;
  const deployableName = deploy.deployable?.name || deploy.service?.name || 'unknown';

  const logCtx = { deployUuid: uuid, service: deployableName, namespace };

  let retries = 0;
  getLogger(logCtx).info('Deploy: waiting for pods');

  while (retries < 60) {
    const k8sApi = getK8sApi();
    const resp = await k8sApi?.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `deploy_uuid=${uuid}`
    );
    const allPods = resp?.body?.items || [];
    const pods = allPods.filter((pod) => !pod.metadata?.name?.includes('-deploy-'));

    if (pods.length > 0) {
      break;
    }

    retries += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (retries >= 60) {
    getLogger(logCtx).warn('Pod: not found timeout=5m');
    return false;
  }

  retries = 0;

  while (retries < 180) {
    const k8sApi = getK8sApi();
    const resp = await k8sApi?.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `deploy_uuid=${uuid}`
    );
    const allPods = resp?.body?.items || [];
    const pods = allPods.filter((pod) => !pod.metadata?.name?.includes('-deploy-'));

    if (pods.length === 0) {
      getLogger(logCtx).warn('Pod: deployment pods not found');
      return false;
    }

    const allReady = pods.every((pod) => {
      const conditions = pod.status?.conditions || [];
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      return readyCondition?.status === 'True';
    });

    if (allReady) {
      getLogger({ ...logCtx, podCount: pods.length }).info('Deploy: pods ready');
      return true;
    }

    retries += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }

  getLogger(logCtx).warn('Pod: not ready timeout=15m');
  return false;
}
