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

const mockFetchLifecycleConfigByRepository = jest.fn();
const mockResolveRepository = jest.fn();
const mockResolveExactEnvironmentService = jest.fn();
const mockWarn = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn() },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: mockWarn,
    debug: jest.fn(),
    fatal: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));
jest.mock('server/models', () => ({
  Build: class {},
  Deploy: class {},
  Environment: class {},
  Service: class {},
  PullRequest: class {},
  Repository: class {},
}));
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfigByRepository: (...args: unknown[]) => mockFetchLifecycleConfigByRepository(...args),
  resolveRepository: (...args: unknown[]) => mockResolveRepository(...args),
  resolveExactEnvironmentService: (...args: unknown[]) => mockResolveExactEnvironmentService(...args),
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(() => ({ getAllConfigs: jest.fn().mockResolvedValue({}) })) },
}));

import DeployableService from '../deployable';

const sourceRepository = { githubRepositoryId: 42, fullName: 'org/root' };

function makeService() {
  const db = { models: {}, services: { PullRequest: { updatePullRequestBranchName: jest.fn() } } };
  return new DeployableService(db as any, {} as any, {} as any, { registerQueue: jest.fn() } as any);
}

function makePullRequest(overrides: Record<string, unknown> = {}) {
  return {
    branchName: 'feature-branch',
    repository: sourceRepository,
    build: { deploys: [], environment: { id: 5 } },
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

afterEach(() => jest.clearAllMocks());

describe('deployable exact environment resolver parity', () => {
  it('keeps optional-before-default emission, active state, and one-level required-service attribution', async () => {
    const optionalReference = { name: 'optional-service' };
    const parentReference = { name: 'parent-service' };
    const optionalService = { name: 'optional-service' };
    const requiredService = { name: 'required-service' };
    const parentService = { name: 'parent-service', requires: [{ name: 'required-service' }] };
    const rootConfig = {
      environment: {
        optionalServices: [optionalReference],
        defaultServices: [parentReference],
      },
      services: [optionalService, requiredService, parentService],
    };
    mockFetchLifecycleConfigByRepository.mockResolvedValue(rootConfig);
    mockResolveExactEnvironmentService.mockImplementation((_config, reference) => {
      if (reference === optionalReference) {
        return { service: optionalService, requiredServices: [] };
      }
      return {
        service: parentService,
        requiredServices: [requiredService],
      };
    });

    const service = makeService();
    const emit = jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig').mockResolvedValue(undefined);
    const deployableServices = new Map();
    const pullRequest = makePullRequest();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      deployableServices,
      7,
      'build-uuid',
      pullRequest,
      pullRequest.build
    );

    expect(result).toBe(true);
    expect(mockResolveExactEnvironmentService).toHaveBeenNthCalledWith(1, rootConfig, optionalReference);
    expect(mockResolveExactEnvironmentService).toHaveBeenNthCalledWith(2, rootConfig, parentReference);
    expect(emit).toHaveBeenNthCalledWith(
      1,
      deployableServices,
      7,
      'build-uuid',
      optionalService,
      42,
      'feature-branch',
      false,
      null,
      pullRequest.build
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      deployableServices,
      7,
      'build-uuid',
      requiredService,
      42,
      'feature-branch',
      true,
      'parent-service',
      pullRequest.build
    );
    expect(emit).toHaveBeenNthCalledWith(
      3,
      deployableServices,
      7,
      'build-uuid',
      parentService,
      42,
      'feature-branch',
      true,
      null,
      pullRequest.build
    );
  });

  it('keeps remote repository resolution and comment branch precedence outside the resolver', async () => {
    const remoteReference = { name: 'remote-service', repository: 'org/remote', branch: 'configured-branch' };
    const remoteService = { name: 'remote-service' };
    const rootConfig = {
      environment: { optionalServices: [], defaultServices: [remoteReference] },
      services: [],
    };
    const remoteConfig = { environment: {}, services: [remoteService] };
    const remoteRepository = { githubRepositoryId: 84, fullName: 'org/remote' };
    const build = {
      deploys: [{ deployable: { name: 'remote-service', commentBranchName: 'comment-branch' } }],
      environment: { id: 5 },
    };
    const pullRequest = makePullRequest({ build });
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce(rootConfig).mockResolvedValueOnce(remoteConfig);
    mockResolveRepository.mockResolvedValue(remoteRepository);
    mockResolveExactEnvironmentService.mockReturnValue({
      service: remoteService,
      requiredServices: [],
    });

    const service = makeService();
    const emit = jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig').mockResolvedValue(undefined);
    const deployableServices = new Map();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      deployableServices,
      9,
      'remote-build',
      pullRequest,
      build
    );

    expect(result).toBe(true);
    expect(mockResolveRepository).toHaveBeenCalledWith('org/remote');
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenNthCalledWith(2, remoteRepository, 'comment-branch');
    expect(mockResolveExactEnvironmentService).toHaveBeenCalledWith(remoteConfig, remoteReference);
    expect(emit).toHaveBeenCalledWith(
      deployableServices,
      9,
      'remote-build',
      remoteService,
      84,
      'comment-branch',
      true,
      null,
      build
    );
  });

  it('keeps an exact-name miss as warn-and-drop without disabling reconciliation', async () => {
    const missingReference = { name: 'missing-service' };
    const rootConfig = {
      environment: { optionalServices: [], defaultServices: [missingReference] },
      services: [],
    };
    mockFetchLifecycleConfigByRepository.mockResolvedValue(rootConfig);
    mockResolveExactEnvironmentService.mockReturnValue(undefined);

    const service = makeService();
    const emit = jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig').mockResolvedValue(undefined);
    const pullRequest = makePullRequest();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      11,
      'missing-build',
      pullRequest,
      pullRequest.build
    );

    expect(result).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'Service cannot be found in yaml configuration. Is it referenced via the Lifecycle database?'
    );
  });
});
