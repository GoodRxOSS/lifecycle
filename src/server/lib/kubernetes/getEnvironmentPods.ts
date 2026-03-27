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
  PodInfo,
  loadKubeConfig,
  podStatus,
  podRestarts,
  podReady,
  podAgeSeconds,
  formatAge,
  extractContainers,
} from 'server/lib/kubernetes/getDeploymentPods';

export interface EnvironmentPodInfo extends PodInfo {
  serviceName: string;
}

export async function getEnvironmentPods(uuid: string): Promise<EnvironmentPodInfo[]> {
  const kc = loadKubeConfig();
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const namespace = `env-${uuid}`;

    const podResp = await coreV1.listNamespacedPod(namespace);
    const pods = podResp.body.items ?? [];

    if (pods.length === 0) {
      return [];
    }

    return pods
      .filter((pod) => {
        const appName = pod.metadata?.labels?.['app.kubernetes.io/name'];
        return appName !== 'native-build' && appName !== 'native-helm';
      })
      .map((pod) => {
        const ageSeconds = podAgeSeconds(pod);
        const containers = extractContainers(pod);
        const serviceName =
          pod.metadata?.labels?.['tags.datadoghq.com/service'] ??
          pod.metadata?.labels?.['app.kubernetes.io/name'] ??
          '';

        return {
          podName: pod.metadata?.name ?? '',
          serviceName,
          status: podStatus(pod),
          restarts: podRestarts(pod),
          ageSeconds,
          age: formatAge(ageSeconds),
          ready: podReady(pod),
          containers,
        };
      });
  } catch (error) {
    getLogger().error({ error }, `K8s: failed to list environment pods uuid=${uuid}`);
    throw error;
  }
}
