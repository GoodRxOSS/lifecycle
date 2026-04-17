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

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

import AIAgentConfigService from 'server/services/aiAgentConfig';
import GlobalConfigService from 'server/services/globalConfig';
import type { AIAgentConfig } from 'server/services/types/aiAgentConfig';

function makeService() {
  const repoUpsertQuery = {
    insert: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    merge: jest.fn().mockResolvedValue(undefined),
  };

  const knex = Object.assign(jest.fn().mockReturnValue(repoUpsertQuery), {
    fn: {
      now: jest.fn(() => 'now'),
    },
  });

  const db = { knex } as any;
  const redis = { del: jest.fn().mockResolvedValue(undefined) } as any;
  const redlock = {} as any;
  const queueManager = {} as any;

  return {
    service: new AIAgentConfigService(db, redis, redlock, queueManager),
    knex,
    repoUpsertQuery,
    redis,
  };
}

describe('AIAgentConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates global additive rules without revalidating unrelated provider defaults', async () => {
    const { service } = makeService();
    const currentConfig: AIAgentConfig = {
      enabled: true,
      providers: [
        {
          name: 'gemini',
          enabled: true,
          apiKeyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
          models: [
            {
              id: 'gemini-1',
              displayName: 'Gemini 1',
              enabled: true,
              default: true,
              maxTokens: 8192,
            },
            {
              id: 'gemini-2',
              displayName: 'Gemini 2',
              enabled: true,
              default: true,
              maxTokens: 8192,
            },
          ],
        },
      ],
      maxMessagesPerSession: 50,
      sessionTTL: 3600,
    };

    const setConfig = jest.fn().mockResolvedValue(undefined);
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getConfig: jest.fn().mockResolvedValue(currentConfig),
      setConfig,
    });

    const result = await service.updateGlobalAdditiveRules(['test']);

    expect(setConfig).toHaveBeenCalledWith(
      'aiAgent',
      expect.objectContaining({
        providers: currentConfig.providers,
        additiveRules: ['test'],
      })
    );
    expect(result.additiveRules).toEqual(['test']);
    expect(result.providers).toEqual(currentConfig.providers);
  });

  it('replaces global approval policy without revalidating unrelated provider defaults', async () => {
    const { service } = makeService();
    const currentConfig: AIAgentConfig = {
      enabled: true,
      providers: [
        {
          name: 'gemini',
          enabled: true,
          apiKeyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
          models: [
            {
              id: 'gemini-1',
              displayName: 'Gemini 1',
              enabled: true,
              default: true,
              maxTokens: 8192,
            },
            {
              id: 'gemini-2',
              displayName: 'Gemini 2',
              enabled: true,
              default: true,
              maxTokens: 8192,
            },
          ],
        },
      ],
      maxMessagesPerSession: 50,
      sessionTTL: 3600,
      approvalPolicy: {
        defaultMode: 'require_approval',
      },
    };

    const setConfig = jest.fn().mockResolvedValue(undefined);
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getConfig: jest.fn().mockResolvedValue(currentConfig),
      setConfig,
    });

    const result = await service.updateGlobalApprovalPolicy({
      defaultMode: 'require_approval',
      rules: {
        shell_exec: 'deny',
      },
    });

    expect(setConfig).toHaveBeenCalledWith(
      'aiAgent',
      expect.objectContaining({
        providers: currentConfig.providers,
        approvalPolicy: {
          defaultMode: 'require_approval',
          rules: {
            shell_exec: 'deny',
          },
        },
      })
    );
    expect(result.approvalPolicy).toEqual({
      defaultMode: 'require_approval',
      rules: {
        shell_exec: 'deny',
      },
    });
    expect(result.providers).toEqual(currentConfig.providers);
  });

  it('clears the global approval policy when given an empty replacement', async () => {
    const { service } = makeService();
    const currentConfig: AIAgentConfig = {
      enabled: true,
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
              maxTokens: 8192,
            },
          ],
        },
      ],
      maxMessagesPerSession: 50,
      sessionTTL: 3600,
      approvalPolicy: {
        defaultMode: 'deny',
        rules: {
          shell_exec: 'deny',
        },
      },
    };

    const setConfig = jest.fn().mockResolvedValue(undefined);
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getConfig: jest.fn().mockResolvedValue(currentConfig),
      setConfig,
    });

    const result = await service.updateGlobalApprovalPolicy({});

    expect(setConfig).toHaveBeenCalledWith(
      'aiAgent',
      expect.objectContaining({
        providers: currentConfig.providers,
      })
    );
    expect(setConfig.mock.calls[0]?.[1]).not.toHaveProperty('approvalPolicy');
    expect(result.approvalPolicy).toBeUndefined();
    expect(result.providers).toEqual(currentConfig.providers);
  });

  it('updates repo additive rules while preserving other repo overrides', async () => {
    const { service, knex, repoUpsertQuery, redis } = makeService();

    jest.spyOn(service, 'getRepoConfig').mockResolvedValue({
      excludedTools: ['tool-a'],
      approvalPolicy: {
        defaultMode: 'require_approval',
      },
    });

    const result = await service.updateRepoAdditiveRules('Example-Org/Example-Repo', ['test']);

    expect(knex).toHaveBeenCalledWith('ai_agent_repo_config');
    expect(repoUpsertQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'example-org/example-repo',
        config: JSON.stringify({
          excludedTools: ['tool-a'],
          approvalPolicy: {
            defaultMode: 'require_approval',
          },
          additiveRules: ['test'],
        }),
      })
    );
    expect(redis.del).toHaveBeenCalledWith('ai_agent_repo_config:example-org/example-repo');
    expect(result).toEqual({
      excludedTools: ['tool-a'],
      approvalPolicy: {
        defaultMode: 'require_approval',
      },
      additiveRules: ['test'],
    });
  });
});
