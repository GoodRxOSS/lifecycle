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

import type { AgentModelSummary } from '../types';

const mockGetEffectiveConfig = jest.fn();

jest.mock('server/services/aiAgentConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: mockGetEffectiveConfig,
    })),
  },
}));

jest.mock('server/services/userApiKey', () => ({
  __esModule: true,
  default: {
    getDecryptedKey: jest.fn(),
  },
}));

import AgentProviderRegistry, {
  MissingAgentProviderApiKeyError,
  resolveRequestedModelSelection,
} from '../ProviderRegistry';
import UserApiKeyService from 'server/services/userApiKey';

const MODELS: AgentModelSummary[] = [
  {
    provider: 'gemini',
    modelId: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash Preview',
    default: true,
    maxTokens: 8192,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    default: false,
    maxTokens: 8192,
  },
];

describe('resolveRequestedModelSelection', () => {
  it('uses the explicit provider and model when both are provided', () => {
    expect(resolveRequestedModelSelection(MODELS, 'anthropic', 'claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('infers the provider when only modelId is provided', () => {
    expect(resolveRequestedModelSelection(MODELS, undefined, 'claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('uses the provider default when only provider is provided', () => {
    expect(resolveRequestedModelSelection(MODELS, 'anthropic')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('falls back to the global default model when nothing is requested', () => {
    expect(resolveRequestedModelSelection(MODELS)).toEqual({
      provider: 'gemini',
      modelId: 'gemini-3-flash-preview',
    });
  });
});

describe('AgentProviderRegistry credential resolution', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEffectiveConfig.mockResolvedValue({
      providers: [
        {
          name: 'anthropic',
          enabled: true,
          apiKeyEnvVar: 'ANTHROPIC_API_KEY',
          models: [],
        },
        {
          name: 'gemini',
          enabled: true,
          apiKeyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
          models: [],
        },
      ],
    });
    (UserApiKeyService.getDecryptedKey as jest.Mock).mockResolvedValue(null);
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key-that-must-be-ignored';
  });

  afterAll(() => {
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  it('uses stored user keys and ignores process env fallback', async () => {
    (UserApiKeyService.getDecryptedKey as jest.Mock).mockImplementation(async (_userId: string, provider: string) => {
      if (provider === 'gemini') {
        return 'user-gemini-key';
      }

      return null;
    });

    await expect(
      AgentProviderRegistry.resolveCredentialEnvMap({
        repoFullName: 'example-org/example-repo',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        },
      })
    ).resolves.toEqual({
      GOOGLE_GENERATIVE_AI_API_KEY: 'user-gemini-key',
    });
  });

  it('normalizes google provider configs to gemini for AI SDK sessions', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      providers: [
        {
          name: 'google',
          enabled: true,
          apiKeyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
          models: [
            {
              id: 'gemini-3-flash-preview',
              displayName: 'Gemini 3 Flash Preview',
              enabled: true,
              default: true,
              maxTokens: 8192,
            },
          ],
        },
      ],
    });

    await expect(AgentProviderRegistry.listAvailableModels('example-org/example-repo')).resolves.toEqual([
      {
        provider: 'gemini',
        modelId: 'gemini-3-flash-preview',
        displayName: 'Gemini 3 Flash Preview',
        default: true,
        maxTokens: 8192,
      },
    ]);
  });

  it('uses stored gemini keys for google provider configs', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      providers: [
        {
          name: 'google',
          enabled: true,
          apiKeyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
          models: [],
        },
      ],
    });
    (UserApiKeyService.getDecryptedKey as jest.Mock).mockImplementation(async (_userId: string, provider: string) => {
      if (provider === 'google') {
        return 'user-gemini-key';
      }

      return null;
    });

    await expect(
      AgentProviderRegistry.resolveCredentialEnvMap({
        repoFullName: 'example-org/example-repo',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        },
      })
    ).resolves.toEqual({
      GOOGLE_GENERATIVE_AI_API_KEY: 'user-gemini-key',
    });
  });

  it('throws when the requested provider has no stored user key', async () => {
    await expect(
      AgentProviderRegistry.getRequiredStoredApiKey({
        provider: 'anthropic',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        },
      })
    ).rejects.toBeInstanceOf(MissingAgentProviderApiKeyError);
  });

  it('lists only models backed by stored user keys', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      providers: [
        {
          name: 'anthropic',
          enabled: true,
          apiKeyEnvVar: 'ANTHROPIC_API_KEY',
          models: [
            {
              id: 'claude-sonnet-4-5',
              displayName: 'Claude Sonnet 4.5',
              enabled: true,
              default: true,
              maxTokens: 8192,
            },
          ],
        },
        {
          name: 'gemini',
          enabled: true,
          apiKeyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
          models: [
            {
              id: 'gemini-3-flash-preview',
              displayName: 'Gemini 3 Flash Preview',
              enabled: true,
              default: true,
              maxTokens: 8192,
            },
          ],
        },
      ],
    });
    (UserApiKeyService.getDecryptedKey as jest.Mock).mockImplementation(async (_userId: string, provider: string) =>
      provider === 'gemini' ? 'user-gemini-key' : null
    );

    await expect(
      AgentProviderRegistry.listAvailableModelsForUser({
        repoFullName: 'example-org/example-repo',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        },
      })
    ).resolves.toEqual([
      {
        provider: 'gemini',
        modelId: 'gemini-3-flash-preview',
        displayName: 'Gemini 3 Flash Preview',
        default: true,
        maxTokens: 8192,
      },
    ]);
  });
});
