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

import { validateDiff, UpdateFileTool } from '../updateFile';

describe('validateDiff', () => {
  it('allows identical content', () => {
    const content = 'line1\nline2\nline3';
    const result = validateDiff(content, content);
    expect(result.valid).toBe(true);
    expect(result.linesChanged).toBe(0);
    expect(result.linesRemoved).toBe(0);
  });

  it('allows small changes (1-3 lines modified)', () => {
    const old = 'line1\nline2\nline3\nline4\nline5';
    const updated = 'line1\nchanged\nline3\nline4\nline5';
    const result = validateDiff(old, updated);
    expect(result.valid).toBe(true);
    expect(result.linesChanged).toBe(1);
  });

  it('allows changes up to 60 lines', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line${i}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    for (let i = 0; i < 60; i++) {
      newLines[i] = `changed${i}`;
    }
    const result = validateDiff(oldContent, newLines.join('\n'));
    expect(result.valid).toBe(true);
    expect(result.linesChanged).toBe(60);
  });

  it('rejects excessive changes (>60 lines changed)', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line${i}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    for (let i = 0; i < 61; i++) {
      newLines[i] = `changed${i}`;
    }
    const result = validateDiff(oldContent, newLines.join('\n'));
    expect(result.valid).toBe(false);
    expect(result.linesChanged).toBe(61);
    expect(result.error).toContain('SAFETY ERROR');
    expect(result.error).toContain('changes 61 lines');
  });

  it('allows small deletions (up to 3 lines removed)', () => {
    const old = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
    const updated = 'line1\nline2\nline3\nline7';
    const result = validateDiff(old, updated);
    expect(result.valid).toBe(true);
  });

  it('rejects large deletions (>3 lines removed)', () => {
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
});

describe('UpdateFileTool', () => {
  const mockOctokit = { request: jest.fn() };
  const mockGithubClient = {
    getOctokit: jest.fn().mockResolvedValue(mockOctokit),
    isFilePathAllowed: jest.fn().mockReturnValue(true),
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
    mockGithubClient.isFilePathAllowed.mockReturnValue(true);
    mockGithubClient.validateBranch.mockReturnValue({ valid: true });
    tool = new UpdateFileTool(mockGithubClient);
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

    const result = await tool.execute({
      ...baseArgs,
      new_content: newContent,
    });

    expect(result.success).toBe(true);
  });
});
