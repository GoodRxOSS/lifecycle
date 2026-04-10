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

import type { AIAgentConfig, AIAgentRepoOverride } from 'server/services/types/aiAgentConfig';
import {
  getProviderEnvVarCandidates,
  isValidEnvVarName,
  normalizeAgentProviderName,
  type SupportedAgentProviderName,
} from 'server/services/agent/providerConfig';
import { validateFileExclusionPatterns } from './filePatternValidator';

const CORE_TOOLS = ['query_database'];

type ModelConfig = NonNullable<AIAgentConfig['providers']>[number]['models'][number];

export class AIAgentConfigValidationError extends Error {}

function validateSharedConfigFields(
  config: Pick<AIAgentConfig, 'systemPromptOverride' | 'excludedTools' | 'excludedFilePatterns'>
): void {
  if (config.systemPromptOverride !== undefined && config.systemPromptOverride.length > 50000) {
    throw new AIAgentConfigValidationError('systemPromptOverride exceeds maximum length of 50000 characters');
  }

  if (config.excludedTools && config.excludedTools.length > 0) {
    for (const tool of config.excludedTools) {
      if (CORE_TOOLS.includes(tool)) {
        throw new AIAgentConfigValidationError(
          `Cannot exclude core tool: "${tool}". Core tools are required for agent operation.`
        );
      }
    }
  }

  if (config.excludedFilePatterns && config.excludedFilePatterns.length > 0) {
    validateFileExclusionPatterns(config.excludedFilePatterns);
  }
}

function validateProviderModels(
  providerName: SupportedAgentProviderName,
  models: ModelConfig[],
  providerEnabled: boolean
): void {
  const seenModelIds = new Set<string>();
  let defaultModelCount = 0;
  let enabledModelCount = 0;

  for (const model of models) {
    if (seenModelIds.has(model.id)) {
      throw new AIAgentConfigValidationError(`Provider "${providerName}" has duplicate model id "${model.id}".`);
    }

    seenModelIds.add(model.id);

    if (model.enabled) {
      enabledModelCount += 1;
    }

    if (!model.default) {
      continue;
    }

    if (!model.enabled) {
      throw new AIAgentConfigValidationError(
        `Provider "${providerName}" default model "${model.id}" must also be enabled.`
      );
    }

    defaultModelCount += 1;
  }

  if (providerEnabled && enabledModelCount === 0) {
    throw new AIAgentConfigValidationError(`Provider "${providerName}" must have at least one enabled model.`);
  }

  if (defaultModelCount > 1) {
    throw new AIAgentConfigValidationError(`Provider "${providerName}" can have only one default model.`);
  }
}

export function validateAIAgentConfig(config: AIAgentConfig): void {
  validateSharedConfigFields(config);

  const seenProviders = new Set<SupportedAgentProviderName>();

  for (const provider of config.providers || []) {
    const providerName = normalizeAgentProviderName(provider.name);
    if (!providerName) {
      throw new AIAgentConfigValidationError(`Unsupported provider "${provider.name}".`);
    }

    if (seenProviders.has(providerName)) {
      throw new AIAgentConfigValidationError(`Duplicate provider "${providerName}" is not allowed.`);
    }

    seenProviders.add(providerName);

    if (!isValidEnvVarName(provider.apiKeyEnvVar)) {
      const exampleEnvVar = getProviderEnvVarCandidates(providerName)[0] || 'API_KEY_ENV_VAR';
      throw new AIAgentConfigValidationError(
        `Provider "${providerName}" apiKeyEnvVar must be an environment variable name like ${exampleEnvVar}.`
      );
    }

    validateProviderModels(providerName, provider.models || [], provider.enabled !== false);
  }
}

export function validateAIAgentRepoOverride(config: Partial<AIAgentRepoOverride>): void {
  validateSharedConfigFields(config);
}
