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
import {
  DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE,
  DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE,
} from './runtimeConfig';
import type { AgentSessionWorkspaceStorageAccessMode } from 'server/services/types/globalConfig';

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

export async function createAgentPvc(
  namespace: string,
  pvcName: string,
  storageSize = DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE,
  buildUuid?: string,
  accessMode: AgentSessionWorkspaceStorageAccessMode = DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE
): Promise<k8s.V1PersistentVolumeClaim> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  const pvc: k8s.V1PersistentVolumeClaim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcName,
      namespace,
      labels: {
        ...buildLifecycleLabels({ buildUuid }),
        'app.kubernetes.io/component': 'agent-session',
      },
    },
    spec: {
      accessModes: [accessMode],
      resources: {
        requests: {
          storage: storageSize,
        },
      },
    },
  };

  try {
    const { body: result } = await coreApi.createNamespacedPersistentVolumeClaim(namespace, pvc);
    logger.info(
      `AgentRuntime: workspace prepared pvcName=${pvcName} namespace=${namespace} size=${storageSize} accessMode=${accessMode}`
    );
    return result;
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 409) {
      const { body: existing } = await coreApi.readNamespacedPersistentVolumeClaim(pvcName, namespace);
      logger.info(`AgentRuntime: workspace prepared reason=exists pvcName=${pvcName} namespace=${namespace}`);
      return existing;
    }

    throw error;
  }
}

export async function deleteAgentPvc(namespace: string, pvcName: string): Promise<void> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  try {
    await coreApi.deleteNamespacedPersistentVolumeClaim(pvcName, namespace);
    logger.info(`AgentRuntime: workspace cleaned pvcName=${pvcName} namespace=${namespace}`);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      logger.info(`AgentRuntime: workspace cleanup skipped reason=not_found pvcName=${pvcName} namespace=${namespace}`);
      return;
    }
    throw error;
  }
}
