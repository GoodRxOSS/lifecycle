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

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedResult: boolean | null = null;
let cacheTimestamp = 0;

export function resetGvisorCache(): void {
  cachedResult = null;
  cacheTimestamp = 0;
}

export async function isGvisorAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cachedResult !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResult;
  }

  const setCache = (value: boolean): boolean => {
    cachedResult = value;
    cacheTimestamp = now;
    return value;
  };

  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const nodeApi = kc.makeApiClient(k8s.NodeV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const runtimeClass = await nodeApi.readRuntimeClass('gvisor');

    // The RuntimeClass existing is not enough: GKE registers the gvisor RuntimeClass on every cluster
    // regardless of node pools, so without a node matching its scheduling selector the workspace pod
    // pins to runtimeClassName=gvisor and hangs Pending until timeout. Require a Ready node it can target.
    const nodeSelector = runtimeClass.body.scheduling?.nodeSelector ?? {};
    const labelSelector = Object.entries(nodeSelector)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    const nodes = await coreApi.listNode(undefined, undefined, undefined, undefined, labelSelector || undefined);
    const hasReadyNode = (nodes.body.items ?? []).some((node) =>
      (node.status?.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True')
    );

    return setCache(hasReadyNode);
  } catch (error: any) {
    // 404 = RuntimeClass absent (expected on non-gVisor clusters); anything else is unexpected.
    const statusCode = error?.response?.statusCode ?? error?.statusCode ?? error?.code;
    if (statusCode !== 404) {
      getLogger().warn({ error }, 'Session: runtime check failed name=gvisor');
    }
    return setCache(false);
  }
}
