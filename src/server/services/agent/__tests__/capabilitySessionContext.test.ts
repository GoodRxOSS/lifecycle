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

const mockWarn = jest.fn();
const mockSessionFindOne = jest.fn();
const mockBuildFindOne = jest.fn();
const mockWithGraphFetched = jest.fn();
const mockParseYamlConfigFromBranch = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ warn: mockWarn })),
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({ findOne: mockSessionFindOne })),
  },
}));

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: mockBuildFindOne,
    })),
  },
}));

jest.mock('server/lib/yamlConfigParser', () => ({
  YamlConfigParser: jest.fn(() => ({ parseYamlConfigFromBranch: mockParseYamlConfigFromBranch })),
}));

import Build from 'server/models/Build';
import AgentSession from 'server/models/AgentSession';
import {
  loadLatestSession,
  resolveLifecycleDiagnosticGithubSafety,
  resolvePrimaryRepo,
} from '../capabilitySessionContext';

function session(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'session-1',
    buildUuid: null,
    workspaceRepos: [],
    selectedServices: [],
    ...overrides,
  } as any;
}

describe('capabilitySessionContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildFindOne.mockImplementation(() => ({ withGraphFetched: mockWithGraphFetched }));
    mockWithGraphFetched.mockResolvedValue(null);
    mockParseYamlConfigFromBranch.mockResolvedValue({ services: [] });
  });

  it('selects the primary workspace repository, then the first selected service, then omits the repo', () => {
    expect(
      resolvePrimaryRepo(
        session({
          workspaceRepos: [
            { repo: 'example/secondary', branch: 'main' },
            { repo: 'example/primary', branch: 'feature', primary: true },
          ],
          selectedServices: [{ repo: 'example/service', branch: 'main' }],
        })
      )
    ).toBe('example/primary');
    expect(resolvePrimaryRepo(session({ selectedServices: [{ repo: 'example/service', branch: 'main' }] }))).toBe(
      'example/service'
    );
    expect(resolvePrimaryRepo(session())).toBeUndefined();
  });

  it('normalizes and deduplicates writable and referenced files while preserving configuration exclusions', async () => {
    mockParseYamlConfigFromBranch.mockResolvedValue({
      services: [
        {
          github: {
            docker: {
              app: { dockerfilePath: '/services/api/Dockerfile' },
              init: { dockerfilePath: './docker/github-init.Dockerfile' },
            },
          },
          helm: {
            docker: {
              app: { dockerfilePath: '/docker/helm-app.Dockerfile' },
              init: { dockerfilePath: './docker/helm-init.Dockerfile' },
            },
            envMapping: {
              app: { path: './env/app.yaml' },
              init: { path: '/env/init.yaml' },
            },
            chart: { valueFiles: ['./values/base.yaml', 'values/base.yaml'] },
          },
        },
      ],
    });
    const currentSession = session({
      workspaceRepos: [{ repo: 'Example/API', branch: 'feature/api', primary: true }],
      selectedServices: [
        {
          repo: 'Example/API',
          branch: 'selected-branch',
          dockerfilePath: '/services/api/Dockerfile',
          initDockerfilePath: './services/api/init.Dockerfile',
          chartValueFiles: ['./deploy/values.yaml'],
        },
      ],
    });

    const result = await resolveLifecycleDiagnosticGithubSafety({
      session: currentSession,
      repoFullName: 'Example/API',
      config: {
        allowedWritePatterns: ['lifecycle.yaml', 'docs/**'],
        excludedFilePatterns: ['secrets/**'],
      } as any,
    });

    expect(mockParseYamlConfigFromBranch).toHaveBeenCalledWith('Example/API', 'feature/api');
    expect(result).toEqual({
      allowedBranch: 'feature/api',
      primaryRepoFullName: 'Example/API',
      allowedWritePatterns: ['lifecycle.yaml', 'lifecycle.yml', 'docs/**'],
      excludedFilePatterns: ['secrets/**'],
      referencedFiles: [
        'services/api/Dockerfile',
        'services/api/init.Dockerfile',
        'deploy/values.yaml',
        'docker/github-init.Dockerfile',
        'docker/helm-app.Dockerfile',
        'docker/helm-init.Dockerfile',
        'env/app.yaml',
        'env/init.yaml',
        'values/base.yaml',
      ],
      allowedNamespace: null,
      allowedRepos: ['example/api'],
      buildUuid: null,
      pullRequestId: null,
      allowedPullRequestNumber: null,
      databaseScope: null,
    });
    expect(Build.query).not.toHaveBeenCalled();
  });

  it('projects the authoritative build scope with normalized, deduplicated repositories', async () => {
    mockWithGraphFetched.mockResolvedValue({
      id: 101,
      uuid: 'build-1',
      namespace: 'env-api-123',
      environmentId: 77,
      pullRequestId: 55,
      pullRequest: {
        id: 44,
        pullRequestNumber: 321,
        fullName: 'Example/Fallback',
        repository: { id: 11, fullName: 'Example/API' },
      },
      deploys: [
        { repository: { id: 12, fullName: 'Example/Worker' } },
        { repository: { id: 11, fullName: 'EXAMPLE/API' } },
      ],
    });
    const currentSession = session({
      buildUuid: 'build-1',
      workspaceRepos: [{ repo: 'Example/API', branch: 'main', primary: true }],
      selectedServices: [{ repo: 'Example/Jobs', branch: 'main' }],
    });

    const result = await resolveLifecycleDiagnosticGithubSafety({ session: currentSession });

    expect(mockBuildFindOne).toHaveBeenCalledWith({ uuid: 'build-1' });
    expect(mockWithGraphFetched).toHaveBeenCalledWith('[pullRequest.repository, deploys.repository]');
    expect(result).toEqual(
      expect.objectContaining({
        allowedNamespace: 'env-api-123',
        allowedRepos: ['example/api', 'example/jobs', 'example/fallback', 'example/worker'],
        buildUuid: 'build-1',
        pullRequestId: 55,
        allowedPullRequestNumber: 321,
        databaseScope: {
          buildId: 101,
          buildUuid: 'build-1',
          pullRequestId: 55,
          environmentId: 77,
          repositoryIds: [11, 12],
        },
      })
    );
    expect(mockParseYamlConfigFromBranch).not.toHaveBeenCalled();
  });

  it('uses the related pull request id and nullable environment fields for legacy build rows', async () => {
    mockWithGraphFetched.mockResolvedValue({
      id: 101,
      uuid: 'build-legacy',
      namespace: null,
      environmentId: null,
      pullRequestId: null,
      pullRequest: {
        id: 44,
        pullRequestNumber: null,
        fullName: 'Example/API',
        repository: { id: 11, fullName: 'Example/API' },
      },
      deploys: [],
    });

    const result = await resolveLifecycleDiagnosticGithubSafety({
      session: session({ buildUuid: 'build-legacy' }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowedNamespace: null,
        pullRequestId: 44,
        allowedPullRequestNumber: null,
        databaseScope: {
          buildId: 101,
          buildUuid: 'build-legacy',
          pullRequestId: 44,
          environmentId: null,
          repositoryIds: [11],
        },
      })
    );
  });

  it('projects an authoritative scope for a PR-less API-created build', async () => {
    mockWithGraphFetched.mockResolvedValue({
      id: 102,
      uuid: 'build-api',
      triggerType: 'api',
      namespace: 'env-api-created',
      environmentId: 78,
      pullRequestId: null,
      pullRequest: null,
      deploys: [{ repository: { id: 12, fullName: 'Example/API' } }],
    });

    const result = await resolveLifecycleDiagnosticGithubSafety({
      session: session({ buildUuid: 'build-api' }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowedNamespace: 'env-api-created',
        allowedRepos: ['example/api'],
        buildUuid: 'build-api',
        pullRequestId: null,
        allowedPullRequestNumber: null,
        databaseScope: {
          buildId: 102,
          buildUuid: 'build-api',
          pullRequestId: null,
          environmentId: 78,
          repositoryIds: [12],
        },
      })
    );
    expect(mockParseYamlConfigFromBranch).not.toHaveBeenCalled();
  });

  it('keeps the session-derived safety scope when its build row no longer exists', async () => {
    mockWithGraphFetched.mockResolvedValue(null);

    const result = await resolveLifecycleDiagnosticGithubSafety({
      session: session({
        buildUuid: 'deleted-build',
        workspaceRepos: [{ repo: 'Example/API', branch: 'main', primary: true }],
      }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowedRepos: ['example/api'],
        buildUuid: 'deleted-build',
        databaseScope: null,
      })
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('keeps the session-derived scope and warns when build lookup fails', async () => {
    const lookupError = new Error('database unavailable');
    mockWithGraphFetched.mockRejectedValue(lookupError);

    const result = await resolveLifecycleDiagnosticGithubSafety({
      session: session({
        buildUuid: 'build-1',
        selectedServices: [{ repo: 'Example/API', branch: 'main' }],
      }),
    });

    expect(result.databaseScope).toBeNull();
    expect(result.allowedRepos).toEqual(['example/api']);
    expect(mockWarn).toHaveBeenCalledWith(
      { error: lookupError, buildUuid: 'build-1' },
      'AgentExec: lifecycle diagnostic build scope unavailable buildUuid=build-1'
    );
  });

  it('returns an omitted branch and skips lifecycle configuration loading when the session has no repository context', async () => {
    const result = await resolveLifecycleDiagnosticGithubSafety({
      session: session(),
      repoFullName: 'Example/API',
    });

    expect(result).toEqual({
      allowedBranch: null,
      primaryRepoFullName: 'Example/API',
      allowedWritePatterns: ['lifecycle.yaml', 'lifecycle.yml'],
      excludedFilePatterns: [],
      referencedFiles: [],
      allowedNamespace: null,
      allowedRepos: [],
      buildUuid: null,
      pullRequestId: null,
      allowedPullRequestNumber: null,
      databaseScope: null,
    });
    expect(mockParseYamlConfigFromBranch).not.toHaveBeenCalled();
    expect(Build.query).not.toHaveBeenCalled();
  });

  it('retains selected-deploy references and warns when lifecycle config loading fails', async () => {
    const configError = new Error('github unavailable');
    mockParseYamlConfigFromBranch.mockRejectedValue(configError);
    const currentSession = session({
      selectedServices: [
        {
          repo: 'Example/API',
          branch: 'main',
          dockerfilePath: 'Dockerfile',
          chartValueFiles: ['values.yaml'],
        },
      ],
    });

    const result = await resolveLifecycleDiagnosticGithubSafety({
      session: currentSession,
      repoFullName: 'Example/API',
    });

    expect(result.allowedBranch).toBe('main');
    expect(result.referencedFiles).toEqual(['Dockerfile', 'values.yaml']);
    expect(mockWarn).toHaveBeenCalledWith(
      { error: configError, repo: 'Example/API', branch: 'main' },
      'AgentExec: lifecycle config references unavailable repo=Example/API branch=main'
    );
  });

  it('loads the current session by uuid and rejects a missing session', async () => {
    const currentSession = session({ uuid: 'session-found' });
    mockSessionFindOne.mockResolvedValueOnce(currentSession).mockResolvedValueOnce(null);

    await expect(loadLatestSession('session-found')).resolves.toBe(currentSession);
    await expect(loadLatestSession('session-missing')).rejects.toThrow('Agent session not found');
    expect(mockSessionFindOne).toHaveBeenNthCalledWith(1, { uuid: 'session-found' });
    expect(mockSessionFindOne).toHaveBeenNthCalledWith(2, { uuid: 'session-missing' });
    expect(AgentSession.query).toHaveBeenCalledTimes(2);
  });
});
