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

import { GetIssueCommentTool } from '../getIssueComment';

describe('GetIssueCommentTool', () => {
  const mockOctokit = { request: jest.fn() };
  const appAuth = {
    provider: 'github' as const,
    source: 'app' as const,
    required: false,
    githubUsername: null,
  };
  const mockGithubClient = {
    isRepoAllowed: jest.fn().mockReturnValue(true),
    getOctokitWithAuth: jest.fn().mockResolvedValue({ octokit: mockOctokit, auth: appAuth }),
  } as any;

  const baseArgs = {
    repository_owner: 'goodrxoss',
    repository_name: 'lifecycle',
    comment_id: 4242,
  };

  let tool: GetIssueCommentTool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGithubClient.isRepoAllowed.mockReturnValue(true);
    mockGithubClient.getOctokitWithAuth.mockResolvedValue({ octokit: mockOctokit, auth: appAuth });
    tool = new GetIssueCommentTool(mockGithubClient);
  });

  it('publishes the stable tool name, description, and required input schema', () => {
    expect(GetIssueCommentTool.Name).toBe('get_issue_comment');
    expect(tool.name).toBe('get_issue_comment');
    expect(tool.description).toContain('specific comment from a GitHub issue or pull request by comment ID');
    expect(tool.description).toContain('ENABLED (checked) vs DISABLED (unchecked)');
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        repository_owner: { type: 'string', description: 'Repository owner' },
        repository_name: { type: 'string', description: 'Repository name' },
        comment_id: { type: 'number', description: 'Comment ID from pull_requests.commentId or issues' },
      },
      required: ['repository_owner', 'repository_name', 'comment_id'],
    });
  });

  it('returns cancellation before repository or authentication checks', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(baseArgs, controller.signal);

    expect(result).toEqual({
      success: false,
      agentContent: 'Error: Operation cancelled',
      error: { message: 'Operation cancelled', code: 'CANCELLED' },
    });
    expect(mockGithubClient.isRepoAllowed).not.toHaveBeenCalled();
    expect(mockGithubClient.getOctokitWithAuth).not.toHaveBeenCalled();
    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  it('rejects a repository outside the environment before requesting authentication', async () => {
    mockGithubClient.isRepoAllowed.mockReturnValue(false);

    const result = await tool.execute({
      ...baseArgs,
      repository_owner: 'another-org',
      repository_name: 'private-repo',
    });

    expect(mockGithubClient.isRepoAllowed).toHaveBeenCalledWith('another-org', 'private-repo');
    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      code: 'REPO_NOT_ALLOWED',
      message:
        'Repository "another-org/private-repo" is outside this environment\'s repositories and cannot be accessed.',
    });
    expect(mockGithubClient.getOctokitWithAuth).not.toHaveBeenCalled();
    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  it('fetches exactly the selected comment and returns its body, timestamps, author, and auth provenance', async () => {
    const body = '- [x] api\n- [ ] worker\n\nStatus: "ready"';
    mockOctokit.request.mockResolvedValue({
      data: {
        body,
        created_at: '2026-08-27T08:00:00Z',
        updated_at: '2026-08-27T08:15:00Z',
        user: { login: 'octocat' },
      },
    });

    const result = await tool.execute(baseArgs, undefined, { toolCallId: 'tool-comment-1' });

    expect(mockGithubClient.isRepoAllowed).toHaveBeenCalledWith('goodrxoss', 'lifecycle');
    expect(mockGithubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-get-issue-comment', {
      requireUserAuth: false,
      toolCallId: 'tool-comment-1',
    });
    expect(mockOctokit.request).toHaveBeenCalledTimes(1);
    expect(mockOctokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner: 'goodrxoss',
      repo: 'lifecycle',
      comment_id: 4242,
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.agentContent)).toEqual({
      success: true,
      body,
      createdAt: '2026-08-27T08:00:00Z',
      updatedAt: '2026-08-27T08:15:00Z',
      author: 'octocat',
    });
    expect(result.displayContent).toEqual({
      type: 'text',
      content: 'Comment by octocat at 2026-08-27T08:00:00Z',
    });
    expect(result.auth).toEqual(appAuth);
  });

  it('uses an unknown-author display when GitHub omits the comment user', async () => {
    mockOctokit.request.mockResolvedValue({
      data: {
        body: 'A comment from a deleted account',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T09:00:00Z',
        user: null,
      },
    });

    const result = await tool.execute(baseArgs);

    expect(mockGithubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-get-issue-comment', {
      requireUserAuth: false,
      toolCallId: undefined,
    });
    expect(JSON.parse(result.agentContent)).toEqual({
      success: true,
      body: 'A comment from a deleted account',
      createdAt: '2026-08-27T09:00:00Z',
      updatedAt: '2026-08-27T09:00:00Z',
    });
    expect(result.displayContent).toEqual({
      type: 'text',
      content: 'Comment by unknown at 2026-08-27T09:00:00Z',
    });
  });

  it('preserves auth provenance when the GitHub comment request fails', async () => {
    const userAuth = {
      provider: 'github' as const,
      source: 'user' as const,
      required: false,
      githubUsername: 'sample-user',
    };
    mockGithubClient.getOctokitWithAuth.mockResolvedValue({ octokit: mockOctokit, auth: userAuth });
    mockOctokit.request.mockRejectedValue(new Error('Comment not found'));

    const result = await tool.execute(baseArgs);

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ message: 'Comment not found', code: 'EXECUTION_ERROR' });
    expect(result.agentContent).toBe('Error: Comment not found');
    expect(result.auth).toEqual(userAuth);
  });

  it('uses the stable fallback error when GitHub rejects without a message', async () => {
    mockOctokit.request.mockRejectedValue(new Error(''));

    const result = await tool.execute(baseArgs);

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ message: 'Failed to fetch comment 4242', code: 'EXECUTION_ERROR' });
    expect(result.agentContent).toBe('Error: Failed to fetch comment 4242');
    expect(result.auth).toEqual(appAuth);
  });

  it('does not call GitHub when authentication client resolution fails', async () => {
    mockGithubClient.getOctokitWithAuth.mockRejectedValue(new Error('GitHub credentials unavailable'));

    const result = await tool.execute(baseArgs, undefined, { toolCallId: 'tool-comment-auth' });

    expect(mockGithubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-get-issue-comment', {
      requireUserAuth: false,
      toolCallId: 'tool-comment-auth',
    });
    expect(mockOctokit.request).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toEqual({ message: 'GitHub credentials unavailable', code: 'EXECUTION_ERROR' });
    expect(result.auth).toBeUndefined();
  });
});
