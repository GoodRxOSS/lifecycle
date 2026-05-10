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

import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';
import {
  buildAgentSessionDynamicSystemPrompt,
  combineAgentSessionAppendSystemPrompt,
  resolveAgentSessionPromptContext,
} from '../systemPrompt';

describe('agent session system prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-04-30T12:00:00.000Z'));
    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
      findById: jest.fn().mockResolvedValue(null),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('builds a compact dynamic session context prompt', () => {
    expect(
      buildAgentSessionDynamicSystemPrompt({
        namespace: 'env-sample-123456',
        buildUuid: 'sample-123456',
        skillsAvailable: true,
        toolLines: [
          '- inspect files, services, and git state: mcp__sandbox__workspace_read_file, mcp__sandbox__workspace_exec',
          '- run mutating or networked shell commands that are not direct file edits: mcp__sandbox__workspace_exec_mutation',
        ],
        services: [
          {
            name: 'next-web',
            publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
            workDir: '/workspace/apps/next-web',
          },
        ],
      })
    ).toBe(
      [
        'Initial Lifecycle snapshot:',
        '- namespace: env-sample-123456',
        '- buildUuid: sample-123456',
        'Selected services:',
        '- next-web: publicUrl=https://next-web-sample.lifecycle.dev.example.com, workDir=/workspace/apps/next-web',
        '- equipped skills: use skills.list to discover them and skills.learn to load a skill before using it',
        '- equipped tools:',
        '  - inspect files, services, and git state: mcp__sandbox__workspace_read_file, mcp__sandbox__workspace_exec',
        '  - run mutating or networked shell commands that are not direct file edits: mcp__sandbox__workspace_exec_mutation',
      ].join('\n')
    );
  });

  it('combines the configured and dynamic prompts with spacing', () => {
    expect(
      combineAgentSessionAppendSystemPrompt('Use concise responses.', 'Session context:\n- namespace: env-sample')
    ).toBe('Use concise responses.\n\nSession context:\n- namespace: env-sample');
  });

  it('builds diagnostic prompt sections for build-context chats without sensitive legacy fields', () => {
    const prompt = buildAgentSessionDynamicSystemPrompt({
      buildUuid: 'sample-build-1',
      gatheredAt: '2026-04-30T12:00:00.000Z',
      build: {
        uuid: 'sample-build-1',
        status: 'deploy_failed',
        statusMessage: 'web deploy failed',
        namespace: 'env-sample-123456',
        sha: 'abc123',
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
      services: [],
      diagnosticServices: [
        {
          name: 'next-web',
          deployUuid: 'next-web-deploy-1',
          active: true,
          status: 'deploy_failed',
          statusMessage: 'CrashLoopBackOff',
          publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
          dockerImage: 'registry.example.test/next-web:abc123',
          buildPipelineId: 'build-pipeline-1',
          deployPipelineId: 'deploy-pipeline-1',
        },
      ],
    });

    expect(prompt).not.toContain('Lifecycle debugging profile:');
    expect(prompt).not.toContain('explicitly asks to continue into repair');
    expect(prompt).toContain('Initial Lifecycle snapshot:');
    expect(prompt).toContain(
      '- build=sample-build-1: buildStatusAtStart=deploy_failed, buildStatusMessageAtStart=web deploy failed, namespace=env-sample-123456, sha=abc123'
    );
    expect(prompt).toContain('Pull request:');
    expect(prompt).toContain(
      '- repo=example-org/example-repo, branch=feature/sample, number=42, url=https://github.com/example-org/example-repo/pull/42, statusAtStart=open, labelsAtStart=lifecycle-deploy, deployOnUpdateAtStart=true, deployLabels=lifecycle-deploy!, disabledLabels=lifecycle-disabled!, latestCommit=abc123, repositoryUrl=https://github.com/example-org/example-repo'
    );
    expect(prompt).toContain('Deploy roster:');
    expect(prompt).toContain(
      '- next-web: deployUuid=next-web-deploy-1, activeAtStart=true, statusAtStart=deploy_failed, statusMessageAtStart=CrashLoopBackOff, repo=example-org/example-repo, branch=feature/sample, publicUrl=https://next-web-sample.lifecycle.dev.example.com, dockerImage=registry.example.test/next-web:abc123, buildPipelineId=build-pipeline-1, deployPipelineId=deploy-pipeline-1'
    );
    expect(prompt).toContain('- observedAt: 2026-04-30T12:00:00.000Z');
    expect(prompt).toContain('- source: lifecycle_db');
    expect(prompt).not.toContain('secret');
    expect(prompt).not.toContain('MCP token');
    expect(prompt).not.toContain('conversation_messages');
    expect(prompt).not.toContain('server/services/ai/context');
    expect(prompt).not.toContain('server/services/ai/prompts');
  });

  it('renders selected deploy facts once without reasoning guidance', () => {
    const prompt = buildAgentSessionDynamicSystemPrompt({
      buildUuid: 'sample-build-1',
      gatheredAt: '2026-04-30T12:00:00.000Z',
      services: [
        {
          name: 'sample-service',
          deployUuid: 'deploy-1',
          active: false,
          status: 'build_failed',
          statusMessage: 'Dockerfile not found',
          repo: 'example-org/service-repo',
          branch: 'feature/service-change',
          serviceSha: 'service-sha-1',
          dockerfilePath: 'services/sample/Dockerfile',
          initDockerfilePath: 'services/sample/init.Dockerfile',
          deployableType: 'docker',
          source: 'yaml',
        },
      ],
      selectedDeploy: {
        name: 'sample-service',
        deployUuid: 'deploy-1',
        active: false,
        status: 'build_failed',
        statusMessage: 'Dockerfile not found',
        repo: 'example-org/service-repo',
        branch: 'feature/service-change',
        serviceSha: 'service-sha-1',
        dockerfilePath: 'services/sample/Dockerfile',
        initDockerfilePath: 'services/sample/init.Dockerfile',
        deployableType: 'docker',
        source: 'yaml',
      },
    });

    expect(prompt).toContain('Selected deploy:');
    expect(prompt).toContain(
      '- sample-service: deployUuid=deploy-1, activeAtStart=false, statusAtStart=build_failed, statusMessageAtStart=Dockerfile not found, repo=example-org/service-repo, branch=feature/service-change, serviceSha=service-sha-1, dockerfilePath=services/sample/Dockerfile'
    );
    expect(prompt.match(/deployUuid=deploy-1/g)).toHaveLength(1);
    expect(prompt).not.toContain('Selected services:');
    expect(prompt).not.toContain('Fresh repository reads:');
    expect(prompt).not.toContain('Mismatch handling:');
  });

  it('renders deploy-gated pending builds as an explicit initial snapshot', () => {
    const prompt = buildAgentSessionDynamicSystemPrompt({
      buildUuid: 'sample-build-1',
      gatheredAt: '2026-04-30T12:00:00.000Z',
      build: {
        uuid: 'sample-build-1',
        status: 'pending',
        namespace: 'env-sample-123456',
        sha: 'abc123',
      },
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
        pullRequestNumber: 42,
        status: 'open',
        labels: [],
        deployOnUpdate: false,
        deployLabels: ['lifecycle-deploy!'],
        disabledLabels: ['lifecycle-disabled!'],
        latestCommit: 'abc123',
      },
      services: [
        {
          name: 'sample-service',
          deployUuid: 'sample-service-sample-build-1',
          active: false,
          status: 'pending',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
          serviceSha: 'abc123',
          deployableType: 'helm',
          source: 'yaml',
        },
      ],
      selectedDeploy: {
        name: 'sample-service',
        deployUuid: 'sample-service-sample-build-1',
        active: false,
        status: 'pending',
        repo: 'example-org/example-repo',
        branch: 'feature/sample',
        serviceSha: 'abc123',
        deployableType: 'helm',
        source: 'yaml',
      },
      diagnosticServices: [
        {
          name: 'sample-service',
          deployUuid: 'sample-service-sample-build-1',
          active: false,
          status: 'pending',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
        },
      ],
    });

    expect(prompt).toContain('Initial Lifecycle snapshot:');
    expect(prompt).toContain('buildStatusAtStart=pending');
    expect(prompt).toContain('buildStatusMessageAtStart=<none>');
    expect(prompt).toContain('labelsAtStart=<none>');
    expect(prompt).toContain('deployOnUpdateAtStart=false');
    expect(prompt).toContain('deployLabels=lifecycle-deploy!');
    expect(prompt).toContain('disabledLabels=lifecycle-disabled!');
    expect(prompt).toContain(
      '- sample-service: deployUuid=sample-service-sample-build-1, activeAtStart=false, statusAtStart=pending, statusMessageAtStart=<none>'
    );
    expect(prompt).toContain('Deploy roster:');
    expect(prompt).not.toContain('Fresh repository reads:');
    expect(prompt).not.toContain('Mismatch handling:');
    expect(prompt).not.toContain('lifecycle.yaml');
    expect(prompt).not.toContain('process.env');
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
      skillsAvailable: false,
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
      selectedDeploy: {
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
      skillsAvailable: false,
    });

    expect(buildGraphQuery.withGraphFetched).toHaveBeenCalledWith(
      '[pullRequest.[repository], deploys.[deployable, repository, service]]'
    );
  });
});
