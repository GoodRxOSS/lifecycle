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

import { validateDiff, UpdateFileTool, MAX_LINES_CHANGED, MAX_LINES_REMOVED } from '../updateFile';
import { GitHubClient, GitHubUserAuthRequiredError } from '../../shared/githubClient';

const mockParseYamlConfigFromString = jest.fn();
const mockValidate = jest.fn();
jest.mock('server/lib/yamlConfigParser', () => ({
  YamlConfigParser: jest.fn().mockImplementation(() => ({
    parseYamlConfigFromString: (...args: unknown[]) => mockParseYamlConfigFromString(...args),
  })),
}));
jest.mock('server/lib/yamlConfigValidator', () => ({
  YamlConfigValidator: jest.fn().mockImplementation(() => ({
    validate: (...args: unknown[]) => mockValidate(...args),
  })),
}));

describe('validateDiff', () => {
  it('allows identical content', () => {
    const content = 'line1\nline2\nline3';
    const result = validateDiff(content, content);
    expect(result.valid).toBe(true);
    expect(result.linesChanged).toBe(0);
    expect(result.linesRemoved).toBe(0);
  });

  it('counts a modified line as one removal plus one addition', () => {
    const old = 'line1\nline2\nline3\nline4\nline5';
    const updated = 'line1\nchanged\nline3\nline4\nline5';
    const result = validateDiff(old, updated);
    expect(result.valid).toBe(true);
    expect(result.linesRemoved).toBe(1);
    expect(result.linesChanged).toBe(2);
  });

  it(`allows changes up to ${MAX_LINES_CHANGED} lines`, () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const inserted = Array.from({ length: MAX_LINES_CHANGED }, (_, i) => `new${i}`);
    const result = validateDiff(lines.join('\n'), [...inserted, ...lines].join('\n'));
    expect(result.valid).toBe(true);
    expect(result.linesRemoved).toBe(0);
    expect(result.linesChanged).toBe(MAX_LINES_CHANGED);
  });

  it(`rejects excessive changes (>${MAX_LINES_CHANGED} lines changed)`, () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const changedLineCount = MAX_LINES_CHANGED + 1;
    const inserted = Array.from({ length: changedLineCount }, (_, i) => `new${i}`);
    const result = validateDiff(lines.join('\n'), [...inserted, ...lines].join('\n'));
    expect(result.valid).toBe(false);
    expect(result.linesChanged).toBe(changedLineCount);
    expect(result.error).toContain('SAFETY ERROR');
    expect(result.error).toContain(`changes ${changedLineCount} lines`);
  });

  it('flags a balanced rewrite as removals even when the line count is unchanged', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const newLines = [...lines];
    for (let i = 0; i < 15; i++) {
      newLines[i] = `rewritten${i}`;
    }
    const result = validateDiff(lines.join('\n'), newLines.join('\n'));
    expect(result.valid).toBe(false);
    expect(result.linesRemoved).toBe(15);
    expect(result.error).toContain('removes 15 lines');
  });

  it(`allows small deletions (up to ${MAX_LINES_REMOVED} lines removed)`, () => {
    const old = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
    const updated = 'line1\nline2\nline3\nline7';
    const result = validateDiff(old, updated);
    expect(result.valid).toBe(true);
  });

  it(`rejects large deletions (>${MAX_LINES_REMOVED} lines removed)`, () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i}`);
    const oldContent = lines.join('\n');
    const newContent = lines.slice(0, 20).join('\n');
    const result = validateDiff(oldContent, newContent);
    expect(result.valid).toBe(false);
    expect(result.linesRemoved).toBe(30);
    expect(result.error).toContain('SAFETY ERROR');
    expect(result.error).toContain('removes 30 lines');
  });

  it('allows adding lines when total changes stay within limit', () => {
    const old = 'line1\nline2\nline3';
    const updated = 'line1\nline2\nnew_line\nline3';
    const result = validateDiff(old, updated);
    expect(result.valid).toBe(true);
  });

  it('allows one line inserted at the top of a 160-line file', () => {
    const lines = Array.from({ length: 160 }, (_, i) => `line${i}`);
    const result = validateDiff(lines.join('\n'), ['inserted', ...lines].join('\n'));
    expect(result.valid).toBe(true);
    expect(result.linesRemoved).toBe(0);
    expect(result.linesChanged).toBe(1);
  });
});

describe('GitHubClient write path safety', () => {
  it('matches normalized config and referenced file paths', () => {
    const client = new GitHubClient();
    client.setAllowedWritePatterns(['lifecycle.yaml']);
    client.setReferencedFiles(['grpc-echo/grpc-echo.Dockerfile']);

    expect(client.isFilePathAllowed('./lifecycle.yaml', 'write')).toBe(true);
    expect(client.isFilePathAllowed('/grpc-echo/grpc-echo.Dockerfile', 'write')).toBe(true);
    expect(client.isFilePathAllowed('secrets/token.txt', 'write')).toBe(false);
  });
});

describe('UpdateFileTool', () => {
  const mockOctokit = { request: jest.fn() };
  const userAuth = { provider: 'github' as const, source: 'user' as const, required: true };
  const mockGithubClient = {
    getOctokit: jest.fn().mockResolvedValue(mockOctokit),
    getOctokitWithAuth: jest.fn().mockResolvedValue({ octokit: mockOctokit, auth: userAuth }),
    isFilePathAllowed: jest.fn().mockReturnValue(true),
    isRepoAllowed: jest.fn().mockReturnValue(true),
    validateBranch: jest.fn().mockReturnValue({ valid: true }),
  } as any;

  let tool: UpdateFileTool;

  const baseArgs = {
    repository_owner: 'org',
    repository_name: 'repo',
    branch: 'feature-branch',
    file_path: 'lifecycle.yaml',
    new_content: 'line1\nline2\nchanged\nline4\nline5',
    commit_message: 'fix typo',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGithubClient.getOctokit.mockResolvedValue(mockOctokit);
    mockGithubClient.getOctokitWithAuth.mockResolvedValue({ octokit: mockOctokit, auth: userAuth });
    mockGithubClient.isFilePathAllowed.mockReturnValue(true);
    mockGithubClient.isRepoAllowed.mockReturnValue(true);
    mockGithubClient.validateBranch.mockReturnValue({ valid: true });
    mockParseYamlConfigFromString.mockReturnValue({ version: '1.0.0' });
    mockValidate.mockReturnValue(true);
    tool = new UpdateFileTool(mockGithubClient);
  });

  it('rejects repositories outside the build scope', async () => {
    mockGithubClient.isRepoAllowed.mockReturnValue(false);
    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REPO_NOT_ALLOWED');
    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  it('fails closed when an approved write has no user GitHub auth', async () => {
    mockGithubClient.getOctokitWithAuth.mockRejectedValueOnce(
      new GitHubUserAuthRequiredError({ provider: 'github', source: 'none', required: true })
    );

    const result = await tool.execute(baseArgs, undefined, { toolCallId: 'tool-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GITHUB_USER_AUTH_REQUIRED');
    expect(result.auth).toEqual({ provider: 'github', source: 'none', required: true });
    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  it('rejects an invalid lifecycle.yaml without committing', async () => {
    mockOctokit.request.mockResolvedValueOnce({
      data: { sha: 'existing-sha', content: Buffer.from('old').toString('base64') },
    });
    mockValidate.mockImplementation(() => {
      throw new Error('services[0] requires a name');
    });

    const result = await tool.execute(baseArgs, undefined, { toolCallId: 'tool-update-file' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LIFECYCLE_CONFIG_INVALID');
    expect(result.auth).toEqual(userAuth);
    expect(result.agentContent).toContain('services[0] requires a name');
    expect(mockGithubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-update-file', {
      requireUserAuth: true,
      toolCallId: 'tool-update-file',
    });
    expect(mockOctokit.request).toHaveBeenCalledTimes(1);
  });

  it('skips validation for new files', async () => {
    mockOctokit.request.mockRejectedValueOnce(new Error('Not Found'));
    mockOctokit.request.mockResolvedValueOnce({
      data: { commit: { sha: 'abc', html_url: 'https://github.com/org/repo/commit/abc' } },
    });

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(true);
  });

  it('rejects updates that remove too many lines', async () => {
    const originalLines = Array.from({ length: 50 }, (_, i) => `line${i}`);
    const originalContent = originalLines.join('\n');

    mockOctokit.request.mockResolvedValueOnce({
      data: {
        sha: 'existing-sha',
        content: Buffer.from(originalContent).toString('base64'),
      },
    });

    const result = await tool.execute({
      ...baseArgs,
      new_content: originalLines.slice(0, 20).join('\n'),
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_VALIDATION_FAILED');
    expect(result.agentContent).toContain('SAFETY ERROR');
  });

  it('allows updates with small changes', async () => {
    const originalContent = 'line1\nline2\nline3\nline4\nline5';
    const newContent = 'line1\nline2\nchanged\nline4\nline5';

    mockOctokit.request
      .mockResolvedValueOnce({
        data: {
          sha: 'existing-sha',
          content: Buffer.from(originalContent).toString('base64'),
        },
      })
      .mockResolvedValueOnce({
        data: { commit: { sha: 'new-sha', html_url: 'https://github.com/org/repo/commit/new-sha' } },
      });

    const result = await tool.execute(
      {
        ...baseArgs,
        new_content: newContent,
      },
      undefined,
      { toolCallId: 'tool-update-file' }
    );

    expect(result.success).toBe(true);
    expect(result.auth).toEqual(userAuth);
    expect(mockGithubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-update-file', {
      requireUserAuth: true,
      toolCallId: 'tool-update-file',
    });
    expect(result.displayContent).toEqual({
      type: 'text',
      content: 'Updated lifecycle.yaml\nCommit: https://github.com/org/repo/commit/new-sha',
    });
    expect(JSON.parse(result.agentContent)).toMatchObject({
      commit_sha: 'new-sha',
      commit_url: 'https://github.com/org/repo/commit/new-sha',
      commit_message: '[Lifecycle AI] fix typo',
      repository: 'org/repo',
      branch: 'feature-branch',
      file_path: 'lifecycle.yaml',
    });
  });

  it('does not create a commit when file content is unchanged', async () => {
    const unchangedContent = 'line1\nline2\nchanged\nline4\nline5';

    mockOctokit.request.mockResolvedValueOnce({
      data: {
        sha: 'existing-sha',
        content: Buffer.from(unchangedContent).toString('base64'),
      },
    });

    const result = await tool.execute({
      ...baseArgs,
      new_content: unchangedContent,
    });

    expect(mockOctokit.request).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.displayContent).toEqual({
      type: 'text',
      content: 'No changes to lifecycle.yaml\nNo commit created.',
    });
    expect(JSON.parse(result.agentContent)).toMatchObject({
      changed: false,
      commit_created: false,
      repository: 'org/repo',
      branch: 'feature-branch',
      file_path: 'lifecycle.yaml',
    });
  });
});
