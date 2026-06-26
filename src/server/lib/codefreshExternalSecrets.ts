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

import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { createOrUpdateNamespace } from 'server/lib/kubernetes';
import { deleteExternalSecret } from 'server/lib/kubernetes/externalSecret';
import { generateSecretName } from 'server/lib/kubernetes/secretNames';
import { getLogger } from 'server/lib/logger';
import { parseSecretRef, SecretRefWithEnvKey } from 'server/lib/secretRefs';
import { SecretProcessor } from 'server/services/secretProcessor';
import { SecretProvidersConfig } from 'server/services/types/globalConfig';

type CodefreshEnvValue = string | number | boolean | null | Record<string, any> | any[];
type CodefreshEnv = Record<string, CodefreshEnvValue>;

interface SecretRefLocation {
  topLevelKey: string;
  path: Array<string | number>;
  ref: SecretRefWithEnvKey;
}

export interface ResolveCodefreshExternalSecretsOptions {
  env: CodefreshEnv;
  serviceName?: string;
  namespace?: string;
  buildUuid?: string;
  staticEnv?: boolean;
  secretProviders: SecretProvidersConfig | undefined;
}

export interface ResolveCodefreshExternalSecretsResult {
  env: CodefreshEnv;
  secretEnvKeys: Set<string>;
}

export interface CleanupCodefreshExternalSecretsOptions {
  env: CodefreshEnv;
  serviceName?: string;
  namespace?: string;
}

function getK8sClient(): CoreV1Api {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CoreV1Api);
}

function secretEnvKeyFor(topLevelKey: string, path: Array<string | number>): string {
  if (path.length === 0) {
    return topLevelKey;
  }

  const suffix = path.map((part) => String(part).replace(/[^A-Za-z0-9_.-]/g, '_')).join('__');
  return `${topLevelKey}__${suffix}`;
}

function collectSecretRefLocations(
  value: CodefreshEnvValue,
  topLevelKey: string,
  path: Array<string | number> = []
): SecretRefLocation[] {
  if (typeof value === 'string') {
    const ref = parseSecretRef(value);
    return ref ? [{ topLevelKey, path, ref: { ...ref, envKey: secretEnvKeyFor(topLevelKey, path) } }] : [];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectSecretRefLocations(item, topLevelKey, [...path, index]));
  }

  return Object.entries(value).flatMap(([key, nestedValue]) =>
    collectSecretRefLocations(nestedValue, topLevelKey, [...path, key])
  );
}

export function hasCodefreshExternalSecretRefs(env: CodefreshEnv): boolean {
  return Object.entries(env).some(([topLevelKey, value]) => collectSecretRefLocations(value, topLevelKey).length > 0);
}

function cloneAndSet(value: CodefreshEnvValue, path: Array<string | number>, secretValue: string): CodefreshEnvValue {
  if (path.length === 0) {
    return secretValue;
  }

  if (Array.isArray(value)) {
    const clone = [...value];
    const [head, ...tail] = path;
    clone[head as number] = cloneAndSet(clone[head as number], tail, secretValue);
    return clone;
  }

  const clone = { ...(value as Record<string, any>) };
  const [head, ...tail] = path;
  clone[head as string] = cloneAndSet(clone[head as string], tail, secretValue);
  return clone;
}

function decodeSecretValue(encodedValue: string | undefined, envKey: string): string {
  if (encodedValue === undefined) {
    throw new Error(`Codefresh secret resolution failed: synced Kubernetes secret is missing key '${envKey}'.`);
  }

  return Buffer.from(encodedValue, 'base64').toString('utf8');
}

export async function resolveCodefreshExternalSecrets(
  options: ResolveCodefreshExternalSecretsOptions
): Promise<ResolveCodefreshExternalSecretsResult> {
  const locations = Object.entries(options.env).flatMap(([topLevelKey, value]) =>
    collectSecretRefLocations(value, topLevelKey)
  );

  if (locations.length === 0) {
    return { env: options.env, secretEnvKeys: new Set<string>() };
  }

  if (!options.secretProviders) {
    const keys = [...new Set(locations.map((location) => location.topLevelKey))].join(', ');
    throw new Error(
      `Codefresh secret resolution failed for env keys [${keys}]: external secret providers are not configured.`
    );
  }

  if (!options.serviceName || !options.namespace) {
    const keys = [...new Set(locations.map((location) => location.topLevelKey))].join(', ');
    throw new Error(
      `Codefresh secret resolution failed for env keys [${keys}]: service name and namespace are required.`
    );
  }

  if (!options.buildUuid) {
    const keys = [...new Set(locations.map((location) => location.topLevelKey))].join(', ');
    throw new Error(`Codefresh secret resolution failed for env keys [${keys}]: build UUID is required.`);
  }

  await createOrUpdateNamespace({
    name: options.namespace,
    buildUUID: options.buildUuid,
    staticEnv: options.staticEnv ?? false,
    waitForReady: true,
  });

  const secretProcessor = new SecretProcessor(options.secretProviders);
  const secretResult = await secretProcessor.processSecretRefs({
    secretRefs: locations.map((location) => location.ref),
    serviceName: options.serviceName,
    namespace: options.namespace,
    buildUuid: options.buildUuid,
    strict: true,
  });

  if (secretResult.warnings.length > 0) {
    throw new Error(`Codefresh secret resolution failed: ${secretResult.warnings.join(' ')}`);
  }

  const providerTimeouts = Object.values(options.secretProviders)
    .map((provider) => provider.secretSyncTimeout)
    .filter((timeout): timeout is number => timeout !== undefined);
  const timeout = providerTimeouts.length > 0 ? Math.max(...providerTimeouts) * 1000 : 60000;

  await secretProcessor.waitForSecretSync(
    secretResult.expectedKeysPerSecret,
    options.namespace,
    timeout,
    secretResult.syncTokensPerSecret
  );

  const k8sClient = getK8sClient();
  const secretDataByEnvKey = new Map<string, string>();

  for (const provider of [...new Set(locations.map((location) => location.ref.provider))]) {
    const secretName = generateSecretName(options.serviceName, provider);
    const response = await k8sClient.readNamespacedSecret(secretName, options.namespace);
    const data = response.body.data || {};

    for (const location of locations.filter((item) => item.ref.provider === provider)) {
      secretDataByEnvKey.set(location.ref.envKey, decodeSecretValue(data[location.ref.envKey], location.ref.envKey));
    }
  }

  let resolvedEnv: CodefreshEnv = { ...options.env };
  const secretEnvKeys = new Set<string>();

  for (const location of locations) {
    const secretValue = secretDataByEnvKey.get(location.ref.envKey);
    resolvedEnv = {
      ...resolvedEnv,
      [location.topLevelKey]: cloneAndSet(resolvedEnv[location.topLevelKey], location.path, secretValue ?? ''),
    };
    secretEnvKeys.add(location.topLevelKey);
  }

  return { env: resolvedEnv, secretEnvKeys };
}

export async function cleanupCodefreshExternalSecrets(options: CleanupCodefreshExternalSecretsOptions): Promise<void> {
  const locations = Object.entries(options.env).flatMap(([topLevelKey, value]) =>
    collectSecretRefLocations(value, topLevelKey)
  );

  if (locations.length === 0 || !options.serviceName || !options.namespace) {
    return;
  }

  const k8sClient = getK8sClient();

  for (const provider of [...new Set(locations.map((location) => location.ref.provider))]) {
    const secretName = generateSecretName(options.serviceName, provider);
    await deleteExternalSecret(secretName, options.namespace);

    try {
      await k8sClient.deleteNamespacedSecret(secretName, options.namespace);
    } catch (error) {
      getLogger({ error }).warn(`Codefresh secret cleanup failed name=${secretName}`);
    }
  }
}
