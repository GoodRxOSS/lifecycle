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

import { SecretProvidersConfig } from 'server/services/types/globalConfig';

export interface SecretRef {
  provider: string;
  path: string;
  key?: string;
}

export interface SecretRefWithEnvKey extends SecretRef {
  envKey: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const SECRET_REF_REGEX = /^\{\{(aws|gcp):([^:}]+)(?::([^}]+))?\}\}$/;

export function isSecretRef(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }
  return SECRET_REF_REGEX.test(value);
}

export function parseSecretRef(value: string): SecretRef | null {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const match = value.match(SECRET_REF_REGEX);
  if (!match) {
    return null;
  }

  const [, provider, path, key] = match;

  if (key === '') {
    return null;
  }

  return {
    provider,
    path,
    key: key || undefined,
  };
}

export function validateSecretRef(
  ref: SecretRef,
  secretProviders: SecretProvidersConfig | undefined
): ValidationResult {
  if (!secretProviders) {
    return { valid: false, error: `Secret provider '${ref.provider}' not configured` };
  }

  const providerConfig = secretProviders[ref.provider];

  if (!providerConfig) {
    return { valid: false, error: `Secret provider '${ref.provider}' not configured` };
  }

  if (!providerConfig.enabled) {
    return { valid: false, error: `Secret provider '${ref.provider}' is disabled` };
  }

  if (providerConfig.allowedPrefixes && providerConfig.allowedPrefixes.length > 0) {
    const isAllowed = providerConfig.allowedPrefixes.some((prefix) => ref.path.startsWith(prefix));
    if (!isAllowed) {
      return {
        valid: false,
        error: `Secret path '${ref.path}' not in allowed prefixes: ${providerConfig.allowedPrefixes.join(', ')}`,
      };
    }
  }

  return { valid: true };
}

export function parseSecretRefsFromEnv(env: Record<string, string> | null | undefined): SecretRefWithEnvKey[] {
  if (!env) {
    return [];
  }

  const refs: SecretRefWithEnvKey[] = [];

  for (const [envKey, value] of Object.entries(env)) {
    const ref = parseSecretRef(value);
    if (ref) {
      refs.push({ envKey, ...ref });
    }
  }

  return refs;
}
