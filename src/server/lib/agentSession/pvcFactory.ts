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

function getAccessMode(): 'ReadWriteMany' | 'ReadWriteOnce' {
  const configured = process.env.AGENT_SESSION_PVC_ACCESS_MODE;
  if (configured === 'ReadWriteMany' || configured === 'ReadWriteOnce') {
    return configured;
  }

  return 'ReadWriteOnce';
}

export async function createAgentPvc(
  namespace: string,
  pvcName: string,
  storageSize = '10Gi',
  buildUuid?: string
): Promise<k8s.V1PersistentVolumeClaim> {
  const logger = getLogger();
  const coreApi = getCoreApi();
  const accessMode = getAccessMode();

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

  const { body: result } = await coreApi.createNamespacedPersistentVolumeClaim(namespace, pvc);
  logger.info(
    `pvcFactory: created PVC name=${pvcName} namespace=${namespace} size=${storageSize} accessMode=${accessMode}`
  );
  return result;
}

export async function deleteAgentPvc(namespace: string, pvcName: string): Promise<void> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  try {
    await coreApi.deleteNamespacedPersistentVolumeClaim(pvcName, namespace);
    logger.info(`pvcFactory: deleted PVC name=${pvcName} namespace=${namespace}`);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      logger.info(`pvcFactory: PVC not found (already deleted) name=${pvcName} namespace=${namespace}`);
      return;
    }
    throw error;
  }
}
