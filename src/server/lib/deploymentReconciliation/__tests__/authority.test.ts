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

import { BuildStatus, PullRequestStatus } from 'shared/constants';
import {
  environmentBlockReason,
  isDeployAuthorityCurrent,
  isDeployOwnedByRun,
  isEnvironmentUnblocked,
  isIntentRunCurrent,
  loadEnvironmentAuthority,
} from '../authority';

function buildQuery(row: any) {
  const query: any = {
    findById: jest.fn(() => query),
    select: jest.fn().mockResolvedValue(row),
  };
  return query;
}

function deployQuery(row: any) {
  const query: any = {
    findOne: jest.fn(() => query),
    select: jest.fn().mockResolvedValue(row),
  };
  return query;
}

function models(build: any, deploy?: any) {
  const buildRead = buildQuery(build);
  const deployRead = deployQuery(deploy);
  return {
    models: { Build: { query: jest.fn(() => buildRead) }, Deploy: { query: jest.fn(() => deployRead) } } as any,
    buildRead,
    deployRead,
  };
}

const openPullRequest = { status: PullRequestStatus.OPEN, deployOnUpdate: true };

describe('environmentBlockReason', () => {
  it('blocks a missing or deleted build', () => {
    expect(environmentBlockReason(null)).toBe('build_missing');
    expect(environmentBlockReason({ deletedAt: new Date() } as any)).toBe('build_deleted');
  });

  it('follows the pull request for a PR environment', () => {
    expect(environmentBlockReason({ pullRequestId: 1, status: BuildStatus.TEARING_DOWN } as any)).toBe('tearing_down');
    expect(environmentBlockReason({ pullRequestId: 1, status: BuildStatus.DEPLOYED } as any)).toBe(
      'pull_request_missing'
    );
    expect(environmentBlockReason({ pullRequestId: 1, pullRequest: { status: PullRequestStatus.CLOSED } } as any)).toBe(
      'pull_request_closed'
    );
    expect(
      environmentBlockReason({
        pullRequestId: 1,
        pullRequest: { status: PullRequestStatus.OPEN, deployOnUpdate: false },
      } as any)
    ).toBe('deploy_disabled');
    expect(environmentBlockReason({ pullRequestId: 1, pullRequest: openPullRequest } as any)).toBeNull();
    expect(
      environmentBlockReason({ pullRequestId: 1, pullRequest: openPullRequest, status: BuildStatus.TORN_DOWN } as any)
    ).toBeNull();
  });

  it('follows the kill switch and teardown states for a PR-less environment', () => {
    expect(environmentBlockReason({ status: BuildStatus.TEARING_DOWN, deployEnabled: true } as any)).toBe('torn_down');
    expect(environmentBlockReason({ status: BuildStatus.TORN_DOWN, deployEnabled: true } as any)).toBe('torn_down');
    expect(environmentBlockReason({ status: BuildStatus.DEPLOYED, deployEnabled: false } as any)).toBe(
      'deploy_disabled'
    );
    expect(environmentBlockReason({ status: BuildStatus.DEPLOYED, deployEnabled: true } as any)).toBeNull();
  });
});

describe('loadEnvironmentAuthority and isEnvironmentUnblocked', () => {
  it('loads the pull request graph only for PR environments', async () => {
    const fetchGraph = jest.fn().mockResolvedValue(undefined);
    const build = { id: 4, pullRequestId: 9, $fetchGraph: fetchGraph };
    const prLess = { id: 5, pullRequestId: null, deployEnabled: true, $fetchGraph: jest.fn() };

    await expect(loadEnvironmentAuthority(models(build).models, 4)).resolves.toBe(build);
    expect(fetchGraph).toHaveBeenCalledWith('pullRequest');
    await expect(loadEnvironmentAuthority(models(prLess).models, 5)).resolves.toBe(prLess);
    expect(prLess.$fetchGraph).not.toHaveBeenCalled();
    await expect(loadEnvironmentAuthority(models(undefined).models, 6)).resolves.toBeNull();
  });

  it('reports whether the environment may run deployment work', async () => {
    await expect(
      isEnvironmentUnblocked(models({ id: 4, status: BuildStatus.DEPLOYED, deployEnabled: true }).models, 4)
    ).resolves.toBe(true);
    await expect(
      isEnvironmentUnblocked(models({ id: 4, status: BuildStatus.TORN_DOWN, deployEnabled: true }).models, 4)
    ).resolves.toBe(false);
    await expect(isEnvironmentUnblocked(models(undefined).models, 4)).resolves.toBe(false);
  });
});

describe('isDeployOwnedByRun', () => {
  it('requires the row to carry the run token and, when fenced, the generation', async () => {
    const { models: m, deployRead } = models(undefined, { id: 7, observedGeneration: 1 });

    await expect(isDeployOwnedByRun(m, 7, 'run-a', 3)).resolves.toBe(true);
    expect(deployRead.findOne).toHaveBeenCalledWith({ id: 7, runUUID: 'run-a', desiredGeneration: 3 });
    expect(deployRead.select).toHaveBeenCalledWith('id', 'observedGeneration');

    await expect(isDeployOwnedByRun(m, 7, 'run-a')).resolves.toBe(true);
    expect(deployRead.findOne).toHaveBeenLastCalledWith({ id: 7, runUUID: 'run-a' });
  });

  it('treats an observed row as finished work and a missing row as not owned', async () => {
    await expect(
      isDeployOwnedByRun(models(undefined, { id: 7, observedGeneration: 3 }).models, 7, 'run-a', 3)
    ).resolves.toBe(false);
    await expect(
      isDeployOwnedByRun(models(undefined, { id: 7, observedGeneration: '3' }).models, 7, 'run-a', 3)
    ).resolves.toBe(false);
    await expect(
      isDeployOwnedByRun(models(undefined, { id: 7, observedGeneration: 3 }).models, 7, 'run-a')
    ).resolves.toBe(true);
    await expect(isDeployOwnedByRun(models(undefined, { id: 7 }).models, 7, 'run-a', 3)).resolves.toBe(true);
    await expect(isDeployOwnedByRun(models(undefined, undefined).models, 7, 'run-a', 3)).resolves.toBe(false);
  });
});

describe('isDeployAuthorityCurrent', () => {
  const deploy = { id: 7, buildId: 4 } as any;

  it('is false when the run no longer owns the row', async () => {
    await expect(isDeployAuthorityCurrent(models(undefined, undefined).models, deploy, 'run-a', 3)).resolves.toBe(
      false
    );
  });

  it('checks the environment only for fenced runs', async () => {
    const blocked = models(
      { id: 4, status: BuildStatus.TORN_DOWN, deployEnabled: true },
      { id: 7, observedGeneration: 1 }
    );
    await expect(isDeployAuthorityCurrent(blocked.models, deploy, 'run-a')).resolves.toBe(true);
    expect(blocked.models.Build.query).not.toHaveBeenCalled();
    await expect(isDeployAuthorityCurrent(blocked.models, deploy, 'run-a', 3)).resolves.toBe(false);

    const open = models({ id: 4, status: BuildStatus.DEPLOYED, deployEnabled: true }, { id: 7, observedGeneration: 1 });
    await expect(isDeployAuthorityCurrent(open.models, deploy, 'run-a', 3)).resolves.toBe(true);
  });
});

describe('isIntentRunCurrent', () => {
  it('needs an owned row at the generation and an unblocked environment', async () => {
    const none = models({ id: 4, status: BuildStatus.DEPLOYED, deployEnabled: true }, undefined);
    await expect(isIntentRunCurrent(none.models, 4, 'run-a', 3)).resolves.toBe(false);
    expect(none.deployRead.findOne).toHaveBeenCalledWith({ buildId: 4, runUUID: 'run-a', desiredGeneration: 3 });

    const owned = models({ id: 4, status: BuildStatus.DEPLOYED, deployEnabled: true }, { id: 7 });
    await expect(isIntentRunCurrent(owned.models, 4, 'run-a', 3)).resolves.toBe(true);

    const blocked = models({ id: 4, status: BuildStatus.TORN_DOWN, deployEnabled: true }, { id: 7 });
    await expect(isIntentRunCurrent(blocked.models, 4, 'run-a', 3)).resolves.toBe(false);
  });
});
