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

const mockAgentSessionQuery = jest.fn();
const mockAgentSessionTransaction = jest.fn();
const mockAgentThreadQuery = jest.fn();
const mockCreateSessionSource = jest.fn();
const mockResolveSelection = jest.fn();
const mockGetRequiredProviderApiKey = jest.fn();
const mockValidateEntryChoices = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentSessionQuery(...args),
    transaction: (...args: unknown[]) => mockAgentSessionTransaction(...args),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentThreadQuery(...args),
  },
}));

jest.mock('../ProviderRegistry', () => ({
  __esModule: true,
  default: {
    resolveSelection: (...args: unknown[]) => mockResolveSelection(...args),
    getRequiredProviderApiKey: (...args: unknown[]) => mockGetRequiredProviderApiKey(...args),
  },
}));

jest.mock('../SourceService', () => ({
  __esModule: true,
  default: {
    createSessionSource: (...args: unknown[]) => mockCreateSessionSource(...args),
  },
}));

jest.mock('../ThreadRuntimeControlsService', () => ({
  __esModule: true,
  default: {
    validateEntryChoices: (...args: unknown[]) => mockValidateEntryChoices(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: mockLoggerInfo,
  }),
}));

import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';
import AgentChatSessionService from '../ChatSessionService';

const TEST_TRX = { name: 'trx' };

function arrangePersistence() {
  let insertedSession: Record<string, unknown> | null = null;
  let finalizedSession: Record<string, unknown> | null = null;

  const sessionInsertAndFetch = jest.fn(async (payload) => {
    insertedSession = {
      id: 17,
      uuid: payload.uuid,
      defaultThreadId: null,
      ...payload,
    };
    return insertedSession;
  });
  const sessionPatchAndFetchById = jest.fn(async (_id, patch) => {
    finalizedSession = {
      ...insertedSession,
      ...patch,
    };
    return finalizedSession;
  });
  const threadInsertAndFetch = jest.fn(async (payload) => ({
    id: 23,
    uuid: 'sample-thread',
    ...payload,
  }));

  mockAgentSessionQuery.mockImplementation((trx?: unknown) => {
    if (trx) {
      return {
        insertAndFetch: sessionInsertAndFetch,
        patchAndFetchById: sessionPatchAndFetchById,
      };
    }

    return {};
  });
  mockAgentThreadQuery.mockImplementation((trx?: unknown) => {
    if (trx) {
      return {
        insertAndFetch: threadInsertAndFetch,
      };
    }

    return {};
  });
  mockAgentSessionTransaction.mockImplementation(async (callback) => callback(TEST_TRX));
  mockCreateSessionSource.mockResolvedValue({ id: 31 });

  return {
    sessionInsertAndFetch,
    sessionPatchAndFetchById,
    threadInsertAndFetch,
  };
}

describe('AgentChatSessionService.createChatSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequiredProviderApiKey.mockResolvedValue('sample-key');
    mockValidateEntryChoices.mockResolvedValue(null);
  });

  it('passes provider and model to provider resolution so duplicate model ids are disambiguated', async () => {
    const persistence = arrangePersistence();
    mockResolveSelection.mockResolvedValue({
      provider: 'sample-provider',
      modelId: 'sample-model',
    });

    await AgentChatSessionService.createChatSession({
      userId: 'sample-user',
      provider: 'sample-provider',
      model: 'sample-model',
    });

    expect(mockResolveSelection).toHaveBeenCalledWith({
      repoFullName: undefined,
      requestedProvider: 'sample-provider',
      requestedModelId: 'sample-model',
    });
    expect(mockGetRequiredProviderApiKey).toHaveBeenCalledWith({
      provider: 'sample-provider',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: null,
      },
      repoFullName: undefined,
    });
    expect(persistence.sessionInsertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModel: 'sample-model',
        model: 'sample-model',
        defaultHarness: 'lifecycle_ai_sdk',
        sessionKind: AgentSessionKind.CHAT,
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.NONE,
      })
    );
    expect(mockCreateSessionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModel: 'sample-model',
        model: 'sample-model',
      }),
      expect.objectContaining({
        defaultProvider: 'sample-provider',
      })
    );
  });

  it('rejects an invalid provider and model pair through provider registry resolution', async () => {
    const invalidProviderModelPairError = new Error('Model sample-provider:sample-model is not enabled');
    mockResolveSelection.mockRejectedValue(invalidProviderModelPairError);

    await expect(
      AgentChatSessionService.createChatSession({
        userId: 'sample-user',
        provider: 'sample-provider',
        model: 'sample-model',
      })
    ).rejects.toBe(invalidProviderModelPairError);

    expect(mockResolveSelection).toHaveBeenCalledWith({
      repoFullName: undefined,
      requestedProvider: 'sample-provider',
      requestedModelId: 'sample-model',
    });
    expect(mockAgentSessionTransaction).not.toHaveBeenCalled();
  });

  it('validates and persists runtime choices to the created default thread before returning', async () => {
    const persistence = arrangePersistence();
    mockResolveSelection.mockResolvedValue({
      provider: 'sample-provider',
      modelId: 'sample-model',
    });
    mockValidateEntryChoices.mockResolvedValue({
      selectedAgentMetadataPatch: {
        selectedAgentDefinitionId: 'custom.sample-agent',
      },
      runtimeControlChoices: {
        version: 1,
        toolChoiceIds: ['rtc_tool_choice'],
        mcpChoiceIds: [],
      },
    });

    await AgentChatSessionService.createChatSession({
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any,
      provider: 'sample-provider',
      model: 'sample-model',
      runtimeControlChoices: {
        agentId: 'custom.sample-agent',
        toolChoiceIds: ['rtc_tool_choice'],
        mcpChoiceIds: [],
      },
    });

    expect(mockValidateEntryChoices).toHaveBeenCalledWith({
      userIdentity: expect.objectContaining({
        userId: 'sample-user',
        githubUsername: 'sample-user',
      }),
      agentId: 'custom.sample-agent',
      source: { adapter: 'blank_workspace', input: {} },
      defaults: {
        provider: 'sample-provider',
        model: 'sample-model',
      },
      runtimeControlChoices: {
        agentId: 'custom.sample-agent',
        toolChoiceIds: ['rtc_tool_choice'],
        mcpChoiceIds: [],
      },
    });
    expect(persistence.threadInsertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          sessionUuid: expect.any(String),
          selectedAgentDefinitionId: 'custom.sample-agent',
          runtimeControlChoices: {
            version: 1,
            toolChoiceIds: ['rtc_tool_choice'],
            mcpChoiceIds: [],
          },
        },
      })
    );
  });

  it('leaves runtime choice metadata absent when bootstrap choices are omitted', async () => {
    const persistence = arrangePersistence();
    mockResolveSelection.mockResolvedValue({
      provider: 'sample-provider',
      modelId: 'sample-model',
    });

    await AgentChatSessionService.createChatSession({
      userId: 'sample-user',
      provider: 'sample-provider',
      model: 'sample-model',
    });

    expect(mockValidateEntryChoices).not.toHaveBeenCalled();
    expect(persistence.threadInsertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          sessionUuid: expect.any(String),
        },
      })
    );
  });

  it('persists selected agent metadata without runtime choices for agent-only bootstrap input', async () => {
    const persistence = arrangePersistence();
    mockResolveSelection.mockResolvedValue({
      provider: 'sample-provider',
      modelId: 'sample-model',
    });
    mockValidateEntryChoices.mockResolvedValue({
      selectedAgentMetadataPatch: {
        selectedAgentDefinitionId: 'custom.sample-agent',
      },
      runtimeControlChoices: null,
    });

    await AgentChatSessionService.createChatSession({
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any,
      provider: 'sample-provider',
      model: 'sample-model',
      runtimeControlChoices: {
        agentId: 'custom.sample-agent',
      },
    });

    expect(persistence.threadInsertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          sessionUuid: expect.any(String),
          selectedAgentDefinitionId: 'custom.sample-agent',
        },
      })
    );
  });
});
