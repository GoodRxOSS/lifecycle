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

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    transact: jest.fn(),
  },
}));

import Build from 'server/models/Build';
import {
  acceptDeploymentIntent,
  AcceptedDeploymentRefs,
  deploymentIntentScopeKey,
  dirtyDeploymentIntents,
} from '../mailbox';

const TRX = { transaction: true } as any;

function readQuery(row: any) {
  const query: any = {
    select: jest.fn().mockReturnThis(),
    findById: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockResolvedValue(row),
  };
  return query;
}

function writeQuery() {
  const query: any = {
    findById: jest.fn().mockReturnThis(),
    patch: jest.fn().mockResolvedValue(1),
  };
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  (Build.transact as jest.Mock).mockImplementation(async (callback: any) => callback(TRX));
});

describe('deployment intent scope keys', () => {
  it('uses stable, non-overlapping keys for source, repository, and whole-environment work', () => {
    expect(
      deploymentIntentScopeKey({
        type: 'source',
        requestId: 'request-source',
        target: 'repository',
        githubRepositoryId: 123,
        branch: 'Feature/A B',
        sha: 'abc',
      })
    ).toBe('source:123:Feature%2FA%20B');
    expect(
      deploymentIntentScopeKey({ type: 'repository', requestId: 'request-repository', githubRepositoryId: 123 })
    ).toBe('repository:123');
    expect(deploymentIntentScopeKey({ type: 'all', requestId: 'request-all' })).toBe('all');
  });
});

describe('acceptDeploymentIntent', () => {
  it('coalesces A/B/C for one source to only C while retaining monotonic authority', async () => {
    const row: any = { desiredGeneration: 0, acceptedRefs: {}, runUUID: 'teardown-owner' };
    const query: any = {
      select: jest.fn().mockReturnThis(),
      findById: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn(async () => row),
      patch: jest.fn(async (patch: any) => {
        Object.assign(row, patch);
        return 1;
      }),
    };
    (Build.query as jest.Mock).mockImplementation(() => query);

    for (const [requestId, sha] of [
      ['request-a', 'sha-a'],
      ['request-b', 'sha-b'],
      ['request-c', 'sha-c'],
    ]) {
      await acceptDeploymentIntent(42, {
        type: 'source',
        requestId,
        target: 'repository',
        githubRepositoryId: 123,
        branch: 'main',
        sha,
      });
    }

    expect(row.desiredGeneration).toBe(3);
    expect(row.runUUID).toBe('teardown-owner');
    expect(row.acceptedRefs).toEqual({
      'source:123:main': {
        type: 'source',
        requestId: 'request-c',
        target: 'repository',
        githubRepositoryId: 123,
        branch: 'main',
        sha: 'sha-c',
        gen: 3,
      },
    });
  });

  it('locks the Build row, increments its generation, and preserves other scopes', async () => {
    const existing: AcceptedDeploymentRefs = {
      'repository:9': { type: 'repository', requestId: 'request-2', githubRepositoryId: 9, gen: 2 },
    };
    const read = readQuery({ desiredGeneration: '2', acceptedRefs: existing });
    const write = writeQuery();
    (Build.query as jest.Mock).mockReturnValueOnce(read).mockReturnValueOnce(write);

    const result = await acceptDeploymentIntent(42, {
      type: 'source',
      requestId: 'request-3',
      target: 'repository',
      githubRepositoryId: 123,
      branch: 'main',
      sha: 'commit-c',
    });

    expect(result).toEqual({ accepted: true, generation: 3, scopeKey: 'source:123:main' });
    expect(read.select).toHaveBeenCalledWith('id', 'desiredGeneration', 'acceptedRefs');
    expect(read.findById).toHaveBeenCalledWith(42);
    expect(read.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(read.forUpdate).toHaveBeenCalledTimes(1);
    expect(write.patch).toHaveBeenCalledWith({
      desiredGeneration: 3,
      acceptedRefs: {
        ...existing,
        'source:123:main': {
          type: 'source',
          requestId: 'request-3',
          target: 'repository',
          githubRepositoryId: 123,
          branch: 'main',
          sha: 'commit-c',
          gen: 3,
        },
      },
    });
  });

  it('does not bump for a redelivery of the same source SHA', async () => {
    const read = readQuery({
      desiredGeneration: 7,
      acceptedRefs: {
        'source:123:main': {
          type: 'source',
          requestId: 'request-7',
          target: 'repository',
          githubRepositoryId: 123,
          branch: 'main',
          sha: 'same-sha',
          gen: 7,
        },
      },
    });
    (Build.query as jest.Mock).mockReturnValueOnce(read);

    await expect(
      acceptDeploymentIntent(42, {
        type: 'source',
        requestId: 'request-redelivery',
        target: 'repository',
        githubRepositoryId: 123,
        branch: 'main',
        sha: 'same-sha',
      })
    ).resolves.toEqual({ accepted: false, generation: 7, scopeKey: 'source:123:main' });
    expect(Build.query).toHaveBeenCalledTimes(1);
  });

  it('does not let a delayed predecessor push replace the newer accepted push', async () => {
    const read = readQuery({
      desiredGeneration: 8,
      acceptedRefs: {
        'source:123:main': {
          type: 'source',
          requestId: 'request-c',
          target: 'repository',
          githubRepositoryId: 123,
          branch: 'main',
          sha: 'commit-c',
          beforeSha: 'commit-b',
          gen: 8,
        },
      },
    });
    (Build.query as jest.Mock).mockReturnValueOnce(read);

    await expect(
      acceptDeploymentIntent(42, {
        type: 'source',
        requestId: 'request-delayed-b',
        target: 'repository',
        githubRepositoryId: 123,
        branch: 'main',
        sha: 'commit-b',
        beforeSha: 'commit-a',
      })
    ).resolves.toEqual({ accepted: false, generation: 8, scopeKey: 'source:123:main' });
    expect(Build.query).toHaveBeenCalledTimes(1);
  });

  it('accepts an intentional rollback to the previous SHA', async () => {
    const read = readQuery({
      desiredGeneration: 8,
      acceptedRefs: {
        'source:123:main': {
          type: 'source',
          requestId: 'request-c',
          target: 'repository',
          githubRepositoryId: 123,
          branch: 'main',
          sha: 'commit-c',
          beforeSha: 'commit-b',
          gen: 8,
        },
      },
    });
    const write = writeQuery();
    (Build.query as jest.Mock).mockReturnValueOnce(read).mockReturnValueOnce(write);

    await expect(
      acceptDeploymentIntent(42, {
        type: 'source',
        requestId: 'request-rollback-b',
        target: 'repository',
        githubRepositoryId: 123,
        branch: 'main',
        sha: 'commit-b',
        beforeSha: 'commit-c',
      })
    ).resolves.toEqual({ accepted: true, generation: 9, scopeKey: 'source:123:main' });
    expect(write.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredGeneration: 9,
        acceptedRefs: expect.objectContaining({
          'source:123:main': expect.objectContaining({ sha: 'commit-b', beforeSha: 'commit-c', gen: 9 }),
        }),
      })
    );
  });

  it('does not bump when legacy queues redeliver the same explicit request', async () => {
    const read = readQuery({
      desiredGeneration: 7,
      acceptedRefs: {
        'repository:123': { type: 'repository', requestId: 'request-7', githubRepositoryId: 123, gen: 7 },
      },
    });
    (Build.query as jest.Mock).mockReturnValueOnce(read);

    await expect(
      acceptDeploymentIntent(42, {
        type: 'repository',
        requestId: 'request-7',
        githubRepositoryId: 123,
      })
    ).resolves.toEqual({ accepted: false, generation: 7, scopeKey: 'repository:123' });
    expect(Build.query).toHaveBeenCalledTimes(1);
  });

  it('always bumps an explicit repository redeploy and replaces only its key', async () => {
    const read = readQuery({
      desiredGeneration: 5,
      acceptedRefs: {
        'repository:123': { type: 'repository', requestId: 'request-4', githubRepositoryId: 123, gen: 4 },
        'source:456:main': {
          type: 'source',
          requestId: 'request-5',
          target: 'repository',
          githubRepositoryId: 456,
          branch: 'main',
          sha: 'sha-y',
          gen: 5,
        },
      },
    });
    const write = writeQuery();
    (Build.query as jest.Mock).mockReturnValueOnce(read).mockReturnValueOnce(write);

    await acceptDeploymentIntent(42, {
      type: 'repository',
      requestId: 'request-6',
      githubRepositoryId: 123,
    });

    expect(write.patch).toHaveBeenCalledWith({
      desiredGeneration: 6,
      acceptedRefs: {
        'repository:123': { type: 'repository', requestId: 'request-6', githubRepositoryId: 123, gen: 6 },
        'source:456:main': {
          type: 'source',
          requestId: 'request-5',
          target: 'repository',
          githubRepositoryId: 456,
          branch: 'main',
          sha: 'sha-y',
          gen: 5,
        },
      },
    });
  });

  it('returns null without writing when the Build does not exist', async () => {
    (Build.query as jest.Mock).mockReturnValueOnce(readQuery(undefined));

    await expect(acceptDeploymentIntent(404, { type: 'all', requestId: 'request-missing' })).resolves.toBeNull();
    expect(Build.query).toHaveBeenCalledTimes(1);
  });
});

describe('dirtyDeploymentIntents', () => {
  it('extracts only unobserved latest intents in generation order', () => {
    const acceptedRefs: AcceptedDeploymentRefs = {
      all: { type: 'all', requestId: 'request-5', gen: 5 },
      'source:123:main': {
        type: 'source',
        requestId: 'request-2',
        target: 'repository',
        githubRepositoryId: 123,
        branch: 'main',
        sha: 'old',
        gen: 2,
      },
      'repository:456': { type: 'repository', requestId: 'request-3', githubRepositoryId: 456, gen: 3 },
    };

    expect(dirtyDeploymentIntents(acceptedRefs, 2)).toEqual([
      { scopeKey: 'repository:456', intent: acceptedRefs['repository:456'] },
      { scopeKey: 'all', intent: acceptedRefs.all },
    ]);
  });
});
