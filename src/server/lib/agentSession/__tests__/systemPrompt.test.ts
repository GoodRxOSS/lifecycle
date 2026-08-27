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

jest.mock('server/models/AgentSession');
jest.mock('server/models/Build');
jest.mock('server/models/Deploy');
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: jest.fn(),
  getDeployingServicesByName: jest.fn(),
}));
const mockGetLabels = jest.fn();
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getLabels: (...args: unknown[]) => mockGetLabels(...args),
    })),
  },
}));
jest.mock('../triageDossier', () => ({
  buildTriageDossier: jest.fn(),
}));

import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';
import { buildTriageDossier } from '../triageDossier';
import {
  combineAgentSessionAppendSystemPrompt,
  formatEnvironmentBuildLine,
  formatEnvironmentPullRequestLine,
  formatEnvironmentServiceLine,
  formatStatusMessage,
  resolveAgentSessionPromptContext,
  resolveAgentSessionTriage,
} from '../systemPrompt';

describe('agent session system prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-04-30T12:00:00.000Z'));
    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
      findById: jest.fn().mockResolvedValue(null),
    });
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue(null),
      }),
    });
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue([]),
      }),
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(null);
    (getDeployingServicesByName as jest.Mock).mockReturnValue(undefined);
    mockGetLabels.mockResolvedValue({
      deploy: ['lifecycle-deploy!'],
      disabled: ['lifecycle-disabled!'],
    });
    (buildTriageDossier as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports an invalid lifecycle config when fetch throws', async () => {
    const buildGraphQuery = {
      withGraphFetched: jest.fn().mockResolvedValue({
        uuid: 'sample-build-1',
        status: 'build_failed',
        namespace: 'env-sample-123456',
        pullRequest: {
          fullName: 'example-org/example-repo',
          branchName: 'feature/sample',
          pullRequestNumber: 42,
          status: 'open',
          labels: [],
          deployOnUpdate: false,
          repository: { htmlUrl: 'https://github.com/example-org/example-repo' },
        },
        deploys: [],
      }),
    };
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue(buildGraphQuery),
    });
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ withGraphFetched: jest.fn().mockResolvedValue([]) }),
    });
    (fetchLifecycleConfig as jest.Mock).mockRejectedValue(new Error('invalid yaml'));

    const context = await resolveAgentSessionPromptContext({
      sessionDbId: 123,
      namespace: null,
      buildUuid: 'sample-build-1',
    });

    expect(context.lifecycleConfig).toEqual({ status: 'invalid', path: 'lifecycle.yaml' });
  });

  it('attaches the triage dossier to the resolved context for failing builds', async () => {
    const buildRow = {
      uuid: 'sample-build-1',
      status: 'build_failed',
      statusMessage: 'web build failed',
      namespace: 'env-sample-123456',
      pullRequest: null,
      deploys: [],
    };
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue({ withGraphFetched: jest.fn().mockResolvedValue(buildRow) }),
    });
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ withGraphFetched: jest.fn().mockResolvedValue([]) }),
    });
    (buildTriageDossier as jest.Mock).mockResolvedValue('## web — phase=build status=build_failed\n- evidence');

    const context = await resolveAgentSessionPromptContext({
      sessionDbId: 123,
      namespace: null,
      buildUuid: 'sample-build-1',
    });

    expect(buildTriageDossier).toHaveBeenCalledWith(buildRow, []);
    expect(context.triage).toBe('## web — phase=build status=build_failed\n- evidence');
  });

  it('degrades to a one-line triage note when the dossier build throws', async () => {
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue({
          uuid: 'sample-build-1',
          status: 'build_failed',
          pullRequest: null,
          deploys: [],
        }),
      }),
    });
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ withGraphFetched: jest.fn().mockResolvedValue([]) }),
    });
    (buildTriageDossier as jest.Mock).mockRejectedValue(new Error('k8s exploded'));

    const context = await resolveAgentSessionPromptContext({
      sessionDbId: 123,
      namespace: null,
      buildUuid: 'sample-build-1',
    });

    expect(context.triage).toBe('- triage: unavailable (k8s exploded)');
  });

  it('combines the configured and dynamic prompts with spacing', () => {
    expect(
      combineAgentSessionAppendSystemPrompt('Use concise responses.', 'Session context:\n- namespace: env-sample')
    ).toBe('Use concise responses.\n\nSession context:\n- namespace: env-sample');
  });

  it('normalizes optional prompt parts and omits an entirely blank prompt', () => {
    expect(combineAgentSessionAppendSystemPrompt('  configured only  ', '   ')).toBe('configured only');
    expect(combineAgentSessionAppendSystemPrompt(undefined, '  dynamic only  ')).toBe('dynamic only');
    expect(combineAgentSessionAppendSystemPrompt(' ', undefined)).toBeUndefined();
  });

  it('formats absent, short, and bounded status messages', () => {
    expect(formatStatusMessage(undefined)).toBe('<none>');
    expect(formatStatusMessage('ready')).toBe('ready');
    expect(formatStatusMessage('x'.repeat(401))).toBe(`${'x'.repeat(400)}…`);
  });

  it('formats the full service diagnostic contract', () => {
    expect(
      formatEnvironmentServiceLine(
        {
          name: 'web',
          deployUuid: 'deploy-1',
          active: false,
          status: 'failed',
          statusMessage: 'container exited',
          dependsOn: ['db', 'cache'],
          repo: 'example/web',
          branch: 'feature/test',
          serviceSha: 'abc123',
          dockerfilePath: 'Dockerfile',
          initDockerfilePath: 'Dockerfile.init',
          deployableType: 'docker',
          source: 'git',
          chartName: 'web-chart',
          chartRepoUrl: 'https://charts.example.com',
          chartValueFiles: ['values.yaml', 'values.dev.yaml'],
          publicUrl: 'https://web.example.com',
          dockerImage: 'registry.example.com/web:abc123',
          buildPipelineId: 'build-1',
          deployPipelineId: 'deploy-pipeline-1',
          workspacePath: '/workspace/web',
          workDir: '/workspace/web/apps/web',
        },
        'full'
      )
    ).toBe(
      '- web: deployUuid=deploy-1, active=false, status=failed, statusMessage=container exited, ' +
        'dependsOn=db|cache, repo=example/web, branch=feature/test, serviceSha=abc123, ' +
        'dockerfilePath=Dockerfile, initDockerfilePath=Dockerfile.init, type=docker, source=git, ' +
        'chartName=web-chart, chartRepoUrl=https://charts.example.com, ' +
        'chartValueFiles=values.yaml|values.dev.yaml, publicUrl=https://web.example.com, ' +
        'dockerImage=registry.example.com/web:abc123, buildPipelineId=build-1, ' +
        'deployPipelineId=deploy-pipeline-1, workspacePath=/workspace/web, workDir=/workspace/web/apps/web'
    );
  });

  it('keeps healthy roster lines lean but exposes dependencies for unhealthy services', () => {
    const healthy = {
      name: 'web',
      status: 'deployed',
      dependsOn: ['db'],
      serviceSha: 'abc123',
      workspacePath: '/workspace/web',
    };

    expect(formatEnvironmentServiceLine(healthy, 'roster')).toBe('- web: status=deployed, statusMessage=<none>');
    expect(formatEnvironmentServiceLine({ ...healthy, status: 'failed' }, 'roster')).toBe(
      '- web: status=failed, statusMessage=<none>, dependsOn=db'
    );
  });

  it('formats build and pull-request snapshots with explicit unknown and empty values', () => {
    expect(
      formatEnvironmentBuildLine({
        uuid: 'build-1',
        status: 'ready',
        statusMessage: 'done',
        namespace: 'env-build-1',
        sha: 'abc123',
      })
    ).toBe('- build=build-1: status=ready, statusMessage=done, namespace=env-build-1, sha=abc123');
    expect(formatEnvironmentBuildLine({ uuid: 'build-2' })).toBe('- build=build-2: statusMessage=<none>');

    expect(formatEnvironmentPullRequestLine({})).toBe(
      '- labels=<unknown>, deployOnUpdate=<unknown>, deployLabels=<unknown>, disabledLabels=<unknown>'
    );
    expect(
      formatEnvironmentPullRequestLine({
        fullName: 'example/web',
        branchName: 'feature/test',
        pullRequestNumber: 0,
        url: 'https://github.com/example/web/pull/0',
        status: 'open',
        labels: [],
        deployOnUpdate: false,
        deployLabels: ['deploy'],
        disabledLabels: [],
        latestCommit: 'abc123',
        repositoryUrl: 'https://github.com/example/web',
      })
    ).toBe(
      '- repo=example/web, branch=feature/test, number=0, url=https://github.com/example/web/pull/0, ' +
        'status=open, labels=<none>, deployOnUpdate=false, deployLabels=deploy, disabledLabels=<none>, ' +
        'latestCommit=abc123, repositoryUrl=https://github.com/example/web'
    );
  });

  it('returns no triage without a build UUID or when the build is missing', async () => {
    await expect(resolveAgentSessionTriage('   ')).resolves.toBeNull();
    expect(Build.query).not.toHaveBeenCalled();

    await expect(resolveAgentSessionTriage('missing-build')).resolves.toBeNull();
    expect(Build.query).toHaveBeenCalledTimes(1);
    expect(buildTriageDossier).not.toHaveBeenCalled();
  });

  it('returns a standalone triage dossier and degrades thrown values safely', async () => {
    const build = { uuid: 'build-1', deploys: undefined };
    const withGraphFetched = jest.fn().mockResolvedValue(build);
    const findOne = jest.fn().mockReturnValue({ withGraphFetched });
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({ findOne });
    (buildTriageDossier as jest.Mock).mockResolvedValueOnce('triage evidence');

    await expect(resolveAgentSessionTriage('  build-1  ')).resolves.toBe('triage evidence');
    expect(findOne).toHaveBeenCalledWith({ uuid: 'build-1' });
    expect(withGraphFetched).toHaveBeenCalledWith('[deploys.[deployable]]');
    expect(buildTriageDossier).toHaveBeenCalledWith(build, []);

    (buildTriageDossier as jest.Mock).mockRejectedValueOnce('not-an-error');
    await expect(resolveAgentSessionTriage('build-1')).resolves.toBe('- triage: unavailable (unknown error)');
  });

  it('resolves an empty prompt context without querying for a build', async () => {
    await expect(
      resolveAgentSessionPromptContext({
        sessionDbId: 123,
        namespace: undefined,
        buildUuid: null,
      })
    ).resolves.toEqual({
      namespace: undefined,
      buildUuid: null,
      gatheredAt: '2026-04-30T12:00:00.000Z',
      build: undefined,
      pullRequest: undefined,
      services: [],
      userSelectedServices: false,
      diagnosticServices: [],
    });
    expect(Build.query).not.toHaveBeenCalled();
    expect(fetchLifecycleConfig).not.toHaveBeenCalled();
    expect(buildTriageDossier).not.toHaveBeenCalled();
  });

  it('normalizes the full selected-service snapshot and uses workspacePath as the workDir fallback', async () => {
    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        selectedServices: [
          {
            name: 'web',
            deployId: 7,
            repo: '  example/web  ',
            branch: '  feature/test  ',
            deployUuid: '  deploy-7  ',
            revision: '  abc123  ',
            dockerfilePath: '  Dockerfile  ',
            initDockerfilePath: '  Dockerfile.init  ',
            deployableType: '  docker  ',
            source: '  git  ',
            deployStatus: '  running  ',
            deployStatusMessage: '  healthy  ',
            dockerImage: '  registry.example.com/web:abc123  ',
            buildPipelineId: '  build-7  ',
            deployPipelineId: '  deploy-pipeline-7  ',
            chartName: '  web-chart  ',
            chartRepoUrl: '  https://charts.example.com  ',
            chartValueFiles: [' values.yaml ', '', 42, ' values.dev.yaml '],
            workspacePath: '  /workspace/web  ',
            workDir: '  ',
          },
        ],
      }),
    });
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue([
          {
            id: 7,
            active: true,
            publicUrl: 'http://web.example.com',
            deployable: { deploymentDependsOn: ['web', ' db ', '', 42, 'cache'] },
          },
        ]),
      }),
    });

    const context = await resolveAgentSessionPromptContext({ sessionDbId: 123, buildUuid: null });

    expect(context.services).toEqual([
      {
        name: 'web',
        active: true,
        publicUrl: 'http://web.example.com',
        repo: 'example/web',
        branch: 'feature/test',
        dependsOn: ['db', 'cache'],
        deployUuid: 'deploy-7',
        serviceSha: 'abc123',
        dockerfilePath: 'Dockerfile',
        initDockerfilePath: 'Dockerfile.init',
        deployableType: 'docker',
        source: 'git',
        status: 'running',
        statusMessage: 'healthy',
        dockerImage: 'registry.example.com/web:abc123',
        buildPipelineId: 'build-7',
        deployPipelineId: 'deploy-pipeline-7',
        chartName: 'web-chart',
        chartRepoUrl: 'https://charts.example.com',
        chartValueFiles: ['values.yaml', 'values.dev.yaml'],
        workspacePath: '/workspace/web',
        workDir: '/workspace/web',
      },
    ]);
    expect(context.selectedDeploy).toEqual(context.services[0]);
    expect(context.userSelectedServices).toBe(true);
  });

  it('filters unnamed attached deploys and does not invent a selected deploy', async () => {
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        withGraphFetched: jest
          .fn()
          .mockResolvedValue([{ id: null, uuid: ' ', deployable: { name: ' ' }, repository: null }]),
      }),
    });

    const context = await resolveAgentSessionPromptContext({ sessionDbId: 123, buildUuid: null });

    expect(context.services).toEqual([]);
    expect(context.userSelectedServices).toBe(true);
    expect(context).not.toHaveProperty('selectedDeploy');
  });

  it('reports missing lifecycle config and tolerates unavailable label config and malformed diagnostic deploys', async () => {
    const build = {
      uuid: 'build-1',
      status: 'pending',
      pullRequest: {
        fullName: 'example/web',
        branchName: 'feature/test',
        pullRequestNumber: undefined,
        labels: 'not-an-array',
      },
      deploys: [{ uuid: ' ', deployable: { name: ' ' } }],
    };
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue(build),
      }),
    });
    mockGetLabels.mockRejectedValueOnce(new Error('config unavailable'));
    (fetchLifecycleConfig as jest.Mock).mockResolvedValueOnce(null);

    const context = await resolveAgentSessionPromptContext({
      sessionDbId: 123,
      buildUuid: 'build-1',
      includeTriage: false,
    });

    expect(context.lifecycleConfig).toEqual({ status: 'missing', path: 'lifecycle.yaml' });
    expect(context.pullRequest).toEqual(
      expect.objectContaining({
        url: undefined,
        labels: undefined,
        deployLabels: undefined,
        disabledLabels: undefined,
      })
    );
    expect(context.diagnosticServices).toEqual([]);
    expect(buildTriageDossier).not.toHaveBeenCalled();
  });

  it('keeps attached deploy context when lifecycle config lookup fails', async () => {
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue([
          {
            id: 9,
            uuid: 'worker-deploy-9',
            publicUrl: '   ',
            branchName: 'feature/test',
            deployable: { name: 'worker', deploymentDependsOn: [] },
            repository: { fullName: 'example/worker' },
          },
        ]),
      }),
    });
    (fetchLifecycleConfig as jest.Mock).mockRejectedValueOnce(new Error('GitHub unavailable'));

    const context = await resolveAgentSessionPromptContext({ sessionDbId: 123, buildUuid: null });

    expect(context.services).toEqual([
      expect.objectContaining({
        name: 'worker',
        deployUuid: 'worker-deploy-9',
        publicUrl: undefined,
        repo: 'example/worker',
        branch: 'feature/test',
        workDir: undefined,
      }),
    ]);
    expect(getDeployingServicesByName).not.toHaveBeenCalled();
  });

  it('resolves selected service public URLs and workdirs from deploy and lifecycle config metadata', async () => {
    const buildGraphQuery = {
      withGraphFetched: jest.fn().mockResolvedValue({
        uuid: 'sample-123456',
        status: 'ready',
        statusMessage: 'ready',
        namespace: 'env-sample-123456',
        pullRequest: {
          fullName: 'example-org/example-repo',
          branchName: 'feature/sample',
          pullRequestNumber: 42,
          status: 'open',
          labels: ['lifecycle-deploy'],
          deployOnUpdate: true,
          latestCommit: 'abc123',
          repository: {
            htmlUrl: 'https://github.com/example-org/example-repo',
          },
        },
        deploys: [],
      }),
    };
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue(buildGraphQuery),
    });

    const deployGraphQuery = {
      withGraphFetched: jest.fn().mockResolvedValue([
        {
          uuid: 'next-web-sample-123456',
          active: true,
          branchName: 'feature/sample',
          publicUrl: 'next-web-sample.lifecycle.dev.example.com',
          deployable: { name: 'next-web' },
          repository: { fullName: 'example-org/example-repo' },
          service: null,
        },
      ]),
    };
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(deployGraphQuery),
    });

    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({
      services: [{ name: 'next-web', dev: { workDir: '/workspace/apps/next-web' } }],
    });
    (getDeployingServicesByName as jest.Mock).mockReturnValue({
      name: 'next-web',
      dev: { workDir: '/workspace/apps/next-web' },
    });

    await expect(
      resolveAgentSessionPromptContext({
        sessionDbId: 123,
        namespace: 'env-sample-123456',
        buildUuid: 'sample-123456',
      })
    ).resolves.toEqual({
      namespace: 'env-sample-123456',
      buildUuid: 'sample-123456',
      gatheredAt: '2026-04-30T12:00:00.000Z',
      build: {
        uuid: 'sample-123456',
        status: 'ready',
        statusMessage: 'ready',
        namespace: 'env-sample-123456',
        sha: undefined,
      },
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 42,
        url: 'https://github.com/example-org/example-repo/pull/42',
        status: 'open',
        labels: ['lifecycle-deploy'],
        deployOnUpdate: true,
        deployLabels: ['lifecycle-deploy!'],
        disabledLabels: ['lifecycle-disabled!'],
        latestCommit: 'abc123',
        repositoryUrl: 'https://github.com/example-org/example-repo',
      },
      lifecycleConfig: {
        status: 'present',
        path: 'lifecycle.yaml',
        declaredServices: ['next-web'],
      },
      services: [
        {
          name: 'next-web',
          active: true,
          deployUuid: 'next-web-sample-123456',
          status: undefined,
          statusMessage: undefined,
          publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
          dockerImage: undefined,
          buildPipelineId: undefined,
          deployPipelineId: undefined,
          workDir: '/workspace/apps/next-web',
        },
      ],
      userSelectedServices: true,
      selectedDeploy: {
        name: 'next-web',
        active: true,
        deployUuid: 'next-web-sample-123456',
        status: undefined,
        statusMessage: undefined,
        publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
        repo: 'example-org/example-repo',
        branch: 'feature/sample',
        dockerImage: undefined,
        buildPipelineId: undefined,
        deployPipelineId: undefined,
        workDir: '/workspace/apps/next-web',
      },
      diagnosticServices: [],
    });

    expect(fetchLifecycleConfig).toHaveBeenCalledWith('example-org/example-repo', 'feature/sample');
    expect(getDeployingServicesByName).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.any(Array),
      }),
      'next-web'
    );
  });

  it('resolves build-context chat diagnostics without a workspace namespace', async () => {
    const buildGraphQuery = {
      withGraphFetched: jest.fn().mockResolvedValue({
        uuid: 'sample-build-1',
        status: 'pending',
        statusMessage: '',
        namespace: 'env-sample-123456',
        sha: 'abc123',
        pullRequest: {
          fullName: 'example-org/example-repo',
          branchName: 'feature/sample',
          pullRequestNumber: 42,
          status: 'open',
          labels: [],
          deployOnUpdate: false,
          latestCommit: 'abc123',
          repository: {
            htmlUrl: 'https://github.com/example-org/example-repo',
          },
        },
        deploys: [
          {
            id: 10,
            uuid: 'next-web-deploy-1',
            active: false,
            status: 'pending',
            statusMessage: null,
            branchName: 'feature/sample',
            publicUrl: 'next-web-sample.lifecycle.dev.example.com',
            dockerImage: 'registry.example.test/next-web:abc123',
            buildPipelineId: 'build-pipeline-1',
            deployPipelineId: 'deploy-pipeline-1',
            deployable: { name: 'next-web' },
            repository: { fullName: 'example-org/example-repo' },
            service: null,
          },
        ],
      }),
    };
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue(buildGraphQuery),
    });

    const deployGraphQuery = {
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(deployGraphQuery),
    });

    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({
      services: [{ name: 'next-web', dev: { workDir: '/workspace/apps/next-web' } }],
    });
    (getDeployingServicesByName as jest.Mock).mockReturnValue({
      name: 'next-web',
      dev: { workDir: '/workspace/apps/next-web' },
    });

    await expect(
      resolveAgentSessionPromptContext({
        sessionDbId: 123,
        namespace: null,
        buildUuid: 'sample-build-1',
      })
    ).resolves.toEqual({
      namespace: null,
      buildUuid: 'sample-build-1',
      gatheredAt: '2026-04-30T12:00:00.000Z',
      build: {
        uuid: 'sample-build-1',
        status: 'pending',
        statusMessage: undefined,
        namespace: 'env-sample-123456',
        sha: 'abc123',
      },
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 42,
        url: 'https://github.com/example-org/example-repo/pull/42',
        status: 'open',
        labels: [],
        deployOnUpdate: false,
        deployLabels: ['lifecycle-deploy!'],
        disabledLabels: ['lifecycle-disabled!'],
        latestCommit: 'abc123',
        repositoryUrl: 'https://github.com/example-org/example-repo',
      },
      lifecycleConfig: {
        status: 'present',
        path: 'lifecycle.yaml',
        declaredServices: ['next-web'],
      },
      services: [
        {
          name: 'next-web',
          active: false,
          deployUuid: 'next-web-deploy-1',
          status: 'pending',
          statusMessage: undefined,
          publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
          dockerImage: 'registry.example.test/next-web:abc123',
          buildPipelineId: 'build-pipeline-1',
          deployPipelineId: 'deploy-pipeline-1',
          workDir: '/workspace/apps/next-web',
        },
      ],
      userSelectedServices: false,
      diagnosticServices: [
        {
          name: 'next-web',
          active: false,
          deployUuid: 'next-web-deploy-1',
          status: 'pending',
          statusMessage: undefined,
          publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
          dockerImage: 'registry.example.test/next-web:abc123',
          buildPipelineId: 'build-pipeline-1',
          deployPipelineId: 'deploy-pipeline-1',
        },
      ],
    });

    expect(buildGraphQuery.withGraphFetched).toHaveBeenCalledWith(
      '[pullRequest.[repository], deploys.[deployable, repository]]'
    );
  });
});
