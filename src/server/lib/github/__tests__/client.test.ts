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

jest.mock('p-queue', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    add: (task: () => Promise<unknown>) => task(),
  })),
}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('shared/config', () => ({
  APP_AUTH: {
    appId: 123,
    privateKey: 'private-key',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  },
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));
jest.mock('server/lib/github/utils', () => ({
  constructOctokitClient: jest.fn(),
  constructClientRequestData: jest.fn(),
  getAppToken: jest.fn(),
}));
jest.mock('server/lib/metrics', () => ({ Metrics: jest.fn() }));

import { createAppAuth } from '@octokit/auth-app';
import { APP_AUTH } from 'shared/config';
import { createOctokitClient } from 'server/lib/github/client';
import { constructClientRequestData, constructOctokitClient, getAppToken } from 'server/lib/github/utils';
import { Metrics } from 'server/lib/metrics';
import GlobalConfigService from 'server/services/globalConfig';

const mockGetGithubClientToken = jest.fn();
const mockAppAuth = jest.fn();
const mockOctokitRequest = jest.fn();
const mockPaginate = jest.fn();
const mockMetricEvent = jest.fn();
const mockMetricIncrement = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGithubClientToken.mockResolvedValue('global-token');
  (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
    getGithubClientToken: mockGetGithubClientToken,
  });
  (createAppAuth as jest.Mock).mockReturnValue(mockAppAuth);
  (getAppToken as jest.Mock).mockResolvedValue('installation-token');
  (constructOctokitClient as jest.Mock).mockReturnValue({
    request: mockOctokitRequest,
    paginate: mockPaginate,
  });
  (constructClientRequestData as jest.Mock).mockReturnValue({
    rateLimit: { used: '7', limit: '5000' },
  });
  mockMetricIncrement.mockReturnValue({ event: mockMetricEvent });
  (Metrics as jest.Mock).mockReturnValue({ increment: mockMetricIncrement });
});

describe('createOctokitClient token selection', () => {
  it('uses the global GitHub token when no credential is supplied', async () => {
    const result = await createOctokitClient();

    expect(mockGetGithubClientToken).toHaveBeenCalledTimes(1);
    expect(createAppAuth).not.toHaveBeenCalled();
    expect(getAppToken).not.toHaveBeenCalled();
    expect(constructOctokitClient).toHaveBeenCalledWith({ token: 'global-token' });
    expect(Metrics).toHaveBeenCalledWith('github.api.rate_limit', { caller: '' });
    expect(result).toMatchObject({ accessToken: 'global-token', paginate: mockPaginate });
    expect(result.request).not.toBe(mockOctokitRequest);
  });

  it('gives an explicit access token precedence over installation and global credentials', async () => {
    const result = await createOctokitClient({
      accessToken: 'explicit-token',
      installationId: 456,
      caller: 'deployments',
    });

    expect(result.accessToken).toBe('explicit-token');
    expect(createAppAuth).not.toHaveBeenCalled();
    expect(getAppToken).not.toHaveBeenCalled();
    expect(mockGetGithubClientToken).not.toHaveBeenCalled();
    expect(constructOctokitClient).toHaveBeenCalledWith({ token: 'explicit-token' });
    expect(Metrics).toHaveBeenCalledWith('github.api.rate_limit', { caller: 'deployments' });
  });

  it('creates an app-auth installation token when only an installation id is supplied', async () => {
    const result = await createOctokitClient({ installationId: 456, caller: 'repository-read' });

    expect(createAppAuth).toHaveBeenCalledWith(APP_AUTH);
    expect(getAppToken).toHaveBeenCalledWith({ installationId: 456, app: mockAppAuth });
    expect(mockGetGithubClientToken).not.toHaveBeenCalled();
    expect(constructOctokitClient).toHaveBeenCalledWith({ token: 'installation-token' });
    expect(result.accessToken).toBe('installation-token');
  });

  it('falls back to the global token when app auth returns no installation token', async () => {
    (getAppToken as jest.Mock).mockResolvedValueOnce(undefined);

    const result = await createOctokitClient({ installationId: 456 });

    expect(mockGetGithubClientToken).toHaveBeenCalledTimes(1);
    expect(constructOctokitClient).toHaveBeenCalledWith({ token: 'global-token' });
    expect(result.accessToken).toBe('global-token');
  });

  it('propagates installation-auth failures without trying another credential source', async () => {
    const error = new Error('installation auth failed');
    (getAppToken as jest.Mock).mockRejectedValueOnce(error);

    await expect(createOctokitClient({ installationId: 456 })).rejects.toBe(error);

    expect(mockGetGithubClientToken).not.toHaveBeenCalled();
    expect(constructOctokitClient).not.toHaveBeenCalled();
    expect(Metrics).not.toHaveBeenCalled();
  });

  it('propagates global-token failures before constructing a client', async () => {
    const error = new Error('global token unavailable');
    mockGetGithubClientToken.mockRejectedValueOnce(error);

    await expect(createOctokitClient()).rejects.toBe(error);

    expect(constructOctokitClient).not.toHaveBeenCalled();
    expect(Metrics).not.toHaveBeenCalled();
  });
});

describe('wrapped request behavior', () => {
  it('passes a GitHub request through and records its transformed rate-limit insights', async () => {
    const response = {
      data: { id: 42, full_name: 'goodrx/lifecycle' },
      headers: { 'x-ratelimit-used': '7', 'x-ratelimit-limit': '5000' },
    };
    const options = {
      owner: 'goodrx',
      repo: 'lifecycle',
      headers: { accept: 'application/vnd.github+json' },
    };
    mockOctokitRequest.mockResolvedValueOnce(response);
    const octokit = await createOctokitClient({ accessToken: 'token', caller: 'repository-read' });

    await expect(octokit.request('GET /repos/{owner}/{repo}', options)).resolves.toBe(response);

    expect(mockOctokitRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}', options);
    expect(constructClientRequestData).toHaveBeenCalledWith(response, 'GET /repos/{owner}/{repo}', 'repository-read');
    expect(mockMetricIncrement).toHaveBeenCalledWith('request', { used: '7', limit: '5000' });
    expect(mockMetricEvent).toHaveBeenCalledWith(
      'Github api request made',
      'Github api request made by repository-read'
    );
  });

  it('supplies default request options and records absent rate-limit header values', async () => {
    const response = { data: [] };
    mockOctokitRequest.mockResolvedValueOnce(response);
    (constructClientRequestData as jest.Mock).mockReturnValueOnce({ rateLimit: {} });
    const octokit = await createOctokitClient({ accessToken: 'token' });

    await expect(octokit.request('GET /rate_limit')).resolves.toBe(response);

    expect(mockOctokitRequest).toHaveBeenCalledWith('GET /rate_limit', {});
    expect(mockMetricIncrement).toHaveBeenCalledWith('request', { used: undefined, limit: undefined });
    expect(mockMetricEvent).toHaveBeenCalledWith('Github api request made', 'Github api request made by ');
  });

  it('propagates an upstream request failure without emitting success metrics', async () => {
    const error = new Error('GitHub unavailable');
    mockOctokitRequest.mockRejectedValueOnce(error);
    const octokit = await createOctokitClient({ accessToken: 'token', caller: 'repository-read' });

    await expect(octokit.request('GET /repos/{owner}/{repo}', { owner: 'goodrx', repo: 'lifecycle' })).rejects.toBe(
      error
    );

    expect(constructClientRequestData).not.toHaveBeenCalled();
    expect(mockMetricIncrement).not.toHaveBeenCalled();
    expect(mockMetricEvent).not.toHaveBeenCalled();
  });
});
