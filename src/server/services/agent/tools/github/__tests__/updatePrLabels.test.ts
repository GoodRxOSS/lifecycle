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

describe('UpdatePrLabelsTool', () => {
  const mockOctokit = { request: jest.fn() };
  const mockGithubClient = {
    getOctokit: jest.fn().mockResolvedValue(mockOctokit),
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
    tool = new UpdatePrLabelsTool(mockGithubClient);
  });

  it('handles aborted signal', async () => {
    const result = await tool.execute(baseArgs, { aborted: true } as any);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
  });

  it('adds missing labels and preserves existing labels', async () => {
    mockOctokit.request
      .mockResolvedValueOnce({
        data: {
          labels: [{ name: 'bug' }, { name: 'help wanted' }],
        },
      })
      .mockResolvedValueOnce({ data: {} });

    const result = await tool.execute({
      ...baseArgs,
      action: 'add',
      labels: ['lifecycle-deploy!', 'BUG'],
    });

    expect(result.success).toBe(true);
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
      labels: ['LIFECYCLE-DEPLOY!'],
    });

    expect(result.success).toBe(true);
    expect(mockOctokit.request).toHaveBeenNthCalledWith(
      2,
      'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels',
      expect.objectContaining({
        labels: ['enhancement'],
      })
    );
  });

  it('sets labels directly without fetching current labels', async () => {
    mockOctokit.request.mockResolvedValueOnce({ data: {} });

    const result = await tool.execute({
      ...baseArgs,
      action: 'set',
      labels: ['lifecycle-deploy!', 'ready-for-qa'],
    });

    expect(result.success).toBe(true);
    expect(mockOctokit.request).toHaveBeenCalledTimes(1);
    expect(mockOctokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels',
      expect.objectContaining({
        labels: ['lifecycle-deploy!', 'ready-for-qa'],
      })
    );
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
  });

  it('rejects unsupported action value', async () => {
    const result = await tool.execute({
      ...baseArgs,
      action: 'delete',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
    expect(mockGithubClient.getOctokit).not.toHaveBeenCalled();
  });
});
