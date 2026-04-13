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

import type { RequestUserIdentity } from 'server/lib/get-user';
import AIAgentConfigService from 'server/services/aiAgentConfig';
import UserApiKeyService from 'server/services/userApiKey';
import { McpConfigService } from 'server/services/ai/mcp/config';
import type { AgentMcpConnection } from 'server/services/ai/mcp/types';
import { normalizeStoredAgentProviderName, type StoredAgentProviderName } from './providerConfig';

export type AgentProviderCredentialState = {
  provider: StoredAgentProviderName;
  hasKey: boolean;
  maskedKey?: string;
  updatedAt?: string | null;
};

export type AgentSettingsSnapshot = {
  providers: AgentProviderCredentialState[];
  mcpConnections: AgentMcpConnection[];
};

export default class AgentSettingsService {
  static async getConfiguredProviders(repoFullName?: string): Promise<StoredAgentProviderName[]> {
    try {
      const config = await AIAgentConfigService.getInstance().getEffectiveConfig(repoFullName);
      const configuredProviders = (config.providers || [])
        .map((provider: { name?: unknown; enabled?: unknown }) =>
          provider.enabled !== false && typeof provider.name === 'string'
            ? normalizeStoredAgentProviderName(provider.name)
            : null
        )
        .filter((provider): provider is StoredAgentProviderName => provider != null);

      return configuredProviders;
    } catch {
      return [];
    }
  }

  static async getProviderCredentialStates(
    userIdentity: RequestUserIdentity,
    repoFullName?: string
  ): Promise<AgentProviderCredentialState[]> {
    const providers = await this.getConfiguredProviders(repoFullName);
    return Promise.all(
      providers.map(async (provider) => {
        const masked = await UserApiKeyService.getMaskedKey(userIdentity.userId, provider, userIdentity.githubUsername);

        return masked
          ? {
              provider,
              hasKey: true,
              maskedKey: masked.maskedKey,
              updatedAt: masked.updatedAt,
            }
          : {
              provider,
              hasKey: false,
            };
      })
    );
  }

  static async getSettingsSnapshot(
    userIdentity: RequestUserIdentity,
    repoFullName?: string
  ): Promise<AgentSettingsSnapshot> {
    const mcpConfigService = new McpConfigService();
    const [providers, mcpConnections] = await Promise.all([
      this.getProviderCredentialStates(userIdentity, repoFullName),
      mcpConfigService.listEnabledConnectionsForUser(repoFullName, userIdentity),
    ]);

    return {
      providers,
      mcpConnections,
    };
  }
}
