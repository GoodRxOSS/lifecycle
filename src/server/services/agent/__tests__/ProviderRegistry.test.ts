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
import type { RequestUserIdentity } from 'server/lib/get-user';

const mockGetEffectiveConfig = jest.fn();
const mockWarn = jest.fn();
const mockImportEsm = jest.fn();
const mockLanguageModel = { id: 'mock-language-model' };
const mockLanguageModelProvider = jest.fn(() => mockLanguageModel);
const mockCreateAnthropic = jest.fn(() => mockLanguageModelProvider);
const mockCreateOpenAI = jest.fn(() => mockLanguageModelProvider);
const mockCreateGoogle = jest.fn(() => mockLanguageModelProvider);

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
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

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ warn: mockWarn })),
}));

jest.mock('server/lib/esmImport', () => ({
  importEsm: (specifier: string) => mockImportEsm(specifier),
}));

import AgentProviderRegistry, {
  AgentModelSelectionError,
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

const USER_IDENTITY: RequestUserIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
  preferredUsername: 'sample-user',
  email: 'sample-user@example.test',
  firstName: 'Sample',
  lastName: 'User',
  displayName: 'Sample User',
  gitUserName: 'Sample User',
  gitUserEmail: 'sample-user@example.test',
  roles: [],
};

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

  it('keeps configured model pricing on the resolved selection', () => {
    expect(
      resolveRequestedModelSelection(
        [
          {
            ...MODELS[0],
            inputCostPerMillion: 1.25,
            outputCostPerMillion: 10,
          },
        ],
        'gemini',
        'gemini-3-flash-preview'
      )
    ).toEqual({
      provider: 'gemini',
      modelId: 'gemini-3-flash-preview',
      inputCostPerMillion: 1.25,
      outputCostPerMillion: 10,
    });
  });

  it('normalizes the legacy google provider name when matching a model', () => {
    expect(resolveRequestedModelSelection(MODELS, 'google', 'gemini-3-flash-preview')).toEqual({
      provider: 'gemini',
      modelId: 'gemini-3-flash-preview',
    });
  });

  it('uses the provider default when multiple provider models are enabled', () => {
    const models = [
      { ...MODELS[0], modelId: 'gemini-first', default: false },
      { ...MODELS[0], modelId: 'gemini-default', default: true },
    ];

    expect(resolveRequestedModelSelection(models, 'gemini')).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-default',
    });
  });

  it('uses the first model when no global default is configured', () => {
    const models = MODELS.map((model) => ({ ...model, default: false }));

    expect(resolveRequestedModelSelection(models)).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-3-flash-preview',
    });
  });

  it.each([
    ['no models are enabled', [], undefined, undefined, 'No enabled agent models are configured'],
    [
      'an explicit pair is not enabled',
      MODELS,
      'anthropic',
      'claude-missing',
      'Model anthropic:claude-missing is not enabled',
    ],
    ['a model id is not enabled', MODELS, undefined, 'missing-model', 'Model missing-model is not enabled'],
    [
      'a model id is ambiguous',
      [
        { ...MODELS[0], modelId: 'shared-model' },
        { ...MODELS[1], modelId: 'shared-model' },
      ],
      undefined,
      'shared-model',
      'Model id shared-model is ambiguous; provider is required',
    ],
    ['a provider has no models', MODELS, 'openai', undefined, 'Provider openai has no enabled models'],
    ['the provider is unsupported', MODELS, 'bedrock', undefined, 'Provider bedrock has no enabled models'],
  ])('throws a typed selection error when %s', (_case, models, provider, modelId, message) => {
    const resolve = () => resolveRequestedModelSelection(models as AgentModelSummary[], provider, modelId);

    expect(resolve).toThrow(AgentModelSelectionError);
    expect(resolve).toThrow(message);
  });
});

describe('AgentProviderRegistry credential resolution', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalGeminiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockImportEsm.mockImplementation(async (specifier: string) => {
      switch (specifier) {
        case '@ai-sdk/anthropic':
          return { createAnthropic: mockCreateAnthropic };
        case '@ai-sdk/openai':
          return { createOpenAI: mockCreateOpenAI };
        case '@ai-sdk/google':
          return { createGoogle: mockCreateGoogle };
        default:
          throw new Error(`Unexpected ESM import: ${specifier}`);
      }
    });
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
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterAll(() => {
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }

    if (originalGeminiKey === undefined) {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    } else {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalGeminiKey;
    }

    if (originalGoogleKey === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = originalGoogleKey;
    }
  });

  it('uses stored user keys for provider credential env maps', async () => {
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

  it('returns a stored user key without reading shared configuration', async () => {
    (UserApiKeyService.getDecryptedKey as jest.Mock).mockResolvedValueOnce('stored-user-key');

    await expect(
      AgentProviderRegistry.getProviderApiKey({
        repoFullName: 'example-org/example-repo',
        provider: 'openai',
        userIdentity: USER_IDENTITY,
      })
    ).resolves.toBe('stored-user-key');
    expect(UserApiKeyService.getDecryptedKey).toHaveBeenCalledWith('sample-user', 'openai', 'sample-user');
    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
  });

  it('uses shared provider env keys when no user key is stored', async () => {
    process.env.ANTHROPIC_API_KEY = 'shared-anthropic-key';

    await expect(
      AgentProviderRegistry.resolveCredentialEnvMap({
        repoFullName: 'example-org/example-repo',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        },
      })
    ).resolves.toEqual({
      ANTHROPIC_API_KEY: 'shared-anthropic-key',
    });
  });

  it('falls back to shared environment credentials when configuration lookup fails', async () => {
    const configError = new Error('configuration unavailable');
    mockGetEffectiveConfig.mockRejectedValueOnce(configError);
    process.env.ANTHROPIC_API_KEY = '  fallback-anthropic-key  ';

    await expect(AgentProviderRegistry.getSharedProviderApiKey({ provider: 'anthropic' })).resolves.toBe(
      'fallback-anthropic-key'
    );
    expect(mockWarn).toHaveBeenCalledWith(
      { error: configError, repoFullName: undefined, provider: 'anthropic' },
      'AgentExec: shared provider credential lookup skipped provider=anthropic repo=none'
    );
  });

  it('ignores a disabled provider config and tries each default environment candidate', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      providers: [
        {
          name: 'gemini',
          enabled: false,
          apiKeyEnvVar: 'DISABLED_GEMINI_API_KEY',
          models: [],
        },
      ],
    });
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = '   ';
    process.env.GOOGLE_API_KEY = 'google-fallback-key';

    await expect(AgentProviderRegistry.getSharedProviderApiKey({ provider: 'google' })).resolves.toBe(
      'google-fallback-key'
    );
  });

  it('returns no shared credential for an unsupported provider name', async () => {
    await expect(AgentProviderRegistry.getSharedProviderApiKey({ provider: 'bedrock' })).resolves.toBeNull();
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

  it('returns no available models when the effective config has no providers', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({ providers: [] });

    await expect(AgentProviderRegistry.listAvailableModels()).resolves.toEqual([]);
  });

  it('resolves a requested selection from effective repository configuration', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      providers: [
        {
          name: 'openai',
          enabled: true,
          apiKeyEnvVar: 'OPENAI_API_KEY',
          models: [
            {
              id: 'gpt-5',
              displayName: 'GPT-5',
              enabled: true,
              default: true,
              maxTokens: 16384,
            },
          ],
        },
      ],
    });

    await expect(
      AgentProviderRegistry.resolveSelection({
        repoFullName: 'example-org/example-repo',
        requestedProvider: 'openai',
        requestedModelId: 'gpt-5',
      })
    ).resolves.toEqual({ provider: 'openai', modelId: 'gpt-5' });
    expect(mockGetEffectiveConfig).toHaveBeenCalledWith('example-org/example-repo');
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

  it('returns an empty credential map and warns when effective config cannot be read', async () => {
    const configError = new Error('repository config unavailable');
    mockGetEffectiveConfig.mockRejectedValueOnce(configError);

    await expect(AgentProviderRegistry.resolveCredentialEnvMap({ userIdentity: USER_IDENTITY })).resolves.toEqual({});
    expect(UserApiKeyService.getDecryptedKey).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      { error: configError, repoFullName: undefined },
      'AgentExec: provider credential resolution skipped repo=none'
    );
  });

  it('does not resolve credentials for disabled providers', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      providers: [
        {
          name: 'anthropic',
          enabled: false,
          apiKeyEnvVar: 'ANTHROPIC_API_KEY',
          models: [],
        },
      ],
    });
    process.env.ANTHROPIC_API_KEY = 'disabled-provider-key';

    await expect(
      AgentProviderRegistry.resolveCredentialEnvMap({
        repoFullName: 'example-org/example-repo',
        userIdentity: USER_IDENTITY,
      })
    ).resolves.toEqual({});
    expect(UserApiKeyService.getDecryptedKey).not.toHaveBeenCalled();
  });

  it('uses the shared provider env key when the requested provider has no stored user key', async () => {
    process.env.ANTHROPIC_API_KEY = 'shared-anthropic-key';

    await expect(
      AgentProviderRegistry.getRequiredProviderApiKey({
        provider: 'anthropic',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        },
        repoFullName: 'example-org/example-repo',
      })
    ).resolves.toBe('shared-anthropic-key');
  });

  it('throws when the requested provider has no user or shared key', async () => {
    await expect(
      AgentProviderRegistry.getRequiredProviderApiKey({
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

  it('lists models backed by shared provider env keys', async () => {
    process.env.ANTHROPIC_API_KEY = 'shared-anthropic-key';
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
      ],
    });

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
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        default: true,
        maxTokens: 8192,
      },
    ]);
  });

  it('does not look up credentials when no models are enabled', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({ providers: [] });

    await expect(AgentProviderRegistry.listAvailableModelsForUser({ userIdentity: USER_IDENTITY })).resolves.toEqual(
      []
    );
    expect(UserApiKeyService.getDecryptedKey).not.toHaveBeenCalled();
  });

  it.each([
    ['anthropic', '@ai-sdk/anthropic', mockCreateAnthropic],
    ['openai', '@ai-sdk/openai', mockCreateOpenAI],
    ['gemini', '@ai-sdk/google', mockCreateGoogle],
    ['google', '@ai-sdk/google', mockCreateGoogle],
  ])(
    'creates a language model for the %s provider with the resolved user credential',
    async (provider, moduleId, createProvider) => {
      (UserApiKeyService.getDecryptedKey as jest.Mock).mockResolvedValueOnce('stored-user-key');

      await expect(
        AgentProviderRegistry.createLanguageModel({
          repoFullName: 'example-org/example-repo',
          selection: { provider, modelId: 'selected-model' },
          userIdentity: USER_IDENTITY,
        })
      ).resolves.toBe(mockLanguageModel);
      expect(mockImportEsm).toHaveBeenCalledWith(moduleId);
      expect(createProvider).toHaveBeenCalledWith({ apiKey: 'stored-user-key' });
      expect(mockLanguageModelProvider).toHaveBeenCalledWith('selected-model');
      expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
    }
  );

  it('rejects an unsupported provider without importing an SDK', async () => {
    (UserApiKeyService.getDecryptedKey as jest.Mock).mockResolvedValueOnce('stored-user-key');

    await expect(
      AgentProviderRegistry.createLanguageModel({
        selection: { provider: 'bedrock', modelId: 'selected-model' },
        userIdentity: USER_IDENTITY,
      })
    ).rejects.toThrow('Unsupported agent provider: bedrock');
    expect(mockImportEsm).not.toHaveBeenCalled();
    expect(mockLanguageModelProvider).not.toHaveBeenCalled();
  });

  it('does not import a provider SDK when credentials are unavailable', async () => {
    await expect(
      AgentProviderRegistry.createLanguageModel({
        selection: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
        userIdentity: USER_IDENTITY,
      })
    ).rejects.toMatchObject({
      name: 'MissingAgentProviderApiKeyError',
      code: 'provider_api_key_required',
      provider: 'anthropic',
    });
    expect(mockImportEsm).not.toHaveBeenCalled();
  });
});
