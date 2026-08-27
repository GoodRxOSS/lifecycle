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

import { GitHubClient, GitHubUserAuthRequiredError, isGitHubUserAuthorizationError } from '../githubClient';

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

  it('uses the request user token for writes when no approval resolver is configured', async () => {
    const client = new GitHubClient();
    client.setRequestAuth({
      githubToken: 'request-token',
      source: 'user',
      githubUsername: 'request-user',
      writeAuthorized: true,
    });

    const result = await client.getOctokitWithAuth('write-caller', { requireUserAuth: true });

    expect(result.auth).toEqual({
      provider: 'github',
      source: 'user',
      required: true,
      githubUsername: 'request-user',
    });
    expect(mockCreateOctokitClient).toHaveBeenCalledWith({
      accessToken: 'request-token',
      caller: 'write-caller',
    });
  });

  it('falls back from approval auth without a token to an authorized request token', async () => {
    const resolveApprovalAuth = jest.fn().mockResolvedValue({
      githubToken: null,
      source: 'none',
      writeAuthorized: false,
    });
    const client = new GitHubClient();
    client.setRunUuid('run-1');
    client.setRequestAuth({
      githubToken: 'request-token',
      source: 'user',
      githubUsername: 'request-user',
      writeAuthorized: true,
      resolveApprovalAuth,
    });

    const result = await client.getOctokitWithAuth('write-caller', {
      requireUserAuth: true,
      toolCallId: 'tool-1',
    });

    expect(resolveApprovalAuth).toHaveBeenCalledWith({ runUuid: 'run-1', toolCallId: 'tool-1' });
    expect(result.auth.githubUsername).toBe('request-user');
  });

  it('clears request auth and its approval resolver together', async () => {
    const resolveApprovalAuth = jest.fn();
    const client = new GitHubClient();
    client.setRunUuid(undefined);
    client.setRequestAuth({
      githubToken: 'request-token',
      source: 'user',
      writeAuthorized: true,
      resolveApprovalAuth,
    });
    client.setRequestAuth(null);

    await expect(client.getOctokitWithAuth('write-caller', { requireUserAuth: true })).rejects.toBeInstanceOf(
      GitHubUserAuthRequiredError
    );

    expect(resolveApprovalAuth).not.toHaveBeenCalled();
  });

  it('uses app auth when a nominal user auth record has no token', async () => {
    const client = new GitHubClient();
    client.setRequestAuth({
      githubToken: '   ',
      source: 'user',
      githubUsername: 'octocat',
      writeAuthorized: true,
    });

    const result = await client.getOctokitWithAuth('read-caller', { requireUserAuth: false });

    expect(result.auth.source).toBe('app');
    expect(mockCreateOctokitClient).toHaveBeenCalledWith({ caller: 'read-caller' });
  });

  it('provides a compatibility Octokit accessor using app auth', async () => {
    const octokit = { request: jest.fn() };
    mockCreateOctokitClient.mockResolvedValueOnce(octokit);
    const client = new GitHubClient();

    await expect(client.getOctokit('legacy-caller')).resolves.toBe(octokit);

    expect(mockCreateOctokitClient).toHaveBeenCalledWith({ caller: 'legacy-caller' });
  });
});

describe('GitHubClient scope safety', () => {
  let client: GitHubClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new GitHubClient();
  });

  it('allows every repository until an explicit repository scope is configured', () => {
    expect(client.isRepoAllowed('any-owner', 'any-repo')).toBe(true);
    expect(client.getAllowedRepos()).toEqual([]);

    client.setAllowedRepos([]);
    expect(client.isRepoAllowed('still', 'allowed')).toBe(true);

    client.setAllowedRepos(null);
    expect(client.isRepoAllowed('also', 'allowed')).toBe(true);
  });

  it('normalizes repository scope and rejects repositories outside it', () => {
    client.setAllowedRepos([' GoodRx/Lifecycle ', '', 'GOODRX/Other']);

    expect(client.getAllowedRepos()).toEqual(['goodrx/lifecycle', 'goodrx/other']);
    expect(client.isRepoAllowed('GOODRX', 'LIFECYCLE')).toBe(true);
    expect(client.isRepoAllowed('goodrx', 'missing')).toBe(false);
    expect(() => client.assertRepoAllowed('goodrx', 'missing')).toThrow(
      'Repository "goodrx/missing" is outside this environment\'s repositories (goodrx/lifecycle, goodrx/other) and cannot be accessed.'
    );
    expect(() => client.assertRepoAllowed('goodrx', 'lifecycle')).not.toThrow();
  });

  it('tracks a valid default repository and clears incomplete values', () => {
    client.setDefaultRepo(' GoodRx/Lifecycle ');
    expect(client.getDefaultRepo()).toEqual({ owner: 'GoodRx', repo: 'Lifecycle' });

    client.setDefaultRepo('owner-only');
    expect(client.getDefaultRepo()).toBeNull();

    client.setDefaultRepo(undefined);
    expect(client.getDefaultRepo()).toBeNull();
  });

  it('accepts numeric pull request scope including zero and clears non-numeric values', () => {
    client.setAllowedPullRequestNumber(0);
    expect(client.getAllowedPullRequestNumber()).toBe(0);

    client.setAllowedPullRequestNumber(42);
    expect(client.getAllowedPullRequestNumber()).toBe(42);

    client.setAllowedPullRequestNumber(undefined);
    expect(client.getAllowedPullRequestNumber()).toBeNull();
  });

  it('validates writes against the configured branch', () => {
    expect(client.validateBranch('feature/fix')).toEqual({
      valid: false,
      error: 'SAFETY ERROR: No allowed branch set. Cannot commit.',
    });

    client.setAllowedBranch('feature/fix');
    expect(client.getAllowedBranch()).toBe('feature/fix');
    expect(client.validateBranch('main')).toEqual({
      valid: false,
      error:
        'SAFETY ERROR: Attempted to commit to branch "main" but only "feature/fix" is allowed. This prevents accidental commits to main/master.',
    });
    expect(client.validateBranch('feature/fix')).toEqual({ valid: true });
  });

  it('allows every read except excluded files and limits writes to references or approved patterns', () => {
    client.setReferencedFiles(['/Dockerfile', './charts/values.yaml']);
    client.setAllowedWritePatterns(['lifecycle.y*ml', '.github/**/*.yml']);
    client.setExcludedFilePatterns(['secrets/**', '**/*.pem']);

    expect(client.isFileExcluded('SECRETS/token.txt')).toBe(true);
    expect(client.isFileExcluded('.hidden/key.pem')).toBe(true);
    expect(client.isFileExcluded('src/index.ts')).toBe(false);
    expect(client.isFilePathAllowed('src/index.ts', 'read')).toBe(true);
    expect(client.isFilePathAllowed('/secrets/token.txt', 'read')).toBe(false);
    expect(client.isFilePathAllowed('./DOCKERFILE', 'write')).toBe(true);
    expect(client.isFilePathAllowed('/charts/values.yaml', 'write')).toBe(true);
    expect(client.isFilePathAllowed('Lifecycle.YAML', 'write')).toBe(true);
    expect(client.isFilePathAllowed('.github/workflows/test.yml', 'write')).toBe(true);
    expect(client.isFilePathAllowed('src/index.ts', 'write')).toBe(false);
  });

  it('denies unreferenced writes immediately when no write patterns are configured', () => {
    expect(client.isFileExcluded('src/index.ts')).toBe(false);
    expect(client.isFilePathAllowed('src/index.ts', 'write')).toBe(false);
  });

  it('extracts and deduplicates Dockerfiles, Helm value files, and relative chart paths', () => {
    const yaml = `
services:
  - name: api
    dockerfilePath: "services/api/Dockerfile"
    valueFiles:
      - values.yaml
      - 'helm/development.yaml' # environment values
    chart: './charts/api'
  - name: duplicate
    dockerfilePath: services/api/Dockerfile
    valueFiles:
      - values.yaml
    chart: charts/not-relative
`;

    expect(client.extractReferencedFilesFromYaml(yaml)).toEqual([
      'services/api/Dockerfile',
      'values.yaml',
      'helm/development.yaml',
      './charts/api',
    ]);
  });

  it('returns no references for unrelated YAML', () => {
    expect(client.extractReferencedFilesFromYaml('version: 1.0.0\nservices: []')).toEqual([]);
  });
});

describe('GitHub authorization errors', () => {
  it.each([
    [null, false],
    ['error', false],
    [{}, false],
    [{ status: 400 }, false],
    [{ status: 401 }, true],
    [{ status: 403 }, true],
  ])('classifies %p as authorization failure=%s', (error, expected) => {
    expect(isGitHubUserAuthorizationError(error)).toBe(expected);
  });

  it('carries the reconnect contract and auth provenance', () => {
    const auth = {
      provider: 'github' as const,
      source: 'none' as const,
      required: true,
      githubUsername: 'octocat',
    };
    const error = new GitHubUserAuthRequiredError(auth);

    expect(error.name).toBe('GitHubUserAuthRequiredError');
    expect(error.code).toBe('GITHUB_USER_AUTH_REQUIRED');
    expect(error.message).toContain('GitHub authorization is required');
    expect(error.auth).toBe(auth);
  });
});
