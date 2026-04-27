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

import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import AIAgentConfigService from 'server/services/aiAgentConfig';
import UserApiKeyService from 'server/services/userApiKey';
import { transformProviderModels } from 'server/services/ai/utils/modelTransformation';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import type { AgentModelSummary, AgentResolvedModelSelection } from './types';
import { getProviderEnvVarCandidates, normalizeStoredAgentProviderName } from './providerConfig';

type ProviderConfig = {
  name: string;
  apiKeyEnvVar?: string;
  enabled?: boolean;
};

function normalizeModelProvider(provider: string): string | null {
  return normalizeStoredAgentProviderName(provider);
}

export class MissingAgentProviderApiKeyError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `No stored API key is configured for provider "${provider}". Save your ${provider} API key in Agent Session settings before starting a session or run.`
    );
    this.name = 'MissingAgentProviderApiKeyError';
    this.provider = provider;
  }
}

function getProviderInstance(provider: AgentResolvedModelSelection['provider'], apiKey: string) {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey });
    case 'openai':
      return createOpenAI({ apiKey });
    case 'gemini':
    case 'google':
      return createGoogleGenerativeAI({ apiKey });
    default:
      throw new Error(`Unsupported agent provider: ${provider}`);
  }
}

export function resolveRequestedModelSelection(
  models: AgentModelSummary[],
  requestedProvider?: string,
  requestedModelId?: string
): AgentResolvedModelSelection {
  const normalizedRequestedProvider = requestedProvider
    ? normalizeStoredAgentProviderName(requestedProvider) ?? requestedProvider
    : undefined;

  if (models.length === 0) {
    throw new Error('No enabled agent models are configured');
  }

  if (normalizedRequestedProvider && requestedModelId) {
    const matched = models.find(
      (model) => model.provider === normalizedRequestedProvider && model.modelId === requestedModelId
    );
    if (!matched) {
      throw new Error(`Model ${requestedProvider}:${requestedModelId} is not enabled`);
    }

    return {
      provider: matched.provider,
      modelId: matched.modelId,
    };
  }

  if (requestedModelId) {
    const matches = models.filter((model) => model.modelId === requestedModelId);
    if (matches.length === 0) {
      throw new Error(`Model ${requestedModelId} is not enabled`);
    }

    if (matches.length > 1) {
      throw new Error(`Model id ${requestedModelId} is ambiguous; provider is required`);
    }

    return {
      provider: matches[0].provider,
      modelId: matches[0].modelId,
    };
  }

  if (normalizedRequestedProvider) {
    const providerModels = models.filter((model) => model.provider === normalizedRequestedProvider);
    if (providerModels.length === 0) {
      throw new Error(`Provider ${requestedProvider} has no enabled models`);
    }

    const defaultProviderModel = providerModels.find((model) => model.default) || providerModels[0];
    return {
      provider: defaultProviderModel.provider,
      modelId: defaultProviderModel.modelId,
    };
  }

  const defaultModel = models.find((model) => model.default) || models[0];
  return {
    provider: defaultModel.provider,
    modelId: defaultModel.modelId,
  };
}

export default class AgentProviderRegistry {
  static getProviderEnvVarCandidates(providerName: string, explicitEnvVar?: string): string[] {
    return getProviderEnvVarCandidates(providerName, explicitEnvVar);
  }

  static async listAvailableModels(repoFullName?: string): Promise<AgentModelSummary[]> {
    const config = await AIAgentConfigService.getInstance().getEffectiveConfig(repoFullName);
    return transformProviderModels(config.providers || []).flatMap((model) => {
      const provider = normalizeModelProvider(model.provider);
      if (!provider) {
        return [];
      }

      return [
        {
          ...model,
          provider,
        },
      ];
    });
  }

  static async listAvailableModelsForUser({
    repoFullName,
    userIdentity,
  }: {
    repoFullName?: string;
    userIdentity: Pick<RequestUserIdentity, 'userId' | 'githubUsername'>;
  }): Promise<AgentModelSummary[]> {
    const models = await this.listAvailableModels(repoFullName);
    const uniqueProviders = [...new Set(models.map((model) => model.provider))];

    const configuredProviders = new Set<string>();
    await Promise.all(
      uniqueProviders.map(async (provider) => {
        const apiKey = await UserApiKeyService.getDecryptedKey(
          userIdentity.userId,
          provider,
          userIdentity.githubUsername
        );

        if (apiKey) {
          configuredProviders.add(provider);
        }
      })
    );

    return models.filter((model) => configuredProviders.has(model.provider));
  }

  static async resolveCredentialEnvMap({
    repoFullName,
    userIdentity,
  }: {
    repoFullName?: string;
    userIdentity: Pick<RequestUserIdentity, 'userId' | 'githubUsername'>;
  }): Promise<Record<string, string>> {
    let config;
    try {
      config = await AIAgentConfigService.getInstance().getEffectiveConfig(repoFullName);
    } catch (error) {
      getLogger().warn(
        { error, repoFullName },
        `AgentExec: provider credential resolution skipped repo=${repoFullName || 'none'}`
      );
      return {};
    }

    const providerConfigs = Array.isArray(config.providers) ? (config.providers as ProviderConfig[]) : [];
    const envMap: Record<string, string> = {};

    await Promise.all(
      providerConfigs
        .filter((provider) => provider?.enabled !== false && typeof provider.name === 'string')
        .map(async (provider) => {
          const envVarCandidates = this.getProviderEnvVarCandidates(provider.name, provider.apiKeyEnvVar);
          const apiKey = await UserApiKeyService.getDecryptedKey(
            userIdentity.userId,
            provider.name,
            userIdentity.githubUsername
          );

          if (!apiKey) {
            return;
          }

          for (const envVar of envVarCandidates) {
            envMap[envVar] = apiKey;
          }
        })
    );

    return envMap;
  }

  static async resolveSelection({
    repoFullName,
    requestedProvider,
    requestedModelId,
  }: {
    repoFullName?: string;
    requestedProvider?: string;
    requestedModelId?: string;
  }): Promise<AgentResolvedModelSelection> {
    const models = await this.listAvailableModels(repoFullName);
    return resolveRequestedModelSelection(models, requestedProvider, requestedModelId);
  }

  static async getRequiredStoredApiKey({
    provider,
    userIdentity,
  }: {
    provider: string;
    userIdentity: Pick<RequestUserIdentity, 'userId' | 'githubUsername'>;
  }): Promise<string> {
    const apiKey = await UserApiKeyService.getDecryptedKey(userIdentity.userId, provider, userIdentity.githubUsername);

    if (!apiKey) {
      throw new MissingAgentProviderApiKeyError(provider);
    }

    return apiKey;
  }

  static async createLanguageModel({
    selection,
    userIdentity,
  }: {
    repoFullName?: string;
    selection: AgentResolvedModelSelection;
    userIdentity: RequestUserIdentity;
  }): Promise<LanguageModel> {
    const apiKey = await this.getRequiredStoredApiKey({
      provider: selection.provider,
      userIdentity,
    });
    const provider = getProviderInstance(selection.provider, apiKey);

    return provider(selection.modelId);
  }
}
