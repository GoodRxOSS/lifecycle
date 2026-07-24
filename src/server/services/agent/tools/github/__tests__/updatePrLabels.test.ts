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

import { UpdatePrLabelsTool } from '../updatePrLabels';
import { GitHubUserAuthRequiredError } from '../../shared/githubClient';

describe('UpdatePrLabelsTool', () => {
  const mockOctokit = { request: jest.fn() };
  const userAuth = { provider: 'github' as const, source: 'user' as const, required: true };
  const mockGithubClient = {
    getOctokit: jest.fn().mockResolvedValue(mockOctokit),
    getOctokitWithAuth: jest.fn().mockResolvedValue({ octokit: mockOctokit, auth: userAuth }),
    isRepoAllowed: jest.fn().mockReturnValue(true),
    getAllowedPullRequestNumber: jest.fn().mockReturnValue(null),
  } as any;

  let tool: UpdatePrLabelsTool;

  const baseArgs = {
    repository_owner: 'org',
    repository_name: 'repo',
    pull_request_number: 123,
    action: 'add',
    labels: ['lifecycle-deploy!'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGithubClient.getOctokit.mockResolvedValue(mockOctokit);
    mockGithubClient.getOctokitWithAuth.mockResolvedValue({ octokit: mockOctokit, auth: userAuth });
    mockGithubClient.isRepoAllowed.mockReturnValue(true);
    mockGithubClient.getAllowedPullRequestNumber.mockReturnValue(null);
    tool = new UpdatePrLabelsTool(mockGithubClient);
  });

  it('handles aborted signal', async () => {
    const result = await tool.execute(baseArgs, { aborted: true } as any);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
  });

  it('fails closed when an approved label mutation has no user GitHub auth', async () => {
    mockGithubClient.getOctokitWithAuth.mockRejectedValueOnce(
      new GitHubUserAuthRequiredError({ provider: 'github', source: 'none', required: true })
    );

    const result = await tool.execute(baseArgs, undefined, { toolCallId: 'tool-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GITHUB_USER_AUTH_REQUIRED');
    expect(result.auth).toEqual({ provider: 'github', source: 'none', required: true });
    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  it('adds missing labels and preserves existing labels', async () => {
    mockOctokit.request
      .mockResolvedValueOnce({
        data: {
          labels: [{ name: 'bug' }, { name: 'help wanted' }],
        },
      })
      .mockResolvedValueOnce({ data: {} });

    const result = await tool.execute(
      {
        ...baseArgs,
        action: 'add',
        labels: ['lifecycle-deploy!', 'BUG'],
      },
      undefined,
      { toolCallId: 'tool-labels' }
    );

    expect(result.success).toBe(true);
    expect(result.auth).toEqual(userAuth);
    expect(mockGithubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-update-pr-labels', {
      requireUserAuth: true,
      toolCallId: 'tool-labels',
    });
    expect(mockOctokit.request).toHaveBeenNthCalledWith(
      2,
      'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels',
      expect.objectContaining({
        owner: 'org',
        repo: 'repo',
        issue_number: 123,
        labels: ['bug', 'help wanted', 'lifecycle-deploy!'],
      })
    );
  });

  it('removes labels case-insensitively', async () => {
    mockOctokit.request
      .mockResolvedValueOnce({
        data: {
          labels: [{ name: 'lifecycle-deploy!' }, { name: 'enhancement' }],
        },
      })
      .mockResolvedValueOnce({ data: {} });

    const result = await tool.execute({
      ...baseArgs,
      action: 'remove',
      labels: ['ENHANCEMENT'],
    });

    expect(result.success).toBe(true);
    expect(mockOctokit.request).toHaveBeenNthCalledWith(
      2,
      'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels',
      expect.objectContaining({
        labels: ['lifecycle-deploy!'],
      })
    );
  });

  it('sets labels after checking current labels for protected drops', async () => {
    mockOctokit.request
      .mockResolvedValueOnce({ data: { labels: [{ name: 'bug' }] } })
      .mockResolvedValueOnce({ data: {} });

    const result = await tool.execute({
      ...baseArgs,
      action: 'set',
      labels: ['lifecycle-deploy!', 'ready-for-qa'],
    });

    expect(result.success).toBe(true);
    expect(mockOctokit.request).toHaveBeenCalledTimes(2);
    expect(mockOctokit.request).toHaveBeenNthCalledWith(
      2,
      'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels',
      expect.objectContaining({
        labels: ['lifecycle-deploy!', 'ready-for-qa'],
      })
    );
  });

  it('refuses to remove the deploy label', async () => {
    mockOctokit.request.mockResolvedValueOnce({
      data: { labels: [{ name: 'lifecycle-deploy!' }, { name: 'bug' }] },
    });

    const result = await tool.execute(
      {
        ...baseArgs,
        action: 'remove',
        labels: ['lifecycle-deploy!'],
      },
      undefined,
      { toolCallId: 'tool-labels' }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROTECTED_LABEL');
    expect(result.auth).toEqual(userAuth);
    expect(mockGithubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-update-pr-labels', {
      requireUserAuth: true,
      toolCallId: 'tool-labels',
    });
    expect(mockOctokit.request).toHaveBeenCalledTimes(1);
  });

  it('refuses a set that drops the deploy label', async () => {
    mockOctokit.request.mockResolvedValueOnce({
      data: { labels: [{ name: 'lifecycle-deploy!' }] },
    });

    const result = await tool.execute({
      ...baseArgs,
      action: 'set',
      labels: ['ready-for-qa'],
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROTECTED_LABEL');
  });

  it('rejects repositories outside the build scope', async () => {
    mockGithubClient.isRepoAllowed.mockReturnValue(false);

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REPO_NOT_ALLOWED');
    expect(mockGithubClient.getOctokit).not.toHaveBeenCalled();
    expect(mockGithubClient.getOctokitWithAuth).not.toHaveBeenCalled();
  });

  it('rejects a pull request number outside the build scope', async () => {
    mockGithubClient.getAllowedPullRequestNumber.mockReturnValue(999);

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PR_NOT_ALLOWED');
    expect(result.agentContent).toContain('#123');
    expect(result.agentContent).toContain('#999');
    expect(mockGithubClient.getOctokit).not.toHaveBeenCalled();
    expect(mockGithubClient.getOctokitWithAuth).not.toHaveBeenCalled();
  });

  it('allows the build pull request when a PR scope is configured', async () => {
    mockGithubClient.getAllowedPullRequestNumber.mockReturnValue(123);
    mockOctokit.request.mockResolvedValueOnce({ data: { labels: [] } }).mockResolvedValueOnce({ data: {} });

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(true);
  });

  it('rejects empty labels', async () => {
    const result = await tool.execute({
      ...baseArgs,
      labels: [' ', '\n'],
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_LABELS');
  });

  it('rejects missing action', async () => {
    const args = { ...baseArgs } as Record<string, unknown>;
    delete args.action;

    const result = await tool.execute(args);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
    expect(mockGithubClient.getOctokit).not.toHaveBeenCalled();
    expect(mockGithubClient.getOctokitWithAuth).not.toHaveBeenCalled();
  });

  it('rejects unsupported action value', async () => {
    const result = await tool.execute({
      ...baseArgs,
      action: 'delete',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
    expect(mockGithubClient.getOctokit).not.toHaveBeenCalled();
    expect(mockGithubClient.getOctokitWithAuth).not.toHaveBeenCalled();
  });
});
