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
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getLabels: jest.fn().mockResolvedValue({
        deploy: ['lifecycle-deploy!'],
        disabled: ['lifecycle-disabled!'],
      }),
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
import { combineAgentSessionAppendSystemPrompt, resolveAgentSessionPromptContext } from '../systemPrompt';

describe('agent session system prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-04-30T12:00:00.000Z'));
    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
      findById: jest.fn().mockResolvedValue(null),
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
      '[pullRequest.[repository], deploys.[deployable, repository, service]]'
    );
  });
});
