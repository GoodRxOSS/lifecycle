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
  TARGET_SECRET_SYNC_TOKEN_ANNOTATION,
} from 'server/lib/kubernetes/externalSecret';
import { SecretProvidersConfig } from 'server/services/types/globalConfig';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { v4 as uuid } from 'uuid';

const DEFAULT_SECRET_SYNC_TIMEOUT = 60000;

export interface ProcessEnvSecretsOptions {
  env: Record<string, string>;
  serviceName: string;
  namespace: string;
  buildUuid?: string;
  syncToken?: string;
}

export interface ProcessSecretRefsOptions {
  secretRefs: SecretRefWithEnvKey[];
  serviceName: string;
  namespace: string;
  buildUuid?: string;
  syncToken?: string;
  strict?: boolean;
}

export interface ProcessEnvSecretsResult {
  secretRefs: SecretRefWithEnvKey[];
  expectedKeysPerSecret: Record<string, string[]>;
  syncTokensPerSecret: Record<string, string>;
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

  // ExternalSecret updates reuse Secret names, so wait for this apply's keys instead of any existing data.
  async waitForSecretSync(
    expectedKeysPerSecret: Record<string, string[]>,
    namespace: string,
    timeoutMs?: number,
    expectedSyncTokensPerSecret: Record<string, string> = {}
  ): Promise<void> {
    const timeout = timeoutMs ?? DEFAULT_SECRET_SYNC_TIMEOUT;
    const pollInterval = 1000;
    const startTime = Date.now();

    const k8sClient = this.getK8sClient();

    for (const [secretName, expectedKeys] of Object.entries(expectedKeysPerSecret)) {
      let synced = false;
      let missingKeys = expectedKeys;
      let syncedToken = false;

      while (!synced) {
        if (Date.now() - startTime > timeout) {
          const tokenMessage =
            expectedSyncTokensPerSecret[secretName] && !syncedToken ? ' sync token not observed' : '';
          throw new Error(
            `Secret sync timeout: ${secretName} missing keys=[${missingKeys.join(
              ', '
            )}]${tokenMessage} after ${timeout}ms`
          );
        }

        try {
          const response = await k8sClient.readNamespacedSecret(secretName, namespace);
          const data = response.body.data || {};
          const annotations = response.body.metadata?.annotations || {};
          const expectedSyncToken = expectedSyncTokensPerSecret[secretName];
          missingKeys = expectedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(data, key));
          syncedToken = !expectedSyncToken || annotations[TARGET_SECRET_SYNC_TOKEN_ANNOTATION] === expectedSyncToken;

          if (missingKeys.length === 0 && syncedToken) {
            getLogger().info(`Secret: synced name=${secretName} namespace=${namespace}`);
            synced = true;
          } else {
            getLogger().debug(
              `Secret: waiting for keys name=${secretName} missing=[${missingKeys.join(
                ', '
              )}] syncedToken=${syncedToken}`
            );
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

  async processSecretRefs(options: ProcessSecretRefsOptions): Promise<ProcessEnvSecretsResult> {
    const { secretRefs, serviceName, namespace, buildUuid } = options;
    const syncToken = options.syncToken ?? uuid();
    const strict = options.strict ?? false;
    const warnings: string[] = [];
    const validRefs: SecretRefWithEnvKey[] = [];
    const refsBySecretKey = new Map<string, SecretRefWithEnvKey>();

    for (const ref of secretRefs) {
      const existingRef = refsBySecretKey.get(ref.envKey);
      if (
        existingRef &&
        (existingRef.provider !== ref.provider || existingRef.path !== ref.path || existingRef.key !== ref.key)
      ) {
        const warning = `Secret reference ${ref.envKey} has conflicting remote refs`;
        if (strict) {
          throw new Error(warning);
        }
        warnings.push(warning);
        getLogger().warn(warning);
        continue;
      }

      if (existingRef) {
        continue;
      }

      const validation = validateSecretRef(ref, this.secretProviders);

      if (!validation.valid) {
        const warning = `Secret reference ${ref.envKey}={{${ref.provider}:${ref.path}:${ref.key || ''}}} skipped: ${
          validation.error
        }`;
        if (strict) {
          throw new Error(warning);
        }
        warnings.push(warning);
        getLogger().warn(warning);
        continue;
      }

      refsBySecretKey.set(ref.envKey, ref);
      validRefs.push(ref);
    }

    if (validRefs.length === 0) {
      return { secretRefs: [], expectedKeysPerSecret: {}, syncTokensPerSecret: {}, warnings };
    }

    const grouped = groupSecretRefsByProvider(validRefs);
    const expectedKeysPerSecret: Record<string, string[]> = {};
    const syncTokensPerSecret: Record<string, string> = {};

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
        forceSyncToken: syncToken,
      });

      try {
        await applyExternalSecret(manifest, namespace);
        expectedKeysPerSecret[secretName] = [...new Set(refs.map((ref) => ref.envKey))];
        syncTokensPerSecret[secretName] = syncToken;
      } catch (error) {
        const errorMsg = (error as any)?.message || (error as any)?.stderr || String(error);
        const warning = `Failed to apply ExternalSecret for ${serviceName}: ${errorMsg}`;
        if (strict) {
          throw new Error(warning);
        }
        warnings.push(warning);
      }
    }

    return { secretRefs: validRefs, expectedKeysPerSecret, syncTokensPerSecret, warnings };
  }

  async processEnvSecrets(options: ProcessEnvSecretsOptions): Promise<ProcessEnvSecretsResult> {
    return this.processSecretRefs({
      secretRefs: parseSecretRefsFromEnv(options.env),
      serviceName: options.serviceName,
      namespace: options.namespace,
      buildUuid: options.buildUuid,
      syncToken: options.syncToken,
    });
  }
}
