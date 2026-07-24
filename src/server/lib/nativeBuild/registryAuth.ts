/**
 * Copyright 2026 GoodRx, Inc.
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

import * as k8s from '@kubernetes/client-node';
import { GoogleAuth } from 'google-auth-library';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';
import { buildNativeBuildJobName, KUBERNETES_NAME_MAX_LENGTH } from 'server/lib/kubernetes/jobNames';
import { getLogger } from 'server/lib/logger';

export interface GarRegistryAuth {
  type: 'gar';
  registry: string;
}

export const DOCKER_CONFIG_VOLUME_NAME = 'docker-config';
export const DOCKER_CONFIG_MOUNT_PATH = '/docker-config';
export const KANIKO_DOCKER_CONFIG_MOUNT_PATH = '/kaniko/.docker';

const GAR_DOCKER_USERNAME = 'oauth2accesstoken';
const GAR_REGISTRY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-docker\.pkg\.dev$/;
const ECR_REGISTRY_PATTERN = /^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/;
const REGISTRY_AUTH_SECRET_SUFFIX = '-registry-auth';
const REGISTRY_AUTH_SOURCE_VOLUME_NAME = 'registry-auth-source';
const REGISTRY_AUTH_SOURCE_MOUNT_PATH = '/registry-auth';
const GOOGLE_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

function formatRegistryList(registryAuth: GarRegistryAuth[]): string {
  return registryAuth.map(({ registry }) => registry).join(',');
}

export function normalizeNativeBuildRegistryAuth(value: unknown): GarRegistryAuth[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('Build: invalid registryAuth configuration expected=array');
  }

  const seenRegistries = new Set<string>();

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Build: invalid registryAuth entry index=${index} expected=object`);
    }

    const { registry, type } = entry as Record<string, unknown>;
    if (type !== 'gar') {
      throw new Error(`Build: unsupported registryAuth provider index=${index} type=${String(type)}`);
    }

    if (typeof registry !== 'string') {
      throw new Error(`Build: invalid GAR registry index=${index} expected=hostname`);
    }

    const normalizedRegistry = registry.trim().toLowerCase();
    if (!GAR_REGISTRY_PATTERN.test(normalizedRegistry)) {
      throw new Error(`Build: invalid GAR registry index=${index} registry=${normalizedRegistry} expected=hostname`);
    }

    if (seenRegistries.has(normalizedRegistry)) {
      throw new Error(`Build: duplicate GAR registry registry=${normalizedRegistry}`);
    }

    seenRegistries.add(normalizedRegistry);
    return {
      type: 'gar',
      registry: normalizedRegistry,
    };
  });
}

export function getRegistryHost(reference: string): string {
  return reference.split('/')[0].trim().toLowerCase();
}

export function isConfiguredGarRegistry(reference: string, registryAuth: GarRegistryAuth[]): boolean {
  const host = getRegistryHost(reference);
  return registryAuth.some(({ registry }) => registry === host);
}

export function isEcrRegistry(reference: string): boolean {
  return ECR_REGISTRY_PATTERN.test(getRegistryHost(reference));
}

export function getKanikoInsecureRegistries(references: string[], registryAuth: GarRegistryAuth[]): string[] {
  return [
    ...new Set(
      references
        .map(getRegistryHost)
        .filter((registry) => registry && registry !== 'undefined')
        .filter((registry) => !isConfiguredGarRegistry(registry, registryAuth) && !isEcrRegistry(registry))
    ),
  ];
}

export function buildNativeBuildRegistryAuthSecretName({
  deployUuid,
  jobId,
  shortSha,
}: {
  deployUuid: string;
  jobId: string;
  shortSha: string;
}): string {
  const jobName = buildNativeBuildJobName({
    deployUuid,
    jobId,
    shortSha,
    maxLength: KUBERNETES_NAME_MAX_LENGTH - REGISTRY_AUTH_SECRET_SUFFIX.length,
  });

  return `${jobName}${REGISTRY_AUTH_SECRET_SUFFIX}`;
}

export function createRegistryAuthVolumes(secretName: string): any[] {
  return [
    {
      name: REGISTRY_AUTH_SOURCE_VOLUME_NAME,
      secret: {
        secretName,
        items: [
          {
            key: '.dockerconfigjson',
            path: '.dockerconfigjson',
          },
        ],
      },
    },
    {
      name: DOCKER_CONFIG_VOLUME_NAME,
      emptyDir: {},
    },
  ];
}

export function createRegistryAuthCopyInitContainer(): any {
  return {
    name: 'registry-auth-copy',
    image: 'alpine:3.18',
    command: ['/bin/sh', '-c'],
    args: [
      `set -e
mkdir -p ${DOCKER_CONFIG_MOUNT_PATH}
cp ${REGISTRY_AUTH_SOURCE_MOUNT_PATH}/.dockerconfigjson ${DOCKER_CONFIG_MOUNT_PATH}/config.json
chmod 600 ${DOCKER_CONFIG_MOUNT_PATH}/config.json`,
    ],
    volumeMounts: [
      {
        name: REGISTRY_AUTH_SOURCE_VOLUME_NAME,
        mountPath: REGISTRY_AUTH_SOURCE_MOUNT_PATH,
        readOnly: true,
      },
      {
        name: DOCKER_CONFIG_VOLUME_NAME,
        mountPath: DOCKER_CONFIG_MOUNT_PATH,
      },
    ],
  };
}

export function createKanikoRegistryAuthMergeInitContainer(): any {
  return {
    name: 'registry-auth-merge',
    image: 'alpine:3.18',
    command: ['/bin/sh', '-c'],
    args: [
      `set -e
apk add --no-cache jq
jq -s '.[0] * .[1]' ${DOCKER_CONFIG_MOUNT_PATH}/config.json ${DOCKER_CONFIG_MOUNT_PATH}/ecr-config.json > ${DOCKER_CONFIG_MOUNT_PATH}/config.json.tmp
mv ${DOCKER_CONFIG_MOUNT_PATH}/config.json.tmp ${DOCKER_CONFIG_MOUNT_PATH}/config.json
rm ${DOCKER_CONFIG_MOUNT_PATH}/ecr-config.json`,
    ],
    volumeMounts: [
      {
        name: DOCKER_CONFIG_VOLUME_NAME,
        mountPath: DOCKER_CONFIG_MOUNT_PATH,
      },
    ],
  };
}

export function buildGarDockerConfig(registryAuth: GarRegistryAuth[], accessToken: string): string {
  const auth = Buffer.from(`${GAR_DOCKER_USERNAME}:${accessToken}`, 'utf8').toString('base64');

  return JSON.stringify({
    auths: Object.fromEntries(registryAuth.map(({ registry }) => [registry, { auth }])),
  });
}

export async function createNativeBuildRegistryAuthSecret({
  namespace,
  secretName,
  registryAuth,
  buildUuid,
  deployUuid,
}: {
  namespace: string;
  secretName: string;
  registryAuth: GarRegistryAuth[];
  buildUuid?: string;
  deployUuid: string;
}): Promise<void> {
  let accessToken: string | null | undefined;

  try {
    const auth = new GoogleAuth({ scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE] });
    accessToken = await auth.getAccessToken();
  } catch {
    throw new Error(
      `Build: GAR access token acquisition failed registries=${formatRegistryList(
        registryAuth
      )} verify=google_application_default_credentials`
    );
  }

  if (!accessToken) {
    throw new Error(
      `Build: GAR access token acquisition failed registries=${formatRegistryList(
        registryAuth
      )} verify=google_application_default_credentials`
    );
  }

  const secret: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace,
      labels: {
        ...buildLifecycleLabels({ buildUuid, deployUuid }),
        'app.kubernetes.io/component': 'native-build-registry-auth',
      },
    },
    type: 'kubernetes.io/dockerconfigjson',
    stringData: {
      '.dockerconfigjson': buildGarDockerConfig(registryAuth, accessToken),
    },
  };

  try {
    await getCoreApi().createNamespacedSecret(namespace, secret);
    getLogger().info(`Build: registry auth prepared secretName=${secretName} namespace=${namespace}`);
  } catch {
    throw new Error(`Build: registry auth Secret creation failed secretName=${secretName} namespace=${namespace}`);
  }
}

export async function deleteNativeBuildRegistryAuthSecret(namespace: string, secretName: string): Promise<void> {
  try {
    await getCoreApi().deleteNamespacedSecret(secretName, namespace);
    getLogger().info(`Build: registry auth cleaned secretName=${secretName} namespace=${namespace}`);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      return;
    }

    getLogger().warn(`Build: registry auth cleanup failed secretName=${secretName} namespace=${namespace}`);
  }
}
