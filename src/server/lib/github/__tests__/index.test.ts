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
} from 'server/lib/github';
import * as client from 'server/lib/github/client';

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

jest.mock('axios');
jest.mock('server/lib/github/client');
jest.mock('server/lib/github/utils');
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));
import { getLogger, rootLogger as logger } from 'server/lib/logger';

test('createOrUpdatePullRequestComment success', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: 'foo' }),
  });

  const result = await createOrUpdatePullRequestComment({
    installationId: 1,
    pullRequestNumber: 123,
    fullName: 'foo/bar',
    message: 'hello',
    commentId: 123,
    isTesting: true,
  });
  expect(result.data).toEqual('foo');
});

test('getPullRequest success', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: 'foo' }),
  });
  const result = await getPullRequest('foo', 'bar', 1, 123, logger);
  expect(result.data).toEqual('foo');
});

test('getPullRequestByRepositoryFullName success', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: 'foo' }),
  });
  const result = await getPullRequestByRepositoryFullName('foo/foo', 123, 1);
  expect(result.data).toEqual('foo');
});

test('getPullRequestByRepositoryFullName failure', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockRejectedValue(new Error('error')),
  });
  await expect(getPullRequestByRepositoryFullName('foo/foo', 123, 1)).rejects.toThrow();
});

test('getPullRequestByRepositoryFullName invalid repository name', async () => {
  await expect(getPullRequestByRepositoryFullName('foo', 123, 1)).rejects.toThrow();
});

test('createDeploy success', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: 'foo' }),
  });
  const result = await createDeploy('foo', 'bar', 'main', 1);
  expect(result.data).toEqual('foo');
});

test('createDeploy failure', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockRejectedValue(new Error('error')),
  });
  await expect(createDeploy('foo', 'bar', 'main', 1)).rejects.toThrow();
});

test('verifyWebhookSignature false', async () => {
  const req = {
    headers: {
      'x-hub-signature-256': 'sha256=123',
    },
    rawBody: 'foo',
  };
  const result = await verifyWebhookSignature(req as unknown as client.WebhookRequest, '123');
  expect(result).toEqual(false);
});

test('verifyWebhookSignature missing header', async () => {
  const req = {
    body: { foo: 'bar' },
  };
  const result = await verifyWebhookSignature(req as unknown as NextApiRequest);
  expect(result).toEqual(false);
});

test('getSHAForBranch success', async () => {
  const mockSHA = 'abc123def456';
  (utils.getRefForBranchName as jest.Mock).mockResolvedValue({ data: { object: { sha: mockSHA } } });

  const sha = await getSHAForBranch('main', 'foo', 'bar');

  expect(sha).toBe(mockSHA);
});

test('getSHAForBranch failure', async () => {
  const mockError = new Error('error');
  (utils.getRefForBranchName as jest.Mock).mockRejectedValue(mockError);
  await expect(getSHAForBranch('main', 'foo', 'bar')).rejects.toThrow('error');
  expect(getLogger).toHaveBeenCalledWith({ error: mockError, repo: 'foo/bar', branch: 'main' });
});

test('checkIfCommentExists to return true', async () => {
  const mockComments = [{ body: 'This is a test comment' }, { body: `This comment contains the uniqueIdentifier` }];

  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: mockComments }),
  });
  const result = await checkIfCommentExists({
    fullName: 'foo/bar',
    pullRequestNumber: 123,
    commentIdentifier: 'uniqueIdentifier',
  });
  expect(result).not.toBe(false);
  expect(result.body).toContain('uniqueIdentifier');
});

test('checkIfCommentExists to return false', async () => {
  const mockComments = [{ body: 'This is a test comment' }, { body: `This comment contains the not` }];

  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: mockComments }),
  });
  const result = await checkIfCommentExists({
    fullName: 'foo/bar',
    pullRequestNumber: 123,
    commentIdentifier: 'uniqueIdentifier',
  });
  expect(result).toBe(false);
});
