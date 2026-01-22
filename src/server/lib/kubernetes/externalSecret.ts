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
import { shellPromise } from 'server/lib/shell';
import { getLogger } from 'server/lib/logger';
import { SecretRefWithEnvKey } from 'server/lib/secretRefs';
import { SecretProviderConfig } from 'server/services/types/globalConfig';

export interface ExternalSecretManifest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    refreshInterval: string;
    secretStoreRef: {
      name: string;
      kind: string;
    };
    target: {
      name: string;
    };
    data: Array<{
      secretKey: string;
      remoteRef: {
        key: string;
        property?: string;
      };
    }>;
  };
}

export interface GenerateExternalSecretOptions {
  name: string;
  namespace: string;
  provider: string;
  secretRefs: SecretRefWithEnvKey[];
  providerConfig: SecretProviderConfig;
  buildUuid?: string;
}

const MAX_NAME_LENGTH = 63;

export function generateSecretName(serviceName: string, provider: string): string {
  const suffix = `-${provider}-secrets`;
  const maxServiceNameLength = MAX_NAME_LENGTH - suffix.length;

  let truncatedName = serviceName.substring(0, maxServiceNameLength);

  if (truncatedName.endsWith('-')) {
    truncatedName = truncatedName.slice(0, -1);
  }

  return `${truncatedName}${suffix}`;
}

export function groupSecretRefsByProvider(refs: SecretRefWithEnvKey[]): Record<string, SecretRefWithEnvKey[]> {
  const grouped: Record<string, SecretRefWithEnvKey[]> = {};

  for (const ref of refs) {
    if (!grouped[ref.provider]) {
      grouped[ref.provider] = [];
    }
    grouped[ref.provider].push(ref);
  }

  return grouped;
}

export function generateExternalSecretManifest(options: GenerateExternalSecretOptions): ExternalSecretManifest {
  const { name, namespace, provider, secretRefs, providerConfig, buildUuid } = options;

  const secretName = generateSecretName(name, provider);

  const data = secretRefs.map((ref) => {
    const entry: { secretKey: string; remoteRef: { key: string; property?: string } } = {
      secretKey: ref.envKey,
      remoteRef: {
        key: ref.path,
      },
    };

    if (ref.key) {
      entry.remoteRef.property = ref.key;
    }

    return entry;
  });

  const labels: Record<string, string> = {
    'app.kubernetes.io/managed-by': 'lifecycle',
    'lfc/secret-provider': provider,
  };

  if (buildUuid) {
    labels['lfc/uuid'] = buildUuid;
  }

  return {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ExternalSecret',
    metadata: {
      name: secretName,
      namespace,
      labels,
    },
    spec: {
      refreshInterval: providerConfig.refreshInterval,
      secretStoreRef: {
        name: providerConfig.clusterSecretStore,
        kind: 'ClusterSecretStore',
      },
      target: {
        name: secretName,
      },
      data,
    },
  };
}

const MANIFEST_PATH = '/tmp/lifecycle/manifests/externalsecrets';

export async function applyExternalSecret(manifest: ExternalSecretManifest, namespace: string): Promise<void> {
  const manifestYaml = yaml.dump(manifest);
  const fileName = `${manifest.metadata.name}.yaml`;
  const localPath = `${MANIFEST_PATH}/${fileName}`;

  await fs.promises.mkdir(MANIFEST_PATH, { recursive: true });
  await fs.promises.writeFile(localPath, manifestYaml, 'utf8');

  getLogger().info(`ExternalSecret: applying name=${manifest.metadata.name} namespace=${namespace}`);

  await shellPromise(`kubectl apply -f ${localPath} --namespace ${namespace}`);
}

export async function deleteExternalSecret(name: string, namespace: string): Promise<void> {
  getLogger().info(`ExternalSecret: deleting name=${name} namespace=${namespace}`);

  try {
    await shellPromise(`kubectl delete externalsecret ${name} --namespace ${namespace} --ignore-not-found`);
  } catch (error) {
    getLogger().warn({ error }, `ExternalSecret: delete failed name=${name}`);
  }
}
