/**
 * Copyright 2026 GoodRx, Inc.
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

const mockCreateOctokitClient = jest.fn();

jest.mock('server/lib/github/client', () => ({
  createOctokitClient: (...args: unknown[]) => mockCreateOctokitClient(...args),
}));

import { GitHubClient } from '../githubClient';

describe('GitHubClient auth selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateOctokitClient.mockResolvedValue({ request: jest.fn() });
  });

  it('uses user auth for reads when a broker token is available', async () => {
    const client = new GitHubClient();
    client.setRequestAuth({
      githubToken: 'user-token',
      source: 'user',
      githubUsername: 'octocat',
      writeAuthorized: false,
    });

    const { auth } = await client.getOctokitWithAuth('read-caller', { requireUserAuth: false });

    expect(mockCreateOctokitClient).toHaveBeenCalledWith({
      accessToken: 'user-token',
      caller: 'read-caller',
    });
    expect(auth).toEqual({
      provider: 'github',
      source: 'user',
      required: false,
      githubUsername: 'octocat',
    });
  });

  it('falls back to app auth for reads when no user token is available', async () => {
    const client = new GitHubClient();

    const { auth } = await client.getOctokitWithAuth('read-caller', { requireUserAuth: false });

    expect(mockCreateOctokitClient).toHaveBeenCalledWith({ caller: 'read-caller' });
    expect(auth).toEqual({
      provider: 'github',
      source: 'app',
      required: false,
      githubUsername: null,
    });
  });

  it('fails closed for writes without a write-authorized user token', async () => {
    const client = new GitHubClient();
    client.setRequestAuth({
      githubToken: 'app-token',
      source: 'app',
      writeAuthorized: true,
    });

    await expect(client.getOctokitWithAuth('write-caller', { requireUserAuth: true })).rejects.toMatchObject({
      code: 'GITHUB_USER_AUTH_REQUIRED',
      auth: {
        provider: 'github',
        source: 'none',
        required: true,
      },
    });
    expect(mockCreateOctokitClient).not.toHaveBeenCalled();
  });

  it('prefers approval handoff auth for writes', async () => {
    const client = new GitHubClient();
    client.setRequestAuth({
      githubToken: 'submit-token',
      source: 'user',
      githubUsername: 'submitter',
      writeAuthorized: false,
      resolveApprovalAuth: jest.fn().mockResolvedValue({
        githubToken: 'approver-token',
        source: 'user',
        githubUsername: 'approver',
        writeAuthorized: true,
      }),
    });

    const { auth } = await client.getOctokitWithAuth('write-caller', {
      requireUserAuth: true,
      toolCallId: 'tool-1',
    });

    expect(mockCreateOctokitClient).toHaveBeenCalledWith({
      accessToken: 'approver-token',
      caller: 'write-caller',
    });
    expect(auth).toEqual({
      provider: 'github',
      source: 'user',
      required: true,
      githubUsername: 'approver',
    });
  });
});
