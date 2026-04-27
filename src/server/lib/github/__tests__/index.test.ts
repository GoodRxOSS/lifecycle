/**
 * Copyright 2025 GoodRx, Inc.
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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import * as utils from 'server/lib/github/utils';
import {
  createOrUpdatePullRequestComment,
  getPullRequest,
  getPullRequestByRepositoryFullName,
  createDeploy,
  verifyWebhookSignature,
  getSHAForBranch,
  checkIfCommentExists,
  getChangedFilesFromPushPayload,
  getChangedFilesForPush,
} from 'server/lib/github';
import * as client from 'server/lib/github/client';
import { cacheRequest } from 'server/lib/github/cacheRequest';

jest.mock('server/services/globalConfig', () => {
  const RedisMock = {
    hgetall: jest.fn(),
    hset: jest.fn(),
    expire: jest.fn(),
  };
  return {
    getInstance: jest.fn(() => ({
      redis: RedisMock,
    })),
  };
});

jest.mock('server/lib/github/client');
jest.mock('server/lib/github/cacheRequest');
jest.mock('server/lib/github/utils');
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));
import { getLogger } from 'server/lib/logger';

beforeEach(() => {
  jest.clearAllMocks();
});

test('createOrUpdatePullRequestComment success', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: 'foo' }),
  });

  const result = await createOrUpdatePullRequestComment({
    installationId: 1,
    pullRequestNumber: 123,
    fullName: 'example-org/example-repo',
    message: 'hello',
    commentId: 123,
    isTesting: true,
  });
  expect(result.data).toEqual('foo');
});

test('getPullRequest success', async () => {
  (cacheRequest as jest.Mock).mockResolvedValue({ data: 'foo' });
  const result = await getPullRequest('foo', 'bar', 1, 123);
  expect(result.data).toEqual('foo');
});

test('getPullRequestByRepositoryFullName success', async () => {
  (cacheRequest as jest.Mock).mockResolvedValue({ data: 'foo' });
  const result = await getPullRequestByRepositoryFullName('example-org/example-repo', 123);
  expect(result.data).toEqual('foo');
});

test('getPullRequestByRepositoryFullName failure', async () => {
  (cacheRequest as jest.Mock).mockRejectedValue(new Error('error'));
  await expect(getPullRequestByRepositoryFullName('example-org/example-repo', 123)).rejects.toThrow();
});

test('getPullRequestByRepositoryFullName invalid repository name', async () => {
  (cacheRequest as jest.Mock).mockRejectedValue(new Error('error'));
  await expect(getPullRequestByRepositoryFullName('foo', 123)).rejects.toThrow();
});

test('createDeploy success', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: 'foo' }),
  });
  const result = await createDeploy({ repositoryId: 1, owner: 'foo', name: 'bar', branch: 'main', installationId: 1 });
  expect(result.data).toEqual('foo');
});

test('createDeploy failure', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockRejectedValue(new Error('error')),
  });
  await expect(
    createDeploy({ repositoryId: 1, owner: 'foo', name: 'bar', branch: 'main', installationId: 1 })
  ).rejects.toThrow();
});

test('verifyWebhookSignature false', async () => {
  const req = {
    headers: {
      'x-hub-signature-256': 'sha256=123',
    },
    rawBody: 'foo',
  };
  const result = await verifyWebhookSignature(req as any);
  expect(result).toEqual(false);
});

test('verifyWebhookSignature missing header', async () => {
  const req = {
    body: { foo: 'bar' },
  };
  const result = await verifyWebhookSignature(req as any);
  expect(result).toEqual(false);
});

test('getSHAForBranch success', async () => {
  const mockSHA = 'abc123def456';
  (utils.getRefForBranchName as jest.Mock).mockResolvedValue({ data: { object: { sha: mockSHA } } });

  const sha = await getSHAForBranch('main', 'example-org', 'example-repo');

  expect(sha).toBe(mockSHA);
});

test('getSHAForBranch failure', async () => {
  const mockError = new Error('error');
  (utils.getRefForBranchName as jest.Mock).mockRejectedValue(mockError);
  await expect(getSHAForBranch('main', 'example-org', 'example-repo')).rejects.toThrow('error');
  expect(getLogger).toHaveBeenCalledWith({ error: mockError, repo: 'example-org/example-repo', branch: 'main' });
});

test('checkIfCommentExists to return true', async () => {
  const mockComments = [{ body: 'This is a test comment' }, { body: `This comment contains the uniqueIdentifier` }];

  (cacheRequest as jest.Mock).mockResolvedValue({ data: mockComments });
  const result = await checkIfCommentExists({
    fullName: 'example-org/example-repo',
    pullRequestNumber: 123,
    commentIdentifier: 'uniqueIdentifier',
  });
  expect(result).not.toBe(false);
  expect(result.body).toContain('uniqueIdentifier');
});

test('checkIfCommentExists to return false', async () => {
  const mockComments = [{ body: 'This is a test comment' }, { body: `This comment contains the not` }];

  (cacheRequest as jest.Mock).mockResolvedValue({ data: mockComments });
  const result = await checkIfCommentExists({
    fullName: 'example-org/example-repo',
    pullRequestNumber: 123,
    commentIdentifier: 'uniqueIdentifier',
  });
  expect(result).toBe(false);
});

test('getChangedFilesForPush returns current filenames from compare responses', async () => {
  (cacheRequest as jest.Mock).mockResolvedValue({
    headers: {
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1770000000',
    },
    data: {
      files: [
        {
          filename: 'src/new-name.ts',
          previous_filename: 'src/old-name.ts',
          status: 'renamed',
        },
      ],
    },
  });

  const result = await getChangedFilesForPush({
    fullName: 'example-org/example-repo',
    before: 'before-sha',
    after: 'after-sha',
  });

  expect(cacheRequest).toHaveBeenCalledWith('GET /repos/example-org/example-repo/compare/before-sha...after-sha');
  expect(result).toEqual({ canSkip: true, files: ['src/new-name.ts'] });
});

test('getChangedFilesFromPushPayload returns unique added and modified files', () => {
  expect(
    getChangedFilesFromPushPayload({
      commits: [
        {
          added: ['src/new.ts'],
          modified: ['docs/readme.md'],
        },
        {
          modified: ['docs/readme.md', 'src/app.ts'],
        },
      ],
      commitCount: 2,
    })
  ).toEqual({ canSkip: true, files: ['src/new.ts', 'docs/readme.md', 'src/app.ts'] });
});

test('getChangedFilesFromPushPayload falls back for incomplete or removed-file payloads', () => {
  expect(
    getChangedFilesFromPushPayload({
      commits: [{ modified: ['src/app.ts'] }],
      commitCount: 2,
    })
  ).toEqual({ canSkip: false, files: [], reason: 'payload_commits_incomplete' });

  expect(
    getChangedFilesFromPushPayload({
      commits: [{ removed: ['src/old.ts'] }],
      commitCount: 1,
    })
  ).toEqual({ canSkip: false, files: [], reason: 'payload_has_removed_files' });
});

test('getChangedFilesForPush fails open for large compare file lists', async () => {
  (cacheRequest as jest.Mock).mockResolvedValue({
    data: {
      files: Array.from({ length: 300 }, (_value, index) => ({
        filename: `file-${index}.ts`,
      })),
    },
  });

  await expect(
    getChangedFilesForPush({
      fullName: 'example-org/example-repo',
      before: 'before-sha',
      after: 'after-sha',
    })
  ).resolves.toEqual({ canSkip: false, files: [], reason: 'large_or_incomplete_compare' });
});

test('getChangedFilesForPush fails open when compare cannot provide filenames', async () => {
  (cacheRequest as jest.Mock).mockResolvedValue({
    data: {
      files: [{ filename: 'src/api.ts' }, { status: 'removed' }],
    },
  });

  await expect(
    getChangedFilesForPush({
      fullName: 'example-org/example-repo',
      before: 'before-sha',
      after: 'after-sha',
    })
  ).resolves.toEqual({ canSkip: false, files: [], reason: 'missing_file_names' });
});
