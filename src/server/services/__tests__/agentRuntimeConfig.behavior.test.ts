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

const mockGetGlobalConfig = jest.fn();
const mockSetGlobalConfig = jest.fn();
const mockValidateAgentRuntimeConfig = jest.fn();
const mockValidateAgentRuntimeRepoOverride = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGetGlobalConfig(...args),
      setConfig: (...args: unknown[]) => mockSetGlobalConfig(...args),
    })),
  },
}));

jest.mock('server/lib/validation/agentRuntimeConfigValidator', () => ({
  validateAgentRuntimeConfig: (...args: unknown[]) => mockValidateAgentRuntimeConfig(...args),
  validateAgentRuntimeRepoOverride: (...args: unknown[]) => mockValidateAgentRuntimeRepoOverride(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ info: mockLoggerInfo, warn: mockLoggerWarn })),
}));

import { AgentRuntimeConfigService } from 'server/services/agentRuntime/config/agentRuntimeConfig';

const globalDefaults = {
  enabled: true,
  providers: [],
  maxMessagesPerSession: 50,
  sessionTTL: 3600,
  excludedTools: ['global-tool'],
  excludedFilePatterns: ['global/**'],
  allowedWritePatterns: ['lifecycle.yml'],
  approvalPolicy: {
    defaultMode: 'require_approval',
    rules: { shell_exec: 'deny' },
  },
  capabilityPolicy: {
    availability: { workspace_shell: 'admin_only' },
  },
} as any;

function makeService(knexImpl?: jest.Mock) {
  const knex = Object.assign(knexImpl || jest.fn(), {
    fn: { now: jest.fn(() => 'database-now') },
  });
  const db = { knex } as any;
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  } as any;
  return {
    service: new AgentRuntimeConfigService(db, redis, {} as any, {} as any),
    knex,
    redis,
  };
}

function repoLookup(row: unknown) {
  const query = {
    where: jest.fn(),
    whereNull: jest.fn(),
    first: jest.fn().mockResolvedValue(row),
  };
  query.where.mockReturnValue(query);
  query.whereNull.mockReturnValue(query);
  return query;
}

function repoUpsert() {
  const query = {
    insert: jest.fn(),
    onConflict: jest.fn(),
    merge: jest.fn().mockResolvedValue(undefined),
  };
  query.insert.mockReturnValue(query);
  query.onConflict.mockReturnValue(query);
  return query;
}

describe('AgentRuntimeConfigService behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGlobalConfig.mockResolvedValue(globalDefaults);
    mockSetGlobalConfig.mockResolvedValue(undefined);
  });

  it('returns one process singleton instance', () => {
    (AgentRuntimeConfigService as any).instance = undefined;

    const first = AgentRuntimeConfigService.getInstance();
    const second = AgentRuntimeConfigService.getInstance();

    expect(second).toBe(first);
    (AgentRuntimeConfigService as any).instance = undefined;
  });

  it('returns and memory-caches global defaults when no repository is requested', async () => {
    const { service, redis, knex } = makeService();

    await expect(service.getEffectiveConfig()).resolves.toBe(globalDefaults);
    await expect(service.getEffectiveConfig()).resolves.toBe(globalDefaults);

    expect(mockGetGlobalConfig).toHaveBeenCalledTimes(1);
    expect(redis.get).not.toHaveBeenCalled();
    expect(knex).not.toHaveBeenCalled();
  });

  it('merges and memory-caches a Redis repository override', async () => {
    const { service, redis, knex } = makeService();
    redis.get.mockResolvedValue(
      JSON.stringify({
        enabled: false,
        maxMessagesPerSession: 80,
        sessionTTL: 7200,
        excludedTools: ['global-tool', 'repo-tool'],
        excludedFilePatterns: ['repo/**'],
        allowedWritePatterns: ['README.md'],
        approvalPolicy: { rules: { write_file: 'allow' } },
        capabilityPolicy: { availability: { workspace_shell: 'all_users' } },
      })
    );

    const first = await service.getEffectiveConfig('Example/Repository');
    const second = await service.getEffectiveConfig('EXAMPLE/REPOSITORY');

    expect(first).toMatchObject({
      enabled: false,
      maxMessagesPerSession: 80,
      sessionTTL: 7200,
      excludedTools: ['global-tool', 'repo-tool'],
      excludedFilePatterns: ['global/**', 'repo/**'],
      allowedWritePatterns: ['lifecycle.yml', 'README.md'],
      approvalPolicy: {
        defaultMode: 'require_approval',
        rules: { shell_exec: 'deny', write_file: 'allow' },
      },
      capabilityPolicy: { availability: { workspace_shell: 'all_users' } },
    });
    expect(second).toBe(first);
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledWith('agent_runtime_repo_config:example/repository');
    expect(knex).not.toHaveBeenCalled();
  });

  it.each([
    ['a serialized database config', JSON.stringify({ enabled: false }), false],
    ['an object database config', { maxMessagesPerSession: 75 }, true],
  ])('loads and Redis-caches %s', async (_label, storedConfig, expectedEnabled) => {
    const lookup = repoLookup({ config: storedConfig });
    const { service, knex, redis } = makeService(jest.fn(() => lookup));

    const result = await service.getEffectiveConfig('Example/Repository');

    expect(result.enabled).toBe(expectedEnabled);
    if (typeof storedConfig !== 'string') {
      expect(result.maxMessagesPerSession).toBe(75);
    }
    expect(knex).toHaveBeenCalledWith('agent_runtime_repo_config');
    expect(redis.set).toHaveBeenCalledWith(
      'agent_runtime_repo_config:example/repository',
      JSON.stringify(typeof storedConfig === 'string' ? JSON.parse(storedConfig) : storedConfig),
      'EX',
      300
    );
  });

  it('falls back to global defaults when no repository row exists', async () => {
    const { service } = makeService(jest.fn(() => repoLookup(null)));

    await expect(service.getEffectiveConfig('missing/repository')).resolves.toBe(globalDefaults);
  });

  it('falls back to global defaults and warns when repository lookup fails', async () => {
    const { service, redis } = makeService();
    redis.get.mockRejectedValue(new Error('Redis unavailable'));

    await expect(service.getEffectiveConfig('Example/Repository')).resolves.toBe(globalDefaults);

    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('repo config lookup failed'));
  });

  it('preserves explicit undefined policy results when neither layer defines policies', async () => {
    mockGetGlobalConfig.mockResolvedValue({
      enabled: true,
      providers: [],
      maxMessagesPerSession: 50,
      sessionTTL: 3600,
    });
    const { service, redis } = makeService();
    redis.get.mockResolvedValue('{}');

    const result = await service.getEffectiveConfig('Example/Repository');

    expect(result).toHaveProperty('approvalPolicy', undefined);
    expect(result).toHaveProperty('capabilityPolicy', undefined);
  });

  it('returns the built-in safe default when global runtime config is absent', async () => {
    mockGetGlobalConfig.mockResolvedValue(null);
    const { service } = makeService();

    await expect(service.getGlobalConfig()).resolves.toEqual({
      enabled: false,
      providers: [],
      maxMessagesPerSession: 50,
      sessionTTL: 3600,
      allowedWritePatterns: ['lifecycle.yaml', 'lifecycle.yml'],
    });
  });

  it('returns a configured global runtime config unchanged', async () => {
    const { service } = makeService();
    await expect(service.getGlobalConfig()).resolves.toBe(globalDefaults);
  });

  it('validates, stores, and announces a complete global config replacement', async () => {
    const { service } = makeService();

    await service.setGlobalConfig(globalDefaults);

    expect(mockValidateAgentRuntimeConfig).toHaveBeenCalledWith(globalDefaults);
    expect(mockSetGlobalConfig).toHaveBeenCalledWith('agentRuntime', globalDefaults);
    expect(mockLoggerInfo).toHaveBeenCalledWith('AgentRuntimeConfig: global config updated via=api');
  });

  it('normalizes custom-agent allowlists and capability availability', async () => {
    const { service } = makeService();

    const result = await service.updateGlobalCustomAgentCreationPolicy({
      mode: 'allowlist',
      allowedUserIds: [' user-1 ', 'user-1', ''],
      allowedGithubUsernames: [' ExampleUser ', 'exampleuser', ''],
      capabilityAvailability: { workspace_shell: 'admin_only' },
    } as any);

    expect(result.customAgentCreationPolicy).toEqual({
      mode: 'allowlist',
      allowedUserIds: ['user-1'],
      allowedGithubUsernames: ['exampleuser'],
      capabilityAvailability: { workspace_shell: 'admin_only' },
    });
  });

  it('removes an existing custom-agent policy for an empty replacement', async () => {
    mockGetGlobalConfig.mockResolvedValue({ ...globalDefaults, customAgentCreationPolicy: { mode: 'disabled' } });
    const { service } = makeService();

    const result = await service.updateGlobalCustomAgentCreationPolicy({} as any);

    expect(result).not.toHaveProperty('customAgentCreationPolicy');
  });

  it('lists repository configs and parses only serialized rows', async () => {
    const rows = [
      {
        id: 1,
        repositoryFullName: 'a/repo',
        config: JSON.stringify({ enabled: false }),
        createdAt: 'created-1',
        updatedAt: 'updated-1',
      },
      {
        id: 2,
        repositoryFullName: 'b/repo',
        config: { sessionTTL: 900 },
        createdAt: 'created-2',
        updatedAt: 'updated-2',
      },
    ];
    const query = { whereNull: jest.fn(), orderBy: jest.fn().mockResolvedValue(rows) };
    query.whereNull.mockReturnValue(query);
    const { service } = makeService(jest.fn(() => query));

    await expect(service.listRepoConfigs()).resolves.toEqual([
      expect.objectContaining({ id: 1, config: { enabled: false } }),
      expect.objectContaining({ id: 2, config: { sessionTTL: 900 } }),
    ]);
  });

  it.each([
    ['a missing row', null, null],
    ['a serialized override', { config: JSON.stringify({ enabled: false }) }, { enabled: false }],
    ['an object override', { config: { sessionTTL: 900 } }, { sessionTTL: 900 }],
  ])('returns %s from repository config lookup', async (_label, row, expected) => {
    const lookup = repoLookup(row);
    const { service } = makeService(jest.fn(() => lookup));

    await expect(service.getRepoConfig('Example/Repository')).resolves.toEqual(expected);

    expect(lookup.where).toHaveBeenCalledWith({ repositoryFullName: 'example/repository' });
  });

  it('validates and upserts a normalized repository override', async () => {
    const upsert = repoUpsert();
    const { service, redis } = makeService(jest.fn(() => upsert));
    const config = { enabled: false, excludedTools: ['write_file'] };

    await service.setRepoConfig('Example/Repository', config);

    expect(mockValidateAgentRuntimeRepoOverride).toHaveBeenCalledWith(config);
    expect(upsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'example/repository',
        config: JSON.stringify(config),
      })
    );
    expect(upsert.onConflict).toHaveBeenCalledWith('repositoryFullName');
    expect(upsert.merge).toHaveBeenCalledWith(
      expect.objectContaining({ config: JSON.stringify(config), deletedAt: null })
    );
    expect(redis.del).toHaveBeenCalledWith('agent_runtime_repo_config:example/repository');
  });

  it('removes an empty repository capability replacement while preserving other overrides', async () => {
    const upsert = repoUpsert();
    const { service } = makeService(jest.fn(() => upsert));
    jest.spyOn(service, 'getRepoConfig').mockResolvedValue({
      enabled: false,
      capabilityPolicy: { availability: { workspace_shell: 'disabled' } },
    });

    const result = await service.updateRepoCapabilityPolicy('Example/Repository', {});

    expect(result).toEqual({ enabled: false });
    expect(upsert.insert).toHaveBeenCalledWith(expect.objectContaining({ config: JSON.stringify({ enabled: false }) }));
  });

  it('soft-deletes a normalized repository row and evicts Redis', async () => {
    const query = { where: jest.fn(), update: jest.fn().mockResolvedValue(1) };
    query.where.mockReturnValue(query);
    const { service, redis } = makeService(jest.fn(() => query));

    await service.deleteRepoConfig('Example/Repository');

    expect(query.where).toHaveBeenCalledWith({ repositoryFullName: 'example/repository' });
    expect(query.update).toHaveBeenCalledWith({ deletedAt: 'database-now' });
    expect(redis.del).toHaveBeenCalledWith('agent_runtime_repo_config:example/repository');
  });

  it('clears one repository cache or all in-memory caches', async () => {
    const { service, redis } = makeService();
    redis.get.mockResolvedValue(JSON.stringify({ enabled: false }));
    await service.getEffectiveConfig('Example/Repository');

    service.clearCache('Example/Repository');
    expect(redis.del).toHaveBeenCalledWith('agent_runtime_repo_config:example/repository');
    await service.getEffectiveConfig('Example/Repository');
    expect(redis.get).toHaveBeenCalledTimes(2);

    service.clearCache();
    await service.getEffectiveConfig();
    expect(mockGetGlobalConfig).toHaveBeenCalledTimes(2);
  });
});
