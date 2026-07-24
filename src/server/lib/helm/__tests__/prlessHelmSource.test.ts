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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

const mockRepositoryWhereNull = jest.fn();
const mockRepositoryFindOne = jest.fn(() => ({ whereNull: mockRepositoryWhereNull }));

jest.mock('server/lib/envVariables', () => ({
  EnvironmentVariables: class {},
}));
jest.mock('server/services/globalConfig');
jest.mock('server/models', () => ({
  Repository: { query: jest.fn(() => ({ findOne: mockRepositoryFindOne })) },
}));

import { constructHelmDeploysBuildMetaData } from 'server/lib/helm';
import { ingressBannerSnippet } from 'server/lib/helm/utils';

afterEach(() => jest.clearAllMocks());

describe('constructHelmDeploysBuildMetaData for PR-less builds', () => {
  it('resolves branch, repository, and pinned sha from the build source seam', async () => {
    mockRepositoryWhereNull.mockResolvedValue({ fullName: 'org/repo' });
    const deploys = [
      {
        build: {
          uuid: 'api-env-123456',
          pullRequest: null,
          branchName: 'feat/x',
          githubRepositoryId: 123,
          configSha: 'abc',
        },
      },
    ] as any;

    const metadata = await constructHelmDeploysBuildMetaData(deploys);

    expect(metadata).toEqual({
      uuid: 'api-env-123456',
      branchName: 'feat/x',
      fullName: 'org/repo',
      sha: 'abc',
      error: '',
    });
    expect(mockRepositoryFindOne).toHaveBeenCalledWith({ githubRepositoryId: 123 });
    expect(mockRepositoryWhereNull).toHaveBeenCalledWith('deletedAt');
  });

  it('tracks the branch tip with a null sha when no configSha is pinned', async () => {
    mockRepositoryWhereNull.mockResolvedValue({ fullName: 'org/repo' });
    const deploys = [
      {
        build: {
          uuid: 'api-env-123456',
          pullRequest: null,
          branchName: 'main',
          githubRepositoryId: 123,
          configSha: null,
        },
      },
    ] as any;

    const metadata = await constructHelmDeploysBuildMetaData(deploys);

    expect(metadata).toMatchObject({ uuid: 'api-env-123456', branchName: 'main', fullName: 'org/repo', error: '' });
    expect(metadata.sha).toBeNull();
    expect(mockRepositoryWhereNull).toHaveBeenCalledWith('deletedAt');
  });
});

describe('ingressBannerSnippet for PR-less builds', () => {
  it('renders the banner without PR items and without throwing', () => {
    const deploy = {
      build: { uuid: 'api-env-123456', pullRequest: null },
      sha: 'abc',
      branchName: 'feat/x',
      buildLogs: 'https://logs.example/1',
      deployable: { name: 'app' },
    } as any;

    const result = ingressBannerSnippet(deploy);

    const snippet = result.metadata.annotations['nginx.ingress.kubernetes.io/configuration-snippet'];
    expect(snippet).toContain('api-env-123456');
    expect(snippet).toContain('abc');
    expect(snippet).toContain('feat/x');
    expect(snippet).not.toContain('PR Owner');
  });
});
