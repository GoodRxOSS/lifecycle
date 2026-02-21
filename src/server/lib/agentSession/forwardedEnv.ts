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
import Deploy from 'server/models/Deploy';
import type { DevConfig } from 'server/models/yaml/YamlService';
import { deleteExternalSecret, generateSecretName } from 'server/lib/kubernetes/externalSecret';
import { getLogger } from 'server/lib/logger';
import { parseSecretRefsFromEnv, SecretRefWithEnvKey } from 'server/lib/secretRefs';
import { SecretProcessor } from 'server/services/secretProcessor';
import GlobalConfigService from 'server/services/globalConfig';

const logger = getLogger();

export interface ForwardedAgentEnvService {
  name: string;
  deployId: number;
  devConfig: DevConfig;
}

export interface ForwardedAgentEnvResolution {
  env: Record<string, string>;
  secretRefs: SecretRefWithEnvKey[];
  secretProviders: string[];
  secretServiceName: string;
}

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

function getEnvValueForForwarding(deployEnv: Record<string, unknown>, serviceName: string, envKey: string): string {
  if (!Object.prototype.hasOwnProperty.call(deployEnv, envKey)) {
    throw new Error(`Agent env forwarding key ${envKey} is not defined for service ${serviceName}.`);
  }

  const rawValue = deployEnv[envKey];
  if (rawValue == null || typeof rawValue === 'object') {
    throw new Error(`Agent env forwarding key ${envKey} for service ${serviceName} must resolve to a scalar value.`);
  }

  return String(rawValue);
}

export function getForwardedAgentEnvSecretServiceName(sessionUuid: string): string {
  return `agent-env-${sessionUuid}`;
}

export async function resolveForwardedAgentEnv(
  services: ForwardedAgentEnvService[] | undefined,
  namespace: string,
  sessionUuid: string,
  buildUuid?: string
): Promise<ForwardedAgentEnvResolution> {
  const forwardedEnv: Record<string, string> = {};
  const selectedServices = services || [];
  const servicesRequestingForwardedEnv = selectedServices.filter(
    (service) => (service.devConfig.forwardEnvVarsToAgent || []).length > 0
  );
  if (selectedServices.length === 0) {
    return {
      env: forwardedEnv,
      secretRefs: [],
      secretProviders: [],
      secretServiceName: getForwardedAgentEnvSecretServiceName(sessionUuid),
    };
  }
  if (servicesRequestingForwardedEnv.length === 0) {
    return {
      env: forwardedEnv,
      secretRefs: [],
      secretProviders: [],
      secretServiceName: getForwardedAgentEnvSecretServiceName(sessionUuid),
    };
  }

  const deployIds = [...new Set(servicesRequestingForwardedEnv.map((service) => service.deployId))];
  const deployRows = await Deploy.query().whereIn('id', deployIds).select('id', 'env');
  const deployById = new Map(deployRows.map((deploy) => [deploy.id, deploy]));

  for (const service of servicesRequestingForwardedEnv) {
    const envKeys = service.devConfig.forwardEnvVarsToAgent || [];
    if (envKeys.length === 0) {
      continue;
    }

    const deploy = deployById.get(service.deployId);
    if (!deploy) {
      throw new Error(`Selected deploy ${service.deployId} was not found for service ${service.name}.`);
    }

    const deployEnv = (deploy.env || {}) as Record<string, unknown>;
    for (const envKey of envKeys) {
      const nextValue = getEnvValueForForwarding(deployEnv, service.name, envKey);
      const existingValue = forwardedEnv[envKey];
      if (existingValue != null && existingValue !== nextValue) {
        throw new Error(
          `Agent env forwarding conflict for ${envKey}: selected services resolve it to different values.`
        );
      }

      forwardedEnv[envKey] = nextValue;
    }
  }

  const secretRefs = parseSecretRefsFromEnv(forwardedEnv);
  const secretServiceName = getForwardedAgentEnvSecretServiceName(sessionUuid);
  if (secretRefs.length === 0) {
    return {
      env: forwardedEnv,
      secretRefs: [],
      secretProviders: [],
      secretServiceName,
    };
  }

  const globalConfigs = await GlobalConfigService.getInstance().getAllConfigs();
  const secretProviders = globalConfigs.secretProviders;
  if (!secretProviders) {
    const secretKeys = secretRefs.map((ref) => ref.envKey).join(', ');
    throw new Error(
      `Agent env forwarding for ${secretKeys} requires configured secret providers because the selected service uses native secret references.`
    );
  }

  const secretProcessor = new SecretProcessor(secretProviders);
  const secretResult = await secretProcessor.processEnvSecrets({
    env: forwardedEnv,
    serviceName: secretServiceName,
    namespace,
    buildUuid,
  });

  if (secretResult.warnings.length > 0) {
    throw new Error(secretResult.warnings.join(' '));
  }

  if (secretResult.secretNames.length > 0) {
    const providerTimeouts = Object.values(secretProviders)
      .map((provider) => provider.secretSyncTimeout)
      .filter((timeout): timeout is number => timeout !== undefined);
    const timeout = providerTimeouts.length > 0 ? Math.max(...providerTimeouts) * 1000 : 60000;
    await secretProcessor.waitForSecretSync(secretResult.secretNames, namespace, timeout);
  }

  return {
    env: forwardedEnv,
    secretRefs: secretResult.secretRefs,
    secretProviders: [...new Set(secretResult.secretRefs.map((ref) => ref.provider))],
    secretServiceName,
  };
}

export async function cleanupForwardedAgentEnvSecrets(
  namespace: string,
  sessionUuid: string,
  providers: string[] | undefined
): Promise<void> {
  const uniqueProviders = [...new Set((providers || []).filter(Boolean))];
  if (uniqueProviders.length === 0) {
    return;
  }

  const secretServiceName = getForwardedAgentEnvSecretServiceName(sessionUuid);
  const coreApi = getCoreApi();

  for (const provider of uniqueProviders) {
    const secretName = generateSecretName(secretServiceName, provider);

    await deleteExternalSecret(secretName, namespace);

    try {
      await coreApi.deleteNamespacedSecret(secretName, namespace);
    } catch (error: any) {
      if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
        continue;
      }

      logger.warn({ error, namespace, secretName }, 'Agent forwarded env secret cleanup failed');
    }
  }
}
