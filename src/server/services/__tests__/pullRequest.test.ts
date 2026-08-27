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
  info: jest.fn(),
};
const mockGetPullRequest = jest.fn();
const mockGetPullRequestByRepositoryFullName = jest.fn();
const mockGetLabels = jest.fn();
const mockRegisterQueue = jest.fn();
const mockWithLogContext = jest.fn((_context, callback) => callback());

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn(() => 'redis-connection') },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
  withLogContext: (context: unknown, callback: () => unknown) => mockWithLogContext(context, callback),
  LogStage: {
    CLEANUP_STARTING: 'cleanup_starting',
    CLEANUP_COMPLETE: 'cleanup_complete',
    CLEANUP_FAILED: 'cleanup_failed',
  },
}));

jest.mock('server/lib/github', () => ({
  getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
  getPullRequestByRepositoryFullName: (...args: unknown[]) => mockGetPullRequestByRepositoryFullName(...args),
}));

jest.mock('../globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getLabels: (...args: unknown[]) => mockGetLabels(...args) })),
  },
}));

jest.mock('shared/config', () => ({
  QUEUE_NAMES: { CLEANUP: 'cleanup' },
}));

import { UniqueViolationError } from 'objection';
import PullRequestService, { type PullRequestOptions } from '../pullRequest';

const options: PullRequestOptions = {
  title: 'A useful change',
  status: 'open',
  deployOnUpdate: true,
  number: 17,
  fullName: 'goodrx/lifecycle',
  githubLogin: 'octocat',
  branch: 'feature/useful-change',
};

function pullRequestRecord(overrides: Record<string, unknown> = {}) {
  const patch = jest.fn().mockResolvedValue(1);
  return {
    id: 9,
    githubLogin: 'existing-user',
    deployOnUpdate: true,
    $query: jest.fn(() => ({ patch })),
    $setRelated: jest.fn(),
    ...overrides,
    patch,
  };
}

function createService({ findOne = jest.fn(), create = jest.fn(), cleanupBuilds = jest.fn() } = {}) {
  mockRegisterQueue.mockReturnValue({ add: jest.fn() });
  const db = {
    models: {
      PullRequest: { findOne, create },
    },
    services: {
      BuildService: { cleanupBuilds },
    },
  };
  const service = new PullRequestService(
    db as any,
    {} as any,
    {} as any,
    {
      registerQueue: mockRegisterQueue,
    } as any
  );
  return { service, findOne, create, cleanupBuilds };
}

describe('PullRequestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLabels.mockResolvedValue({ deploy: ['lifecycle-deploy!'] });
  });

  describe('findOrCreatePullRequest', () => {
    it('updates and relates an existing pull request without overwriting established opt-in fields', async () => {
      const pullRequest = pullRequestRecord();
      const findOne = jest.fn().mockResolvedValue(pullRequest);
      const { service, create } = createService({ findOne });
      const repository = { id: 4 };

      await expect(service.findOrCreatePullRequest(repository as any, 101, options)).resolves.toBe(pullRequest);

      expect(create).not.toHaveBeenCalled();
      expect(pullRequest.patch).toHaveBeenCalledWith({
        title: options.title,
        status: options.status,
        pullRequestNumber: options.number,
        fullName: options.fullName,
      });
      expect(pullRequest.$setRelated).toHaveBeenCalledWith('repository', repository);
    });

    it('creates a missing pull request and fills missing login and deploy-on-update state', async () => {
      const pullRequest = pullRequestRecord({ githubLogin: null, deployOnUpdate: false });
      const findOne = jest.fn().mockResolvedValueOnce(undefined);
      const create = jest.fn().mockResolvedValue(pullRequest);
      const { service } = createService({ findOne, create });
      const repository = { id: 4 };

      await service.findOrCreatePullRequest(repository as any, 101, options);

      expect(create).toHaveBeenCalledWith({
        githubPullRequestId: 101,
        repositoryId: 4,
        deployOnUpdate: true,
        githubLogin: 'octocat',
        branchName: 'feature/useful-change',
      });
      expect(pullRequest.patch).toHaveBeenCalledWith({
        title: options.title,
        status: 'open',
        pullRequestNumber: 17,
        fullName: 'goodrx/lifecycle',
        githubLogin: 'octocat',
        deployOnUpdate: true,
      });
    });

    it('recovers the winner of a concurrent create race', async () => {
      const pullRequest = pullRequestRecord();
      const findOne = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(pullRequest);
      const create = jest.fn().mockRejectedValue(Object.create(UniqueViolationError.prototype));
      const { service } = createService({ findOne, create });

      await expect(service.findOrCreatePullRequest({ id: 4 } as any, 101, options)).resolves.toBe(pullRequest);

      expect(findOne).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalledWith('PR: exists, fetching');
    });

    it('fails when a unique violation cannot be reconciled to a persisted pull request', async () => {
      const findOne = jest.fn().mockResolvedValue(undefined);
      const create = jest.fn().mockRejectedValue(Object.create(UniqueViolationError.prototype));
      const { service } = createService({ findOne, create });

      await expect(service.findOrCreatePullRequest({ id: 4 } as any, 101, options)).rejects.toThrow(
        'Failed to find pull request after unique violation for repo 4, PR 101'
      );
    });

    it('logs and propagates non-unique create failures', async () => {
      const failure = new Error('database unavailable');
      const findOne = jest.fn().mockResolvedValue(undefined);
      const create = jest.fn().mockRejectedValue(failure);
      const { service } = createService({ findOne, create });

      await expect(service.findOrCreatePullRequest({ id: 4 } as any, 101, options)).rejects.toBe(failure);
      expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'PR: create failed');
    });

    it('does not enable deploy-on-update for a closed pull request or copy an empty login', async () => {
      const pullRequest = pullRequestRecord({ githubLogin: null, deployOnUpdate: false });
      const { service } = createService({ findOne: jest.fn().mockResolvedValue(pullRequest) });

      await service.findOrCreatePullRequest({ id: 4 } as any, 101, {
        ...options,
        status: 'closed',
        githubLogin: '',
      });

      expect(pullRequest.patch).toHaveBeenCalledWith({
        title: options.title,
        status: 'closed',
        pullRequestNumber: 17,
        fullName: 'goodrx/lifecycle',
      });
    });
  });

  describe('lifecycleEnabledForPullRequest', () => {
    it('checks the configured deploy label against the pull request repository', async () => {
      const { service } = createService();
      const pullRequestHasLabelsAndState = jest.spyOn(service, 'pullRequestHasLabelsAndState').mockResolvedValue(false);
      const pullRequest = {
        pullRequestNumber: 17,
        fullName: 'goodrx/lifecycle',
        repository: { githubInstallationId: 22, fullName: 'goodrx/lifecycle' },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      await expect(service.lifecycleEnabledForPullRequest(pullRequest as any)).resolves.toBe(false);
      expect(pullRequest.$fetchGraph).toHaveBeenCalledWith('repository');
      expect(pullRequestHasLabelsAndState).toHaveBeenCalledWith(
        17,
        22,
        'goodrx',
        'lifecycle',
        ['lifecycle-deploy!'],
        'open'
      );
    });

    it('fails open and records an error when repository or configuration lookup fails', async () => {
      const { service } = createService();
      const failure = new Error('config unavailable');
      const pullRequest = {
        pullRequestNumber: 17,
        fullName: 'goodrx/lifecycle',
        $fetchGraph: jest.fn().mockRejectedValue(failure),
      };

      await expect(service.lifecycleEnabledForPullRequest(pullRequest as any)).resolves.toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: failure },
        'Failed to check lifecycle enabled for pull request'
      );
    });
  });

  describe('pullRequestHasLabelsAndState', () => {
    it.each([
      ['all labels and state match', ['deploy', 'ready'], 'open', ['deploy', 'ready'], 'open', true],
      ['a required label is absent', ['deploy'], 'open', ['deploy', 'ready'], 'open', false],
      ['the state differs', ['deploy'], 'closed', ['deploy'], 'open', false],
      ['no labels are required', [], 'open', [], 'open', true],
    ])('%s', async (_name, actualLabels, actualState, requiredLabels, requiredState, expected) => {
      mockGetPullRequest.mockResolvedValue({
        data: { labels: actualLabels.map((name) => ({ name })), state: actualState },
      });
      const { service } = createService();

      await expect(
        service.pullRequestHasLabelsAndState(17, 22, 'goodrx', 'lifecycle', requiredLabels, requiredState)
      ).resolves.toBe(expected);
      expect(mockGetPullRequest).toHaveBeenCalledWith('goodrx', 'lifecycle', 17, 22);
    });

    it('fails open when GitHub cannot be reached', async () => {
      const failure = new Error('github unavailable');
      mockGetPullRequest.mockRejectedValue(failure);
      const { service } = createService();

      await expect(
        service.pullRequestHasLabelsAndState(17, 22, 'goodrx', 'lifecycle', ['deploy'], 'open')
      ).resolves.toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: failure },
        'Failed to check pull request labels and state'
      );
    });
  });

  describe('processCleanupClosedPRs', () => {
    it('cleans closed builds under the queued correlation context', async () => {
      const { service, cleanupBuilds } = createService();

      await service.processCleanupClosedPRs({ data: { correlationId: 'corr-1' } } as any);

      expect(mockWithLogContext).toHaveBeenCalledWith({ correlationId: 'corr-1' }, expect.any(Function));
      expect(cleanupBuilds).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Cleanup: processing closed PRs');
      expect(mockLogger.info).toHaveBeenCalledWith('Cleanup: closed PRs completed');
    });

    it('uses a deterministic fallback context and swallows cleanup failures after logging', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1234);
      const failure = new Error('cleanup failed');
      const { service } = createService({ cleanupBuilds: jest.fn().mockRejectedValue(failure) });

      await expect(service.processCleanupClosedPRs({ data: undefined } as any)).resolves.toBeUndefined();
      expect(mockWithLogContext).toHaveBeenCalledWith({ correlationId: 'cleanup-1234' }, expect.any(Function));
      expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Cleanup: closed PRs processing failed');
      nowSpy.mockRestore();
    });
  });

  describe('updatePullRequestBranchName', () => {
    it('refreshes and persists the current GitHub head branch', async () => {
      mockGetPullRequestByRepositoryFullName.mockResolvedValue({ data: { head: { ref: 'feature/current' } } });
      const patch = jest.fn().mockResolvedValue(1);
      const pullRequest = {
        pullRequestNumber: 17,
        repository: { fullName: 'goodrx/lifecycle' },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({ patch })),
      };
      const { service } = createService();

      await expect(service.updatePullRequestBranchName(pullRequest as any)).resolves.toBe('feature/current');
      expect(patch).toHaveBeenCalledWith({ branchName: 'feature/current' });
    });

    it.each([
      ['the pull request is absent', null],
      ['GitHub has no head ref', { data: { head: {} } }],
    ])('returns no branch when %s', async (_name, githubResult) => {
      mockGetPullRequestByRepositoryFullName.mockResolvedValue(githubResult);
      const patch = jest.fn();
      const pullRequest =
        githubResult === null
          ? null
          : {
              pullRequestNumber: 17,
              repository: { fullName: 'goodrx/lifecycle' },
              $fetchGraph: jest.fn().mockResolvedValue(undefined),
              $query: jest.fn(() => ({ patch })),
            };
      const { service } = createService();

      await expect(service.updatePullRequestBranchName(pullRequest as any)).resolves.toBeUndefined();
      expect(patch).not.toHaveBeenCalled();
    });

    it('logs GitHub lookup failures and leaves the stored branch unchanged', async () => {
      const failure = new Error('github unavailable');
      mockGetPullRequestByRepositoryFullName.mockRejectedValue(failure);
      const patch = jest.fn();
      const pullRequest = {
        pullRequestNumber: 17,
        repository: { fullName: 'goodrx/lifecycle' },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({ patch })),
      };
      const { service } = createService();

      await expect(service.updatePullRequestBranchName(pullRequest as any)).resolves.toBeUndefined();
      expect(patch).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: failure },
        'Failed to get pull request by repository full name'
      );
    });
  });
});
