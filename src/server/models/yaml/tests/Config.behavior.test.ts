/**
 * Copyright 2026 Lifecycle contributors
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

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
}));

import { EmptyFileError, ParsingError, YamlConfigParser } from 'server/lib/yamlConfigParser';
import { ValidationError, YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import Repository from '../../Repository';
import * as Config from '../Config';

const mockParseYamlConfigFromBranch = jest.spyOn(YamlConfigParser.prototype, 'parseYamlConfigFromBranch');
const mockValidate = jest.spyOn(YamlConfigValidator.prototype, 'validate');
const mockRepositoryQuery = jest.fn();
(Repository as any).query = (...args: unknown[]) => mockRepositoryQuery(...args);

function lifecycleConfig(overrides: Record<string, unknown> = {}): Config.LifecycleConfig {
  return {
    version: '1.0.0',
    environment: {},
    services: [{ name: 'api' }, { name: 'worker' }],
    ...overrides,
  } as any;
}

function repositoryQueryResult(repositories: unknown[]) {
  const catchQuery = jest.fn().mockResolvedValue(repositories);
  const where = jest.fn(() => ({ catch: catchQuery }));
  mockRepositoryQuery.mockReturnValue({ where });
  return { where, catchQuery };
}

describe('Lifecycle YAML configuration lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParseYamlConfigFromBranch.mockReset();
    mockValidate.mockReset();
    mockRepositoryQuery.mockReset();
  });

  it('resolves a repository case-insensitively and returns the first match', async () => {
    const first = { id: 1, fullName: 'GoodRx/Lifecycle' };
    const second = { id: 2, fullName: 'goodrx/lifecycle' };
    const { where } = repositoryQueryResult([first, second]);

    await expect(Config.resolveRepository('GOODRX/LIFECYCLE')).resolves.toBe(first);

    expect(where).toHaveBeenCalledWith(expect.anything(), '=', 'goodrx/lifecycle');
  });

  it.each([null, undefined])('does not query for a nullish repository name', async (repositoryName) => {
    await expect(Config.resolveRepository(repositoryName as any)).resolves.toBeUndefined();

    expect(mockRepositoryQuery).not.toHaveBeenCalled();
  });

  it('returns undefined when no repository matches', async () => {
    repositoryQueryResult([]);

    await expect(Config.resolveRepository('goodrx/missing')).resolves.toBeUndefined();
  });

  it('logs the query failure and propagates the resulting resolution failure', async () => {
    const queryFailure = new Error('database unavailable');
    const catchQuery = jest.fn(async (handler) => handler(queryFailure));
    const where = jest.fn(() => ({ catch: catchQuery }));
    mockRepositoryQuery.mockReturnValue({ where });

    await expect(Config.resolveRepository('goodrx/lifecycle')).rejects.toBeInstanceOf(TypeError);

    expect(mockLogger.error).toHaveBeenCalledWith({ error: queryFailure }, 'Repository: not found');
    expect(mockLogger.error).toHaveBeenCalledWith({ error: expect.any(TypeError) }, 'Repository: resolution failed');
  });

  it('propagates synchronous repository-query failures with lookup context', async () => {
    const failure = new Error('query construction failed');
    mockRepositoryQuery.mockImplementation(() => {
      throw failure;
    });

    await expect(Config.resolveRepository('goodrx/lifecycle')).rejects.toBe(failure);

    expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Repository: resolution failed');
  });

  it('resolves a repository and fetches its branch configuration', async () => {
    const repository = { id: 1, fullName: 'goodrx/lifecycle' };
    const config = lifecycleConfig();
    repositoryQueryResult([repository]);
    mockParseYamlConfigFromBranch.mockResolvedValue(config);

    await expect(Config.fetchLifecycleConfig('goodrx/lifecycle', 'main')).resolves.toBe(config);

    expect(mockParseYamlConfigFromBranch).toHaveBeenCalledWith('goodrx/lifecycle', 'main');
    expect(mockValidate).toHaveBeenCalledWith('1.0.0', config);
  });

  it.each([
    [null, 'main'],
    ['goodrx/lifecycle', null],
  ])('returns undefined without repository lookup for incomplete coordinates', async (repositoryName, branchName) => {
    await expect(Config.fetchLifecycleConfig(repositoryName as any, branchName as any)).resolves.toBeUndefined();

    expect(mockRepositoryQuery).not.toHaveBeenCalled();
  });

  it('returns undefined when the repository name is not onboarded', async () => {
    repositoryQueryResult([]);

    await expect(Config.fetchLifecycleConfig('goodrx/missing', 'main')).resolves.toBeUndefined();

    expect(mockParseYamlConfigFromBranch).not.toHaveBeenCalled();
  });
});

describe('fetchLifecycleConfigByRepository', () => {
  const repository = { fullName: 'goodrx/lifecycle' } as Repository;

  beforeEach(() => {
    jest.clearAllMocks();
    mockParseYamlConfigFromBranch.mockReset();
    mockValidate.mockReset();
  });

  it('parses and validates a repository branch', async () => {
    const config = lifecycleConfig();
    mockParseYamlConfigFromBranch.mockResolvedValue(config);

    await expect(Config.fetchLifecycleConfigByRepository(repository, 'feature/test')).resolves.toBe(config);

    expect(mockParseYamlConfigFromBranch).toHaveBeenCalledWith('goodrx/lifecycle', 'feature/test');
    expect(mockValidate).toHaveBeenCalledWith('1.0.0', config);
  });

  it('treats an empty YAML file as no configuration', async () => {
    const failure = new EmptyFileError('Config file is empty.');
    mockParseYamlConfigFromBranch.mockRejectedValue(failure);

    await expect(Config.fetchLifecycleConfigByRepository(repository, 'empty')).resolves.toBeNull();

    expect(mockLogger.warn).toHaveBeenCalledWith({ error: failure }, 'Config: fetch failed');
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it.each([
    ['parser syntax failure', new ParsingError('invalid YAML')],
    ['GitHub rate limit failure', new Error('API rate limit exceeded for installation')],
  ])('propagates a retryable %s', async (_label, failure) => {
    mockParseYamlConfigFromBranch.mockRejectedValue(failure);

    await expect(Config.fetchLifecycleConfigByRepository(repository, 'main')).rejects.toBe(failure);

    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('logs and treats an ordinary fetch error as missing configuration', async () => {
    const failure = new Error('branch does not exist');
    mockParseYamlConfigFromBranch.mockRejectedValue(failure);

    await expect(Config.fetchLifecycleConfigByRepository(repository, 'missing')).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith({ error: failure }, 'Config: fetch failed');
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('wraps validator failures in the YAML validation error contract', async () => {
    const config = lifecycleConfig();
    const failure = new Error('services must be an array');
    mockParseYamlConfigFromBranch.mockResolvedValue(config);
    mockValidate.mockImplementation(() => {
      throw failure;
    });

    await expect(Config.fetchLifecycleConfigByRepository(repository, 'main')).rejects.toBeInstanceOf(ValidationError);

    expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Config: validation failed');
  });

  it('returns undefined without parsing when the repository is absent', async () => {
    await expect(Config.fetchLifecycleConfigByRepository(null as any, 'main')).resolves.toBeUndefined();

    expect(mockParseYamlConfigFromBranch).not.toHaveBeenCalled();
    expect(mockValidate).not.toHaveBeenCalled();
  });
});

describe('getDeployingServicesByName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the first service whose name matches exactly', () => {
    const first = { name: 'api', image: 'first' };
    const duplicate = { name: 'api', image: 'second' };
    const config = lifecycleConfig({ services: [first, duplicate] });

    expect(Config.getDeployingServicesByName(config, 'api')).toBe(first);
  });

  it.each([
    [null, 'api'],
    [lifecycleConfig(), null],
    [lifecycleConfig({ services: null }), 'api'],
    [lifecycleConfig({ services: [] }), 'api'],
    [lifecycleConfig(), 'missing'],
  ])('returns undefined when lookup coordinates or services do not match', (config, serviceName) => {
    expect(Config.getDeployingServicesByName(config as any, serviceName as any)).toBeUndefined();
  });

  it('logs and propagates service collection access failures', () => {
    const failure = new Error('services unavailable');
    const config = lifecycleConfig();
    Object.defineProperty(config, 'services', {
      get() {
        throw failure;
      },
    });

    expect(() => Config.getDeployingServicesByName(config, 'api')).toThrow(failure);
    expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Service: lookup failed');
  });
});
