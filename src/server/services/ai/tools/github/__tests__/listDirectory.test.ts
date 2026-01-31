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

import { ListDirectoryTool } from '../listDirectory';

const mockOctokit = { request: jest.fn() };
const mockGithubClient = {
  getOctokit: jest.fn().mockResolvedValue(mockOctokit),
  isFilePathAllowed: jest.fn().mockReturnValue(true),
  isFileExcluded: jest.fn().mockReturnValue(false),
} as any;

describe('ListDirectoryTool', () => {
  let tool: ListDirectoryTool;

  const baseArgs = {
    repository_owner: 'org',
    repository_name: 'repo',
    branch: 'main',
    directory_path: 'src',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGithubClient.getOctokit.mockResolvedValue(mockOctokit);
    mockGithubClient.isFileExcluded.mockReturnValue(false);
    tool = new ListDirectoryTool(mockGithubClient);
  });

  it('lists directory contents', async () => {
    mockOctokit.request.mockResolvedValue({
      data: [
        { name: 'index.ts', type: 'file', path: 'src/index.ts' },
        { name: 'utils', type: 'dir', path: 'src/utils' },
      ],
    });

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.items).toHaveLength(2);
    expect(data.items[0].name).toBe('index.ts');
    expect(data.count).toBe(2);
  });

  it('filters excluded files', async () => {
    mockOctokit.request.mockResolvedValue({
      data: [
        { name: 'index.ts', type: 'file', path: 'src/index.ts' },
        { name: 'secret.env', type: 'file', path: 'src/secret.env' },
      ],
    });
    mockGithubClient.isFileExcluded.mockImplementation((path: string) => path.endsWith('.env'));

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].name).toBe('index.ts');
  });

  it('returns error for non-directory path', async () => {
    mockOctokit.request.mockResolvedValue({
      data: { type: 'file', content: 'abc' },
    });

    const result = await tool.execute(baseArgs);
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('not a directory');
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
