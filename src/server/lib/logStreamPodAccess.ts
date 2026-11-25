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
import { NotFoundError } from 'server/lib/appError';
import type { LogStreamTarget } from 'server/lib/logStreamTicket';

const INIT_CONTAINER_PREFIX = '[init] ';

export interface LogStreamPodReader {
  readNamespacedPod(name: string, namespace: string): Promise<{ body: k8s.V1Pod }>;
}

function defaultPodReader(): LogStreamPodReader {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

/** Confirms the pod lives in the pinned namespace and exposes the container before a ticket is minted. */
export async function assertLogStreamPodContainer(
  target: LogStreamTarget,
  coreV1: LogStreamPodReader = defaultPodReader()
): Promise<void> {
  let pod: k8s.V1Pod;
  try {
    ({ body: pod } = await coreV1.readNamespacedPod(target.podName, target.namespace));
  } catch (error) {
    if ((error as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      throw new NotFoundError('Pod not found in this environment.', 'log_stream_pod_not_found');
    }
    throw error;
  }

  const containerName = target.containerName.startsWith(INIT_CONTAINER_PREFIX)
    ? target.containerName.slice(INIT_CONTAINER_PREFIX.length)
    : target.containerName;
  const containers = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
  if (!containers.some((container) => container.name === containerName)) {
    throw new NotFoundError('Container not found on this pod.', 'log_stream_container_not_found');
  }
}
