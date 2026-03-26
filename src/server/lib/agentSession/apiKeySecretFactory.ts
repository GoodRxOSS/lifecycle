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

import * as k8s from '@kubernetes/client-node';
import { getLogger } from 'server/lib/logger';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

export async function createAgentApiKeySecret(
  namespace: string,
  secretName: string,
  apiKey: string,
  githubToken?: string | null,
  buildUuid?: string,
  forwardedEnv?: Record<string, string>
): Promise<k8s.V1Secret> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  const secret: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace,
      labels: {
        ...buildLifecycleLabels({ buildUuid }),
        'app.kubernetes.io/component': 'agent-session-secret',
      },
    },
    type: 'Opaque',
    stringData: {
      ANTHROPIC_API_KEY: apiKey,
      ...(githubToken
        ? {
            GITHUB_TOKEN: githubToken,
          }
        : {}),
      ...(forwardedEnv || {}),
    },
  };

  const { body: result } = await coreApi.createNamespacedSecret(namespace, secret);
  logger.info(`apiKeySecretFactory: created Secret name=${secretName} namespace=${namespace}`);
  return result;
}

export async function deleteAgentApiKeySecret(namespace: string, secretName: string): Promise<void> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  try {
    await coreApi.deleteNamespacedSecret(secretName, namespace);
    logger.info(`apiKeySecretFactory: deleted Secret name=${secretName} namespace=${namespace}`);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      logger.info(`apiKeySecretFactory: Secret not found (already deleted) name=${secretName} namespace=${namespace}`);
      return;
    }

    throw error;
  }
}
