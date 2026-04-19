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
import {
  SESSION_WORKSPACE_EDITOR_PORT,
  SESSION_WORKSPACE_GATEWAY_PORT_NAME,
  SESSION_WORKSPACE_GATEWAY_PORT,
} from './podFactory';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

export async function createSessionWorkspaceService(
  namespace: string,
  serviceName: string,
  buildUuid?: string
): Promise<k8s.V1Service> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  const service: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace,
      labels: {
        ...buildLifecycleLabels({ buildUuid }),
        'app.kubernetes.io/component': 'agent-session-editor',
      },
    },
    spec: {
      selector: {
        'app.kubernetes.io/name': serviceName,
      },
      ports: [
        {
          name: 'editor',
          port: SESSION_WORKSPACE_EDITOR_PORT,
          targetPort: SESSION_WORKSPACE_EDITOR_PORT,
        },
        {
          name: SESSION_WORKSPACE_GATEWAY_PORT_NAME,
          port: SESSION_WORKSPACE_GATEWAY_PORT,
          targetPort: SESSION_WORKSPACE_GATEWAY_PORT,
        },
      ],
    },
  };

  const { body: result } = await coreApi.createNamespacedService(namespace, service);
  logger.info(
    `Session: workspace service created serviceName=${serviceName} namespace=${namespace} port=${SESSION_WORKSPACE_EDITOR_PORT}`
  );
  return result;
}

export async function deleteSessionWorkspaceService(namespace: string, serviceName: string): Promise<void> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  try {
    await coreApi.deleteNamespacedService(serviceName, namespace);
    logger.info(`Session: workspace editor cleaned serviceName=${serviceName} namespace=${namespace}`);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      logger.info(
        `Session: workspace editor cleanup skipped reason=not_found serviceName=${serviceName} namespace=${namespace}`
      );
      return;
    }

    throw error;
  }
}
