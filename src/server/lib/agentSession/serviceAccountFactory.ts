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

import { setupReadOnlyServiceAccountInNamespace } from 'server/lib/kubernetes/rbac';

export const AGENT_SESSION_SERVICE_ACCOUNT_NAME = 'agent-sa';
const serviceAccountSetupByNamespace = new Map<string, Promise<string>>();

export async function ensureAgentSessionServiceAccount(namespace: string): Promise<string> {
  let setupPromise = serviceAccountSetupByNamespace.get(namespace);
  if (!setupPromise) {
    setupPromise = (async () => {
      await setupReadOnlyServiceAccountInNamespace(namespace, AGENT_SESSION_SERVICE_ACCOUNT_NAME);
      return AGENT_SESSION_SERVICE_ACCOUNT_NAME;
    })();
    serviceAccountSetupByNamespace.set(namespace, setupPromise);
  }

  try {
    return await setupPromise;
  } catch (error) {
    if (serviceAccountSetupByNamespace.get(namespace) === setupPromise) {
      serviceAccountSetupByNamespace.delete(namespace);
    }

    throw error;
  }
}
