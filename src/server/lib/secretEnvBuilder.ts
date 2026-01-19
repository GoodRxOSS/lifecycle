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

import { SecretRefWithEnvKey } from './secretRefs';
import { generateSecretName } from './kubernetes/externalSecret';

export interface PodEnvEntry {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: {
      name: string;
      key: string;
    };
    fieldRef?: {
      fieldPath: string;
    };
  };
}

export function buildPodEnvWithSecrets(
  env: Record<string, string> | null | undefined,
  secretRefs: SecretRefWithEnvKey[],
  serviceName: string
): PodEnvEntry[] {
  if (!env) {
    return [];
  }

  const secretRefMap = new Map<string, SecretRefWithEnvKey>();
  for (const ref of secretRefs) {
    secretRefMap.set(ref.envKey, ref);
  }

  const entries: PodEnvEntry[] = [];

  for (const [name, value] of Object.entries(env)) {
    const secretRef = secretRefMap.get(name);

    if (secretRef) {
      const secretName = generateSecretName(serviceName, secretRef.provider);
      entries.push({
        name,
        valueFrom: {
          secretKeyRef: {
            name: secretName,
            key: name,
          },
        },
      });
    } else {
      entries.push({
        name,
        value,
      });
    }
  }

  return entries;
}
