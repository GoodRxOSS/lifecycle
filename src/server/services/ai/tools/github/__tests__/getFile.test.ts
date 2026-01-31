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

import { GetFileTool } from '../getFile';

const mockOctokit = { request: jest.fn() };
const mockGithubClient = {
  getOctokit: jest.fn().mockResolvedValue(mockOctokit),
  isFilePathAllowed: jest.fn().mockReturnValue(true),
  isFileExcluded: jest.fn().mockReturnValue(false),
  validateBranch: jest.fn().mockReturnValue({ valid: true }),
} as any;

describe('GetFileTool', () => {
  let tool: GetFileTool;

  const baseArgs = {
    repository_owner: 'org',
    repository_name: 'repo',
    branch: 'main',
    file_path: 'src/index.ts',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGithubClient.getOctokit.mockResolvedValue(mockOctokit);
    mockGithubClient.isFilePathAllowed.mockReturnValue(true);
    tool = new GetFileTool(mockGithubClient);
  });

  it('reads file successfully', async () => {
    const fileContent = 'hello world\nsecond line';
    mockOctokit.request.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from(fileContent).toString('base64'),
        sha: 'abc123',
      },
    });

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.path).toBe('src/index.ts');
    expect(data.sha).toBe('abc123');
    expect(data.content).toContain('1:');
    expect(data.content).toContain('hello world');
    expect(data.rawContent).toBeUndefined();
  });

  it('returns error for access denied', async () => {
    mockGithubClient.isFilePathAllowed.mockReturnValue(false);

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_ACCESS_DENIED');
  });

  it('returns error for non-file path', async () => {
    mockOctokit.request.mockResolvedValue({
      data: { type: 'dir' },
    });

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('not a file');
  });

  it('handles API error', async () => {
    mockOctokit.request.mockRejectedValue(new Error('Not Found'));

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Not Found');
  });

  it('handles aborted signal', async () => {
    const result = await tool.execute(baseArgs, { aborted: true } as any);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
  });
});
