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

  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const nodeApi = kc.makeApiClient(k8s.NodeV1Api);
    await nodeApi.readRuntimeClass('gvisor');
    cachedResult = true;
    cacheTimestamp = now;
    return true;
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      cachedResult = false;
      cacheTimestamp = now;
      return false;
    }
    const logger = getLogger();
    logger.warn({ error }, 'Session: runtime check failed name=gvisor');
    cachedResult = false;
    cacheTimestamp = now;
    return false;
  }
}
