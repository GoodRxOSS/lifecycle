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

import { getLogger } from 'server/lib/logger';
import { parseSecretRefsFromEnv, validateSecretRef, SecretRefWithEnvKey } from 'server/lib/secretRefs';
import {
  applyExternalSecret,
  generateExternalSecretManifest,
  groupSecretRefsByProvider,
  generateSecretName,
} from 'server/lib/kubernetes/externalSecret';
import { SecretProvidersConfig } from 'server/services/types/globalConfig';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

const DEFAULT_SECRET_SYNC_TIMEOUT = 60000;

export interface ProcessEnvSecretsOptions {
  env: Record<string, string>;
  serviceName: string;
  namespace: string;
  buildUuid?: string;
}

export interface ProcessEnvSecretsResult {
  secretRefs: SecretRefWithEnvKey[];
  secretNames: string[];
  warnings: string[];
}

export class SecretProcessor {
  private secretProviders: SecretProvidersConfig | undefined;
  private k8sClient: CoreV1Api | null = null;

  constructor(secretProviders: SecretProvidersConfig | undefined) {
    this.secretProviders = secretProviders;
  }

  private getK8sClient(): CoreV1Api {
    if (!this.k8sClient) {
      const kc = new KubeConfig();
      kc.loadFromDefault();
      this.k8sClient = kc.makeApiClient(CoreV1Api);
    }
    return this.k8sClient;
  }

  async waitForSecretSync(secretNames: string[], namespace: string, timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? DEFAULT_SECRET_SYNC_TIMEOUT;
    const pollInterval = 1000;
    const startTime = Date.now();

    const k8sClient = this.getK8sClient();

    for (const secretName of secretNames) {
      let synced = false;

      while (!synced) {
        if (Date.now() - startTime > timeout) {
          throw new Error(`Secret sync timeout: ${secretName} not ready after ${timeout}ms`);
        }

        try {
          const response = await k8sClient.readNamespacedSecret(secretName, namespace);
          if (response.body.data && Object.keys(response.body.data).length > 0) {
            getLogger().info(`Secret: synced name=${secretName} namespace=${namespace}`);
            synced = true;
          } else {
            getLogger().debug(`Secret: waiting for data name=${secretName}`);
            await this.sleep(pollInterval);
          }
        } catch (error: any) {
          if (error.statusCode === 404) {
            getLogger().debug(`Secret: not found yet name=${secretName}`);
            await this.sleep(pollInterval);
          } else {
            throw error;
          }
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async processEnvSecrets(options: ProcessEnvSecretsOptions): Promise<ProcessEnvSecretsResult> {
    const { env, serviceName, namespace, buildUuid } = options;
    const warnings: string[] = [];
    const validRefs: SecretRefWithEnvKey[] = [];

    const allRefs = parseSecretRefsFromEnv(env);

    for (const ref of allRefs) {
      const validation = validateSecretRef(ref, this.secretProviders);

      if (!validation.valid) {
        const warning = `Secret reference ${ref.envKey}={{${ref.provider}:${ref.path}:${ref.key || ''}}} skipped: ${
          validation.error
        }`;
        warnings.push(warning);
        getLogger().warn(warning);
        continue;
      }

      validRefs.push(ref);
    }

    if (validRefs.length === 0) {
      return { secretRefs: [], secretNames: [], warnings };
    }

    const grouped = groupSecretRefsByProvider(validRefs);
    const secretNames: string[] = [];

    for (const [provider, refs] of Object.entries(grouped)) {
      const providerConfig = this.secretProviders![provider];
      const secretName = generateSecretName(serviceName, provider);

      const manifest = generateExternalSecretManifest({
        name: serviceName,
        namespace,
        provider,
        secretRefs: refs,
        providerConfig,
        buildUuid,
      });

      try {
        await applyExternalSecret(manifest, namespace);
        secretNames.push(secretName);
      } catch (error) {
        const errorMsg = (error as any)?.message || (error as any)?.stderr || String(error);
        const warning = `Failed to apply ExternalSecret for ${serviceName}: ${errorMsg}`;
        warnings.push(warning);
      }
    }

    return { secretRefs: validRefs, secretNames, warnings };
  }
}
