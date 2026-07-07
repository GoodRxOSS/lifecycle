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

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn() },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  withLogContext: jest.fn((_ctx: unknown, fn: () => unknown) => fn()),
  updateLogContext: jest.fn(),
  LogStage: {},
}));
jest.mock('server/lib/buildSource', () => {
  const actual = jest.requireActual('server/lib/buildSource');
  return { ...actual, resolveBuildSourceRepository: jest.fn() };
});
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfigByRepository: jest.fn(),
}));

import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import WebhookService from 'server/services/webhook';
import { resolveBuildSourceRepository } from 'server/lib/buildSource';
import { fetchLifecycleConfigByRepository } from 'server/models/yaml';

const mockResolveBuildSourceRepository = resolveBuildSourceRepository as jest.Mock;
const mockFetchLifecycleConfigByRepository = fetchLifecycleConfigByRepository as jest.Mock;

afterEach(() => jest.clearAllMocks());

describe('envVariables repoName fallback for PR-less builds', () => {
  it('resolves repoName from the build source repository when there is no pull request', async () => {
    mockResolveBuildSourceRepository.mockResolvedValue({ fullName: 'org/repo' });

    const service = new BuildEnvironmentVariables({} as any);
    const captured: any = {};
    jest.spyOn(service, 'buildEnvironmentVariableDictionary').mockImplementation(async (...args: any[]) => {
      captured.templateVars = args[2];
      return {};
    });

    const build: any = {
      uuid: 'api-env-222222',
      namespace: 'env-api-env-222222',
      sha: 'abc',
      deploys: [],
      pullRequest: null,
      branchName: 'main',
      githubRepositoryId: 42,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await service.availableEnvironmentVariablesForBuild(build);

    expect(mockResolveBuildSourceRepository).toHaveBeenCalledWith(build);
    expect(captured.templateVars).toMatchObject({
      repoName: 'org/repo',
      branchName: 'main',
      pullRequestNumber: undefined,
    });
  });
});

describe('webhook yaml source resolution for PR-less builds', () => {
  it('imports webhooks from the build source repository + branch when there is no PR', async () => {
    const repository = { fullName: 'org/repo' };
    mockResolveBuildSourceRepository.mockResolvedValue(repository);
    mockFetchLifecycleConfigByRepository.mockResolvedValue({
      environment: { webhooks: [{ name: 'w', type: 'command', state: 'deployed' }] },
    });

    const patch = jest.fn().mockResolvedValue(undefined);
    const service = new WebhookService(
      {} as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn() })) } as any
    );
    const build: any = {
      uuid: 'api-env-222222',
      branchName: 'main',
      githubRepositoryId: 42,
      environment: { id: 5 },
      $query: jest.fn(() => ({ patch })),
    };

    const webhooks = await service.upsertWebhooksWithYaml(build, null);

    expect(mockResolveBuildSourceRepository).toHaveBeenCalledWith(build);
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'main');
    expect(webhooks).toHaveLength(1);
    expect(patch).toHaveBeenCalledWith({ webhooksYaml: JSON.stringify(webhooks) });
  });

  it('imports webhook configuration from the immutable API source ref', async () => {
    const repository = { fullName: 'org/repo' };
    mockResolveBuildSourceRepository.mockResolvedValue(repository);
    mockFetchLifecycleConfigByRepository.mockResolvedValue({ environment: { webhooks: [] } });
    const service = new WebhookService(
      {} as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn() })) } as any
    );
    const build: any = {
      uuid: 'api-env-222222',
      triggerType: 'api',
      branchName: 'main',
      configSha: 'create-sha',
      environment: { id: 5 },
      $query: jest.fn(() => ({ patch: jest.fn() })),
    };

    await service.upsertWebhooksWithYaml(build, null, 'push-sha');

    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'push-sha');
  });
});
