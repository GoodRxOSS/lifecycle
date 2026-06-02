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
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import UserApiKeyService from 'server/services/userApiKey';
import { transformProviderModels } from 'server/services/agentRuntime/models/modelTransformation';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import { BadRequestError } from 'server/lib/appError';
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

export class MissingAgentProviderApiKeyError extends BadRequestError {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `No API key is configured for provider "${provider}". Save your ${provider} API key in Agent Session settings or configure a shared Agent provider key.`,
      'provider_api_key_required',
      { provider }
    );
    this.name = 'MissingAgentProviderApiKeyError';
    this.provider = provider;
  }
}

export class AgentModelSelectionError extends BadRequestError {
  constructor(message: string) {
    super(message, 'model_selection_invalid');
    this.name = 'AgentModelSelectionError';
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

function readSharedProviderApiKey(providerName: string, explicitEnvVar?: string): string | null {
  for (const envVar of getProviderEnvVarCandidates(providerName, explicitEnvVar)) {
    const apiKey = process.env[envVar]?.trim();
    if (apiKey) {
      return apiKey;
    }
  }

  return null;
}

function findProviderConfig(providerConfigs: ProviderConfig[], providerName: string): ProviderConfig | null {
  const targetProvider = normalizeStoredAgentProviderName(providerName) || providerName;
  return (
    providerConfigs.find((provider) => {
      if (provider?.enabled === false || typeof provider.name !== 'string') {
        return false;
      }

      const normalized = normalizeStoredAgentProviderName(provider.name) || provider.name;
      return normalized === targetProvider;
    }) || null
  );
}

function toResolvedModelSelection(model: AgentModelSummary): AgentResolvedModelSelection {
  const selection: AgentResolvedModelSelection = {
    provider: model.provider,
    modelId: model.modelId,
  };

  if (typeof model.inputCostPerMillion === 'number') {
    selection.inputCostPerMillion = model.inputCostPerMillion;
  }

  if (typeof model.outputCostPerMillion === 'number') {
    selection.outputCostPerMillion = model.outputCostPerMillion;
  }

  return selection;
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
    throw new AgentModelSelectionError('No enabled agent models are configured');
  }

  if (normalizedRequestedProvider && requestedModelId) {
    const matched = models.find(
      (model) => model.provider === normalizedRequestedProvider && model.modelId === requestedModelId
    );
    if (!matched) {
      throw new AgentModelSelectionError(`Model ${requestedProvider}:${requestedModelId} is not enabled`);
    }

    return toResolvedModelSelection(matched);
  }

  if (requestedModelId) {
    const matches = models.filter((model) => model.modelId === requestedModelId);
    if (matches.length === 0) {
      throw new AgentModelSelectionError(`Model ${requestedModelId} is not enabled`);
    }

    if (matches.length > 1) {
      throw new AgentModelSelectionError(`Model id ${requestedModelId} is ambiguous; provider is required`);
    }

    return toResolvedModelSelection(matches[0]);
  }

  if (normalizedRequestedProvider) {
    const providerModels = models.filter((model) => model.provider === normalizedRequestedProvider);
    if (providerModels.length === 0) {
      throw new AgentModelSelectionError(`Provider ${requestedProvider} has no enabled models`);
    }

    const defaultProviderModel = providerModels.find((model) => model.default) || providerModels[0];
    return toResolvedModelSelection(defaultProviderModel);
  }

  const defaultModel = models.find((model) => model.default) || models[0];
  return toResolvedModelSelection(defaultModel);
}

export default class AgentProviderRegistry {
  static getProviderEnvVarCandidates(providerName: string, explicitEnvVar?: string): string[] {
    return getProviderEnvVarCandidates(providerName, explicitEnvVar);
  }

  private static async getEnabledProviderConfig(
    repoFullName: string | undefined,
    providerName: string
  ): Promise<ProviderConfig | null> {
    const config = await AgentRuntimeConfigService.getInstance().getEffectiveConfig(repoFullName);
    const providerConfigs = Array.isArray(config.providers) ? (config.providers as ProviderConfig[]) : [];
    return findProviderConfig(providerConfigs, providerName);
  }

  static async getSharedProviderApiKey({
    repoFullName,
    provider,
  }: {
    repoFullName?: string;
    provider: string;
  }): Promise<string | null> {
    const providerConfig = await this.getEnabledProviderConfig(repoFullName, provider).catch((error) => {
      getLogger().warn(
        { error, repoFullName, provider },
        `AgentExec: shared provider credential lookup skipped provider=${provider} repo=${repoFullName || 'none'}`
      );
      return null;
    });

    return readSharedProviderApiKey(providerConfig?.name || provider, providerConfig?.apiKeyEnvVar);
  }

  static async getProviderApiKey({
    repoFullName,
    provider,
    userIdentity,
    apiKeyEnvVar,
  }: {
    repoFullName?: string;
    provider: string;
    userIdentity: Pick<RequestUserIdentity, 'userId' | 'githubUsername'>;
    apiKeyEnvVar?: string;
  }): Promise<string | null> {
    const userApiKey = await UserApiKeyService.getDecryptedKey(
      userIdentity.userId,
      provider,
      userIdentity.githubUsername
    );
    if (userApiKey) {
      return userApiKey;
    }

    const sharedApiKey =
      apiKeyEnvVar === undefined
        ? await this.getSharedProviderApiKey({ repoFullName, provider })
        : readSharedProviderApiKey(provider, apiKeyEnvVar);
    return sharedApiKey;
  }

  static async listAvailableModels(repoFullName?: string): Promise<AgentModelSummary[]> {
    const config = await AgentRuntimeConfigService.getInstance().getEffectiveConfig(repoFullName);
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
        const apiKey = await this.getProviderApiKey({
          repoFullName,
          provider,
          userIdentity,
        });

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
      config = await AgentRuntimeConfigService.getInstance().getEffectiveConfig(repoFullName);
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
          const apiKey = await this.getProviderApiKey({
            repoFullName,
            provider: provider.name,
            userIdentity,
            apiKeyEnvVar: provider.apiKeyEnvVar,
          });

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

  static async getRequiredProviderApiKey({
    provider,
    userIdentity,
    repoFullName,
  }: {
    provider: string;
    userIdentity: Pick<RequestUserIdentity, 'userId' | 'githubUsername'>;
    repoFullName?: string;
  }): Promise<string> {
    const apiKey = await this.getProviderApiKey({
      repoFullName,
      provider,
      userIdentity,
    });

    if (!apiKey) {
      throw new MissingAgentProviderApiKeyError(provider);
    }

    return apiKey;
  }

  static async createLanguageModel({
    repoFullName,
    selection,
    userIdentity,
  }: {
    repoFullName?: string;
    selection: AgentResolvedModelSelection;
    userIdentity: RequestUserIdentity;
  }): Promise<LanguageModel> {
    const apiKey = await this.getRequiredProviderApiKey({
      provider: selection.provider,
      userIdentity,
      repoFullName,
    });
    const provider = getProviderInstance(selection.provider, apiKey);

    return provider(selection.modelId);
  }
}
