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

import crypto from 'crypto';
import * as utils from 'server/lib/github/utils';
import {
  ConfigFileNotFound,
  compareCommits,
  createOrUpdatePullRequestComment,
  createDeploy,
  checkIfCommentExists,
  getChangedFilesFromPushPayload,
  getChangedFilesForPush,
  getPullRequest,
  getPullRequestByRepositoryFullName,
  getPullRequestLabels,
  getRepositoryByFullName,
  getSHAForBranch,
  getShaForDeploy,
  getYamlFileContent,
  getYamlFileContentFromBranch,
  getYamlFileContentFromPullRequest,
  listBranchesForRepo,
  listInstallationRepositories,
  updatePullRequestLabels,
  verifyWebhookSignature,
} from 'server/lib/github';
import * as client from 'server/lib/github/client';
import { cacheRequest } from 'server/lib/github/cacheRequest';
import { GITHUB_WEBHOOK_SECRET } from 'shared/config';

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

describe('repository and pull-request API wrappers', () => {
  const mockClient = (request: jest.Mock) => {
    (client.createOctokitClient as jest.Mock).mockResolvedValue({ request });
    return request;
  };

  test('gets a repository through its installation-scoped client', async () => {
    const request = mockClient(jest.fn().mockResolvedValue({ data: { full_name: 'org/repo' } }));

    await expect(getRepositoryByFullName('org/repo', 19)).resolves.toEqual({ data: { full_name: 'org/repo' } });
    expect(client.createOctokitClient).toHaveBeenCalledWith({
      installationId: 19,
      caller: 'getRepositoryByFullName',
    });
    expect(request).toHaveBeenCalledWith('GET /repos/org/repo');
  });

  test('distinguishes inaccessible repositories from other repository failures', async () => {
    mockClient(jest.fn().mockRejectedValue({ status: 404, message: 'missing' }));
    await expect(getRepositoryByFullName('org/missing', 19)).rejects.toThrow(
      'Repository not found or GitHub App cannot access it: org/missing'
    );

    mockClient(jest.fn().mockRejectedValue({ status: 500 }));
    await expect(getRepositoryByFullName('org/repo', 19)).rejects.toThrow('Unable to retrieve repository');
  });

  test('lists installation repositories with GitHub pagination', async () => {
    const request = mockClient(jest.fn().mockResolvedValue({ data: { repositories: [] } }));

    await expect(listInstallationRepositories({ installationId: 19, page: 2, perPage: 25 })).resolves.toEqual({
      data: { repositories: [] },
    });
    expect(request).toHaveBeenCalledWith('GET /installation/repositories', { page: 2, per_page: 25 });
  });

  test('normalizes installation repository failures without messages', async () => {
    mockClient(jest.fn().mockRejectedValue({}));
    await expect(listInstallationRepositories({ installationId: 19, page: 1, perPage: 25 })).rejects.toThrow(
      'Unable to retrieve installation repositories'
    );
  });

  test('creates a new pull-request comment when no comment id exists', async () => {
    const request = mockClient(jest.fn().mockResolvedValue({ data: { id: 5 } }));

    await expect(
      createOrUpdatePullRequestComment({
        installationId: 19,
        pullRequestNumber: 7,
        fullName: 'org/repo',
        message: 'hello',
        etag: 'etag-1',
      } as any)
    ).resolves.toEqual({ data: { id: 5 } });
    expect(request).toHaveBeenCalledWith('POST /repos/org/repo/issues/7/comments', {
      data: { body: 'hello' },
      headers: { etag: 'etag-1' },
    });
  });

  test('normalizes comment failures without provider messages', async () => {
    mockClient(jest.fn().mockRejectedValue({}));
    await expect(
      createOrUpdatePullRequestComment({
        installationId: 19,
        pullRequestNumber: 7,
        fullName: 'org/repo',
        message: 'hello',
      } as any)
    ).rejects.toThrow('Unable to create or update pull request comment');
  });

  test('replaces pull-request labels and preserves provider errors', async () => {
    const request = mockClient(jest.fn().mockResolvedValue({ data: [{ name: 'ready' }] }));
    await expect(
      updatePullRequestLabels({
        installationId: 19,
        pullRequestNumber: 7,
        fullName: 'org/repo',
        labels: ['ready'],
      })
    ).resolves.toEqual({ data: [{ name: 'ready' }] });
    expect(request).toHaveBeenCalledWith('PUT /repos/org/repo/issues/7/labels', {
      data: { labels: ['ready'] },
    });

    const failure = new Error('label update failed');
    mockClient(jest.fn().mockRejectedValue(failure));
    await expect(
      updatePullRequestLabels({
        installationId: 19,
        pullRequestNumber: 7,
        fullName: 'org/repo',
        labels: ['ready'],
      })
    ).rejects.toBe(failure);
  });

  test('normalizes pull-request fetch failures', async () => {
    (cacheRequest as jest.Mock).mockRejectedValue({});
    await expect(getPullRequest('org', 'repo', 7, 19)).rejects.toThrow('Unable to retrieve pull request');
  });

  test('returns current pull-request label names and preserves fetch errors', async () => {
    const request = mockClient(
      jest.fn().mockResolvedValue({ data: { labels: [{ name: 'ready' }, { name: 'lifecycle' }] } })
    );
    await expect(
      getPullRequestLabels({ installationId: 19, pullRequestNumber: 7, fullName: 'org/repo' })
    ).resolves.toEqual(['ready', 'lifecycle']);
    expect(request).toHaveBeenCalledWith('GET /repos/org/repo/issues/7');

    const failure = new Error('labels unavailable');
    mockClient(jest.fn().mockRejectedValue(failure));
    await expect(getPullRequestLabels({ installationId: 19, pullRequestNumber: 7, fullName: 'org/repo' })).rejects.toBe(
      failure
    );
  });
});

describe('webhook, deploy SHA, and compare behavior', () => {
  test('accepts a correctly signed webhook body', () => {
    const body = { action: 'opened', repository: { full_name: 'org/repo' } };
    const signature = `sha1=${crypto
      .createHmac('sha1', GITHUB_WEBHOOK_SECRET)
      .update(JSON.stringify(body))
      .digest('hex')}`;

    expect(
      verifyWebhookSignature({
        headers: { 'x-hub-signature': signature },
        body,
      } as any)
    ).toBe(true);
  });

  test('loads repository metadata before resolving a deploy branch SHA', async () => {
    const deploy = {
      uuid: 'deploy-1',
      branchName: 'main',
      deployable: { repository: { fullName: 'org/repo' } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    (utils.getRefForBranchName as jest.Mock).mockResolvedValue({ data: { object: { sha: 'sha-1' } } });

    await expect(getShaForDeploy(deploy as any)).resolves.toBe('sha-1');
    expect(deploy.$fetchGraph).toHaveBeenCalledWith('deployable.repository');
    expect(utils.getRefForBranchName).toHaveBeenCalledWith('org', 'repo', 'main');
  });

  test.each([
    ['missing repository', { deployable: null, branchName: 'main' }, 'Repository not found to get sha'],
    [
      'missing repository name',
      { deployable: { repository: {} }, branchName: 'main' },
      'Repository name or branch name',
    ],
    ['missing branch', { deployable: { repository: { fullName: 'org/repo' } } }, 'Repository name or branch name'],
  ])('surfaces the deploy context when SHA lookup has a %s', async (_label, fields, message) => {
    const deploy = {
      uuid: 'deploy-1',
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      ...fields,
    };

    await expect(getShaForDeploy(deploy as any)).rejects.toThrow(message);
  });

  test('falls back to the stable deploy SHA error when graph loading rejects without a message', async () => {
    const deploy = {
      uuid: 'deploy-1',
      $fetchGraph: jest.fn().mockRejectedValue({}),
    };
    await expect(getShaForDeploy(deploy as any)).rejects.toThrow('Unable to retrieve SHA for deploy');
  });

  test.each(['ahead', 'behind', 'diverged', 'identical'] as const)(
    'returns the supported %s commit comparison status',
    async (status) => {
      (cacheRequest as jest.Mock).mockResolvedValue({ data: { status } });
      await expect(compareCommits({ fullName: 'org/repo', base: 'main', head: 'feature' })).resolves.toBe(status);
      expect(cacheRequest).toHaveBeenCalledWith('GET /repos/org/repo/compare/main...feature');
    }
  );

  test('rejects unknown commit comparison statuses', async () => {
    (cacheRequest as jest.Mock).mockResolvedValue({ data: { status: 'unknown' } });
    await expect(compareCommits({ fullName: 'org/repo', base: 'main', head: 'feature' })).rejects.toThrow(
      'GitHub compare returned an invalid status for org/repo'
    );
  });

  test.each([
    ['missing commits', {}, 'payload_missing_commits'],
    ['empty commits', { commits: [] }, 'payload_missing_commits'],
    ['commits without files', { commits: [{}] }, 'payload_missing_files'],
    ['only empty file names', { commits: [{ added: [''], modified: [''] }] }, 'payload_missing_files'],
  ])('fails open for push payloads with %s', (_label, input, reason) => {
    expect(getChangedFilesFromPushPayload(input)).toEqual({ canSkip: false, files: [], reason });
  });

  test('fails open when compare returns no files', async () => {
    (cacheRequest as jest.Mock).mockResolvedValue({ data: { files: [] } });
    await expect(getChangedFilesForPush({ fullName: 'org/repo', before: 'before', after: 'after' })).resolves.toEqual({
      canSkip: false,
      files: [],
      reason: 'no_files',
    });
  });

  test('fails open with rate-limit context when compare throws', async () => {
    const failure = {
      message: 'rate limited',
      response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1770000000' } },
    };
    (cacheRequest as jest.Mock).mockRejectedValue(failure);

    await expect(getChangedFilesForPush({ fullName: 'org/repo', before: 'before', after: 'after' })).resolves.toEqual({
      canSkip: false,
      files: [],
      reason: 'compare_fetch_failed',
    });
    expect(getLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        error: failure,
        repo: 'org/repo',
        rateLimitRemaining: '0',
        rateLimitReset: '1770000000',
      })
    );
  });

  test('also reads direct error headers when compare rejects', async () => {
    (cacheRequest as jest.Mock).mockRejectedValue({
      headers: { 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': '1770000001' },
    });
    await expect(getChangedFilesForPush({ fullName: 'org/repo', before: 'before', after: 'after' })).resolves.toEqual({
      canSkip: false,
      files: [],
      reason: 'compare_fetch_failed',
    });
  });
});

describe('Lifecycle YAML retrieval', () => {
  const yamlText = 'services:\n  api:\n    build:\n      context: .\n';
  const treeResponse = {
    data: {
      tree: [{ path: 'README.md' }, { path: '.lifecycle.yaml' }],
    },
  };
  const contentResponse = {
    data: { content: Buffer.from(yamlText).toString('base64') },
  };

  test('returns decoded YAML text from a branch', async () => {
    (cacheRequest as jest.Mock).mockResolvedValueOnce(treeResponse).mockResolvedValueOnce(contentResponse);

    await expect(getYamlFileContent({ fullName: 'org/repo', branch: 'main' })).resolves.toBe(yamlText);
    expect(cacheRequest).toHaveBeenNthCalledWith(1, 'GET /repos/org/repo/git/trees/main');
    expect(cacheRequest).toHaveBeenNthCalledWith(2, 'GET /repos/org/repo/contents/.lifecycle.yaml?ref=main');
  });

  test('prefers an explicit SHA and parses YAML as JSON-compatible data', async () => {
    (cacheRequest as jest.Mock).mockResolvedValueOnce(treeResponse).mockResolvedValueOnce(contentResponse);

    await expect(
      getYamlFileContent({ fullName: 'org/repo', branch: 'main', sha: 'commit-sha', isJSON: true })
    ).resolves.toEqual({ services: { api: { build: { context: '.' } } } });
    expect(cacheRequest).toHaveBeenNthCalledWith(1, 'GET /repos/org/repo/git/trees/commit-sha');
  });

  test('normalizes missing config paths and missing content to ConfigFileNotFound', async () => {
    (cacheRequest as jest.Mock).mockResolvedValueOnce({ data: { tree: [{ path: 'README.md' }] } });
    await expect(getYamlFileContent({ fullName: 'org/repo', branch: 'main' })).rejects.toBeInstanceOf(
      ConfigFileNotFound
    );

    (cacheRequest as jest.Mock).mockResolvedValueOnce(treeResponse).mockResolvedValueOnce({ data: { content: null } });
    await expect(getYamlFileContent({ fullName: 'org/repo', branch: 'main' })).rejects.toBeInstanceOf(
      ConfigFileNotFound
    );
  });

  test('rejects decoded empty content and YAML that parses to no value', async () => {
    (cacheRequest as jest.Mock)
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValueOnce({ data: { content: '====' } });
    await expect(getYamlFileContent({ fullName: 'org/repo', branch: 'main' })).rejects.toBeInstanceOf(
      ConfigFileNotFound
    );

    (cacheRequest as jest.Mock)
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValueOnce({ data: { content: Buffer.from('null\n').toString('base64') } });
    await expect(getYamlFileContent({ fullName: 'org/repo', branch: 'main', isJSON: true })).rejects.toBeInstanceOf(
      ConfigFileNotFound
    );
  });

  test('loads YAML from a pull request head branch', async () => {
    (cacheRequest as jest.Mock)
      .mockResolvedValueOnce({ data: { head: { ref: 'feature' } } })
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValueOnce(contentResponse);

    await expect(getYamlFileContentFromPullRequest('org/repo', 7)).resolves.toBe(yamlText);
    expect(cacheRequest).toHaveBeenNthCalledWith(1, 'GET /repos/org/repo/pulls/7');
    expect(cacheRequest).toHaveBeenNthCalledWith(2, 'GET /repos/org/repo/git/trees/feature');
  });

  test('normalizes pull-request responses without a head branch', async () => {
    (cacheRequest as jest.Mock).mockResolvedValue({ data: { head: {} } });
    await expect(getYamlFileContentFromPullRequest('org/repo', 7)).rejects.toBeInstanceOf(ConfigFileNotFound);
  });

  test('loads YAML from a named branch and normalizes branch failures', async () => {
    (cacheRequest as jest.Mock).mockResolvedValueOnce(treeResponse).mockResolvedValueOnce(contentResponse);
    await expect(getYamlFileContentFromBranch('org/repo', 'release')).resolves.toBe(yamlText);

    (cacheRequest as jest.Mock).mockRejectedValue(new Error('tree unavailable'));
    await expect(getYamlFileContentFromBranch('org/repo', 'release')).rejects.toBeInstanceOf(ConfigFileNotFound);
  });
});

describe('comment and branch helpers', () => {
  test('returns false when the comment list request fails', async () => {
    (cacheRequest as jest.Mock).mockRejectedValue(new Error('comments unavailable'));
    await expect(
      checkIfCommentExists({
        fullName: 'org/repo',
        pullRequestNumber: 7,
        commentIdentifier: '<!-- lifecycle -->',
      })
    ).resolves.toBe(false);
  });

  test('constructs ConfigFileNotFound with optional lifecycle context', () => {
    expect(new ConfigFileNotFound('missing')).toMatchObject({
      message: 'missing',
      uuid: null,
      service: null,
    });
    expect(new ConfigFileNotFound('missing', 'build-1', 'api').getMessage()).toBe('[build-1] missing');
  });

  test('lists valid branch names with the repository default branch', async () => {
    (cacheRequest as jest.Mock)
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: [{ name: 'main' }, { name: 'feature' }, { name: '' }, { name: 4 }, null] });

    await expect(listBranchesForRepo('org/repo')).resolves.toEqual({
      branches: ['main', 'feature'],
      defaultBranch: 'main',
    });
  });

  test('defaults malformed branch and repository payloads', async () => {
    (cacheRequest as jest.Mock)
      .mockResolvedValueOnce({ data: { default_branch: 42 } })
      .mockResolvedValueOnce({ data: { name: 'not-an-array' } });

    await expect(listBranchesForRepo('org/repo')).resolves.toEqual({ branches: [], defaultBranch: null });
  });
});
