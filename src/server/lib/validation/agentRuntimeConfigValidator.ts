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

import type { AgentRuntimeConfig, AgentRuntimeRepoOverride } from 'server/services/types/agentRuntimeConfig';
import { isAgentCapabilityAvailability, isAgentCapabilityCatalogId } from 'server/services/agent/capabilityCatalog';
import {
  getProviderEnvVarCandidates,
  isValidEnvVarName,
  normalizeAgentProviderName,
  type SupportedAgentProviderName,
} from 'server/services/agent/providerConfig';
import { validateFileExclusionPatterns } from './filePatternValidator';

const CORE_TOOLS = ['query_database'];
const CUSTOM_AGENT_CREATION_MODES = ['enabled', 'disabled', 'admins_only', 'allowlist'] as const;
const CREATOR_CAPABILITY_AVAILABILITIES = ['available', 'reserved'] as const;

type ModelConfig = NonNullable<AgentRuntimeConfig['providers']>[number]['models'][number];

export class AgentRuntimeConfigValidationError extends Error {}

function validateSharedConfigFields(
  config: Pick<
    AgentRuntimeConfig,
    'systemPromptOverride' | 'excludedTools' | 'excludedFilePatterns' | 'capabilityPolicy' | 'customAgentCreationPolicy'
  >
): void {
  if (config.systemPromptOverride !== undefined && config.systemPromptOverride.length > 50000) {
    throw new AgentRuntimeConfigValidationError('systemPromptOverride exceeds maximum length of 50000 characters');
  }

  if (config.excludedTools && config.excludedTools.length > 0) {
    for (const tool of config.excludedTools) {
      if (CORE_TOOLS.includes(tool)) {
        throw new AgentRuntimeConfigValidationError(
          `Cannot exclude core tool: "${tool}". Core tools are required for agent operation.`
        );
      }
    }
  }

  if (config.excludedFilePatterns && config.excludedFilePatterns.length > 0) {
    validateFileExclusionPatterns(config.excludedFilePatterns);
  }

  if (config.capabilityPolicy?.availability) {
    for (const [capabilityId, availability] of Object.entries(config.capabilityPolicy.availability)) {
      if (!isAgentCapabilityCatalogId(capabilityId)) {
        throw new AgentRuntimeConfigValidationError(`Unknown capability id "${capabilityId}".`);
      }

      if (!isAgentCapabilityAvailability(availability)) {
        throw new AgentRuntimeConfigValidationError(
          `Capability "${capabilityId}" has invalid availability "${availability}".`
        );
      }
    }
  }

  const creationPolicy = config.customAgentCreationPolicy;
  if (creationPolicy) {
    if (
      creationPolicy.mode !== undefined &&
      !CUSTOM_AGENT_CREATION_MODES.includes(creationPolicy.mode as (typeof CUSTOM_AGENT_CREATION_MODES)[number])
    ) {
      throw new AgentRuntimeConfigValidationError(`Invalid custom agent creation mode "${creationPolicy.mode}".`);
    }

    for (const field of ['allowedUserIds', 'allowedGithubUsernames'] as const) {
      const values = creationPolicy[field];
      if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))) {
        throw new AgentRuntimeConfigValidationError(`customAgentCreationPolicy.${field} must be an array of strings.`);
      }
    }

    if (
      creationPolicy.capabilityAvailability !== undefined &&
      (!creationPolicy.capabilityAvailability ||
        typeof creationPolicy.capabilityAvailability !== 'object' ||
        Array.isArray(creationPolicy.capabilityAvailability))
    ) {
      throw new AgentRuntimeConfigValidationError(
        'customAgentCreationPolicy.capabilityAvailability must be an object.'
      );
    }

    if (creationPolicy.capabilityAvailability) {
      for (const [capabilityId, availability] of Object.entries(creationPolicy.capabilityAvailability)) {
        if (!isAgentCapabilityCatalogId(capabilityId)) {
          throw new AgentRuntimeConfigValidationError(`Unknown creator capability id "${capabilityId}".`);
        }

        if (
          !CREATOR_CAPABILITY_AVAILABILITIES.includes(
            availability as (typeof CREATOR_CAPABILITY_AVAILABILITIES)[number]
          )
        ) {
          throw new AgentRuntimeConfigValidationError(
            `Creator capability "${capabilityId}" has invalid availability "${availability}".`
          );
        }
      }
    }
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
      throw new AgentRuntimeConfigValidationError(`Provider "${providerName}" has duplicate model id "${model.id}".`);
    }

    seenModelIds.add(model.id);

    if (model.enabled) {
      enabledModelCount += 1;
    }

    if (!model.default) {
      continue;
    }

    if (!model.enabled) {
      throw new AgentRuntimeConfigValidationError(
        `Provider "${providerName}" default model "${model.id}" must also be enabled.`
      );
    }

    defaultModelCount += 1;
  }

  if (providerEnabled && enabledModelCount === 0) {
    throw new AgentRuntimeConfigValidationError(`Provider "${providerName}" must have at least one enabled model.`);
  }

  if (defaultModelCount > 1) {
    throw new AgentRuntimeConfigValidationError(`Provider "${providerName}" can have only one default model.`);
  }
}

export function validateAgentRuntimeConfig(config: AgentRuntimeConfig): void {
  validateSharedConfigFields(config);

  const seenProviders = new Set<SupportedAgentProviderName>();

  for (const provider of config.providers || []) {
    const providerName = normalizeAgentProviderName(provider.name);
    if (!providerName) {
      throw new AgentRuntimeConfigValidationError(`Unsupported provider "${provider.name}".`);
    }

    if (seenProviders.has(providerName)) {
      throw new AgentRuntimeConfigValidationError(`Duplicate provider "${providerName}" is not allowed.`);
    }

    seenProviders.add(providerName);

    if (!isValidEnvVarName(provider.apiKeyEnvVar)) {
      const exampleEnvVar = getProviderEnvVarCandidates(providerName)[0] || 'API_KEY_ENV_VAR';
      throw new AgentRuntimeConfigValidationError(
        `Provider "${providerName}" apiKeyEnvVar must be an environment variable name like ${exampleEnvVar}.`
      );
    }

    validateProviderModels(providerName, provider.models || [], provider.enabled !== false);
  }
}

export function validateAgentRuntimeRepoOverride(config: Partial<AgentRuntimeRepoOverride>): void {
  validateSharedConfigFields(config);
}
