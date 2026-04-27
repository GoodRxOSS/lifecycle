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

export const SUPPORTED_AGENT_PROVIDER_NAMES = ['anthropic', 'openai', 'gemini', 'google'] as const;

export type SupportedAgentProviderName = (typeof SUPPORTED_AGENT_PROVIDER_NAMES)[number];
export const STORED_AGENT_PROVIDER_NAMES = ['anthropic', 'openai', 'gemini'] as const;
export type StoredAgentProviderName = (typeof STORED_AGENT_PROVIDER_NAMES)[number];

export const DEFAULT_PROVIDER_ENV_VARS: Record<SupportedAgentProviderName, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  gemini: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
};

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function normalizeAgentProviderName(value: unknown): SupportedAgentProviderName | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return (SUPPORTED_AGENT_PROVIDER_NAMES as readonly string[]).includes(normalized)
    ? (normalized as SupportedAgentProviderName)
    : null;
}

export function normalizeStoredAgentProviderName(value: unknown): StoredAgentProviderName | null {
  const normalized = normalizeAgentProviderName(value);
  if (!normalized) {
    return null;
  }

  if (normalized === 'google') {
    return 'gemini';
  }

  return (STORED_AGENT_PROVIDER_NAMES as readonly string[]).includes(normalized)
    ? (normalized as StoredAgentProviderName)
    : null;
}

export function isValidEnvVarName(value: unknown): value is string {
  return typeof value === 'string' && ENV_VAR_NAME_PATTERN.test(value);
}

export function getProviderEnvVarCandidates(providerName: string, explicitEnvVar?: string): string[] {
  if (isValidEnvVarName(explicitEnvVar)) {
    return [explicitEnvVar];
  }

  const normalizedProvider = normalizeAgentProviderName(providerName);
  return normalizedProvider ? DEFAULT_PROVIDER_ENV_VARS[normalizedProvider] : [];
}
