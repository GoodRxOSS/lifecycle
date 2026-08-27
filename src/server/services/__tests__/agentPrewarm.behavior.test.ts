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

const mockUuid = jest.fn();
const mockCreateAgentPvc = jest.fn();
const mockDeleteAgentPvc = jest.fn();
const mockCreateAgentApiKeySecret = jest.fn();
const mockDeleteAgentApiKeySecret = jest.fn();
const mockEnsureAgentSessionServiceAccount = jest.fn();
const mockResolveForwardedAgentEnv = jest.fn();
const mockCleanupForwardedAgentEnvSecrets = jest.fn();
const mockBuildCombinedInstallCommand = jest.fn();
const mockResolveAgentSessionServicePlan = jest.fn();
const mockResolveAgentSessionSkillPlan = jest.fn();
const mockCreateAgentPrewarmJob = jest.fn();
const mockMonitorAgentPrewarmJob = jest.fn();
const mockResolveAgentSessionRuntimeConfig = jest.fn();
const mockGetGithubClientToken = jest.fn();
const mockResolveAgentSessionServiceCandidatesForBuild = jest.fn();
const mockResolveRequestedAgentSessionServices = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('uuid', () => ({ v4: (...args: unknown[]) => mockUuid(...args) }));
jest.mock('server/models/AgentPrewarm', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('server/models/AgentSession', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('server/models/Build', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('server/models/yaml', () => ({ fetchLifecycleConfig: jest.fn() }));
jest.mock('server/lib/agentSession/pvcFactory', () => ({
  createAgentPvc: (...args: unknown[]) => mockCreateAgentPvc(...args),
  deleteAgentPvc: (...args: unknown[]) => mockDeleteAgentPvc(...args),
}));
jest.mock('server/lib/agentSession/apiKeySecretFactory', () => ({
  createAgentApiKeySecret: (...args: unknown[]) => mockCreateAgentApiKeySecret(...args),
  deleteAgentApiKeySecret: (...args: unknown[]) => mockDeleteAgentApiKeySecret(...args),
}));
jest.mock('server/lib/agentSession/serviceAccountFactory', () => ({
  ensureAgentSessionServiceAccount: (...args: unknown[]) => mockEnsureAgentSessionServiceAccount(...args),
}));
jest.mock('server/lib/agentSession/forwardedEnv', () => ({
  resolveForwardedAgentEnv: (...args: unknown[]) => mockResolveForwardedAgentEnv(...args),
  cleanupForwardedAgentEnvSecrets: (...args: unknown[]) => mockCleanupForwardedAgentEnvSecrets(...args),
}));
jest.mock('server/lib/agentSession/servicePlan', () => ({
  buildCombinedInstallCommand: (...args: unknown[]) => mockBuildCombinedInstallCommand(...args),
  resolveAgentSessionServicePlan: (...args: unknown[]) => mockResolveAgentSessionServicePlan(...args),
}));
jest.mock('server/lib/agentSession/skillPlan', () => ({
  resolveAgentSessionSkillPlan: (...args: unknown[]) => mockResolveAgentSessionSkillPlan(...args),
}));
jest.mock('server/lib/agentSession/prewarmJobFactory', () => ({
  createAgentPrewarmJob: (...args: unknown[]) => mockCreateAgentPrewarmJob(...args),
  monitorAgentPrewarmJob: (...args: unknown[]) => mockMonitorAgentPrewarmJob(...args),
}));
jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionRuntimeConfig: (...args: unknown[]) => mockResolveAgentSessionRuntimeConfig(...args),
}));
jest.mock('../globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getGithubClientToken: (...args: unknown[]) => mockGetGithubClientToken(...args) })),
  },
}));
jest.mock('../agentSessionCandidates', () => ({
  resolveAgentSessionServiceCandidatesForBuild: (...args: unknown[]) =>
    mockResolveAgentSessionServiceCandidatesForBuild(...args),
  resolveRequestedAgentSessionServices: (...args: unknown[]) => mockResolveRequestedAgentSessionServices(...args),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ info: mockLoggerInfo, warn: mockLoggerWarn })),
  extractContextForQueue: jest.fn(() => ({ requestId: 'request-1' })),
}));

import AgentPrewarm from 'server/models/AgentPrewarm';
import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import { fetchLifecycleConfig } from 'server/models/yaml';
import AgentPrewarmService, { canReusePrewarm } from '../agentPrewarm';

const agentPrewarmQuery = AgentPrewarm.query as jest.Mock;
const agentSessionQuery = AgentSession.query as jest.Mock;
const buildQuery = Build.query as jest.Mock;
const mockFetchLifecycleConfig = fetchLifecycleConfig as jest.Mock;

function listQuery(rows: unknown[]) {
  const query = {
    where: jest.fn(),
    whereIn: jest.fn(),
    orderBy: jest.fn().mockResolvedValue(rows),
  };
  query.where.mockReturnValue(query);
  query.whereIn.mockReturnValue(query);
  return query;
}

function findBuildQuery(build: unknown) {
  return {
    findOne: jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(build) })),
  };
}

function createService() {
  const queueAdd = jest.fn().mockResolvedValue(undefined);
  const queueManager = { registerQueue: jest.fn(() => ({ add: queueAdd })) };
  const service = new AgentPrewarmService({} as any, {} as any, {} as any, queueManager as any);
  return { service, queueAdd };
}

function prewarmPlan(overrides: Record<string, unknown> = {}) {
  return {
    buildUuid: 'build-123',
    namespace: 'env-sample',
    repo: 'example/repository',
    repoUrl: 'https://github.com/example/repository.git',
    branch: 'feature/test',
    revision: 'sha-123',
    configuredServiceNames: ['api'],
    services: [
      {
        name: 'api',
        deployId: 31,
        devConfig: { command: 'pnpm dev' },
        repo: 'example/repository',
        branch: 'feature/test',
        revision: 'sha-123',
      },
    ],
    workspaceRepos: [
      {
        repo: 'example/repository',
        repoUrl: 'https://github.com/example/repository.git',
        branch: 'feature/test',
        revision: 'sha-123',
        mountPath: '/workspace/repos/example/repository',
        primary: true,
      },
    ],
    serviceRefs: [
      {
        name: 'api',
        deployId: 31,
        repo: 'example/repository',
        branch: 'feature/test',
        revision: 'sha-123',
      },
    ],
    skillPlan: { skills: [] },
    ...overrides,
  };
}

function insertedPrewarm() {
  return {
    id: 71,
    uuid: 'prewarm-uuid-12345678',
    buildUuid: 'build-123',
    namespace: 'env-sample',
    pvcName: 'agent-prewarm-pvc-prewarm-',
    status: 'running',
  };
}

describe('AgentPrewarmService preparation behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    agentPrewarmQuery.mockReset();
    agentSessionQuery.mockReset();
    buildQuery.mockReset();
    mockUuid.mockReturnValue('prewarm-uuid-12345678');
    mockResolveAgentSessionRuntimeConfig.mockResolvedValue({
      workspaceStorage: { defaultSize: '20Gi', accessMode: 'ReadWriteOnce' },
      workspaceImage: 'registry.test/workspace:latest',
      workspaceGatewayImage: 'registry.test/gateway:latest',
      nodeSelector: { pool: 'agents' },
      resources: { workspace: { requests: { cpu: '1' } } },
    });
    mockGetGithubClientToken.mockResolvedValue('github-token');
    mockResolveForwardedAgentEnv.mockResolvedValue({
      env: { PLAIN_VALUE: 'plain', SECRET_VALUE: 'secret' },
      secretRefs: [{ envKey: 'SECRET_VALUE', secretName: 'forwarded-secret', secretKey: 'value' }],
      secretProviders: ['provider-1'],
      secretServiceName: 'api',
    });
    mockEnsureAgentSessionServiceAccount.mockResolvedValue('agent-service-account');
    mockBuildCombinedInstallCommand.mockReturnValue('pnpm install');
    mockCreateAgentPvc.mockResolvedValue(undefined);
    mockCreateAgentApiKeySecret.mockResolvedValue(undefined);
    mockCreateAgentPrewarmJob.mockResolvedValue(undefined);
    mockMonitorAgentPrewarmJob.mockResolvedValue({ success: true, logs: 'ready' });
    mockDeleteAgentApiKeySecret.mockResolvedValue(undefined);
    mockCleanupForwardedAgentEnvSecrets.mockResolvedValue(undefined);
    mockDeleteAgentPvc.mockResolvedValue(undefined);
    mockResolveAgentSessionSkillPlan.mockReturnValue({ skills: [] });
  });

  it('normalizes configured names and treats an empty request as reusable', () => {
    expect(AgentPrewarmService.normalizeServiceNames([' web ', 'api', 'web', ''])).toEqual(['api', 'web']);
    expect(AgentPrewarmService.canReusePrewarm(['api'], [])).toBe(true);
    expect(canReusePrewarm(['api', 'web'], [' api '])).toBe(true);
  });

  it.each([
    [
      'revision',
      { revision: 'old-sha', services: ['api'], workspaceRepos: [], serviceRefs: [] },
      { requestedServices: ['api'], revision: 'new-sha' },
    ],
    [
      'workspace repository count',
      {
        revision: 'sha-123',
        services: ['api'],
        workspaceRepos: prewarmPlan().workspaceRepos,
        serviceRefs: prewarmPlan().serviceRefs,
      },
      {
        requestedServices: ['api'],
        revision: 'sha-123',
        workspaceRepos: [
          ...prewarmPlan().workspaceRepos,
          {
            repo: 'example/second',
            repoUrl: 'https://github.com/example/second.git',
            branch: 'main',
            mountPath: '/workspace/repos/example/second',
            primary: false,
          },
        ],
      },
    ],
  ])('rejects a ready prewarm with a different %s', async (_label, prewarm, request) => {
    agentPrewarmQuery.mockReturnValue(listQuery([prewarm]));
    const { service } = createService();

    await expect(service.getCompatibleReadyPrewarm({ buildUuid: 'build-123', ...request })).resolves.toBeNull();
  });

  it('returns null when no ready prewarm uses the requested pvc', async () => {
    agentPrewarmQuery.mockReturnValue(listQuery([{ uuid: 'prewarm-1', pvcName: 'other-pvc' }]));
    const { service } = createService();

    await expect(service.getReadyPrewarmByPvc({ buildUuid: 'build-123', pvcName: 'missing-pvc' })).resolves.toBeNull();
  });

  it('does not queue or prepare when the build has no prewarm plan', async () => {
    const first = createService();
    jest.spyOn(first.service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(null);
    await expect(first.service.queueBuildPrewarm('build-123')).resolves.toBe(false);
    expect(first.queueAdd).not.toHaveBeenCalled();

    const second = createService();
    jest.spyOn(second.service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(null);
    await expect(second.service.prepareBuildPrewarm('build-123')).resolves.toBeNull();
    expect(agentPrewarmQuery).not.toHaveBeenCalled();
  });

  it('reuses an exactly matching running prewarm before creating Kubernetes resources', async () => {
    const plan = prewarmPlan();
    const matching = {
      ...insertedPrewarm(),
      revision: plan.revision,
      services: plan.configuredServiceNames,
      workspaceRepos: plan.workspaceRepos,
      serviceRefs: plan.serviceRefs,
    };
    agentPrewarmQuery.mockReturnValue(listQuery([matching]));
    const { service } = createService();
    jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(plan);

    await expect(service.prepareBuildPrewarm('build-123')).resolves.toBe(matching);

    expect(mockResolveAgentSessionRuntimeConfig).not.toHaveBeenCalled();
    expect(mockCreateAgentPvc).not.toHaveBeenCalled();
  });

  it('queues a new prewarm when exact service-reference identity is missing', async () => {
    const plan = prewarmPlan();
    agentPrewarmQuery.mockReturnValue(
      listQuery([
        {
          revision: plan.revision,
          services: plan.configuredServiceNames,
          workspaceRepos: plan.workspaceRepos,
          serviceRefs: [],
        },
      ])
    );
    const { service, queueAdd } = createService();
    jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(plan);

    await expect(service.queueBuildPrewarm('build-123')).resolves.toBe(true);

    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('creates a ready prewarm, filters forwarded secrets, and cleans superseded state', async () => {
    const plan = prewarmPlan();
    const inserted = insertedPrewarm();
    const readyPatch = jest.fn().mockResolvedValue(1);
    const deleteById = jest.fn().mockRejectedValue(new Error('record cleanup failed'));
    agentPrewarmQuery
      .mockReturnValueOnce(listQuery([]))
      .mockReturnValueOnce({ insertAndFetch: jest.fn().mockResolvedValue(inserted) })
      .mockReturnValueOnce({ findById: jest.fn(() => ({ patch: readyPatch })) })
      .mockReturnValueOnce(
        listQuery([
          inserted,
          { id: 61, uuid: 'prewarm-old', pvcName: 'agent-prewarm-pvc-old', status: 'ready' },
          { id: 62, uuid: 'prewarm-no-pvc', pvcName: null, status: 'error' },
        ])
      )
      .mockReturnValueOnce({ deleteById });
    agentSessionQuery.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockResolvedValue([]),
    });
    mockDeleteAgentPvc.mockRejectedValue(new Error('pvc cleanup failed'));
    const { service } = createService();
    jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(plan);

    const result = await service.prepareBuildPrewarm('build-123');

    expect(result).toMatchObject({ id: 71, status: 'ready', errorMessage: null });
    expect(mockCreateAgentPvc).toHaveBeenCalledWith(
      'env-sample',
      'agent-prewarm-pvc-prewarm-',
      '20Gi',
      'build-123',
      'ReadWriteOnce'
    );
    expect(mockCreateAgentApiKeySecret).toHaveBeenCalledWith(
      'env-sample',
      'agent-prewarm-secret-prewarm-',
      undefined,
      'github-token',
      'build-123',
      { PLAIN_VALUE: 'plain' }
    );
    expect(mockCreateAgentPrewarmJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'agent-prewarm-prewarm-',
        hasGitHubToken: true,
        workspacePath: '/workspace',
        serviceAccountName: 'agent-service-account',
        installCommand: 'pnpm install',
      })
    );
    expect(readyPatch).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready', completedAt: expect.any(String), errorMessage: null })
    );
    expect(mockDeleteAgentPvc).toHaveBeenCalledWith('env-sample', 'agent-prewarm-pvc-old');
    expect(deleteById).toHaveBeenCalledWith(61);
    expect(mockDeleteAgentApiKeySecret).toHaveBeenCalledWith('env-sample', 'agent-prewarm-secret-prewarm-');
    expect(mockCleanupForwardedAgentEnvSecrets).toHaveBeenCalledWith('env-sample', 'prewarm-uuid-12345678', [
      'provider-1',
    ]);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
  });

  it('continues after an already-existing pvc and a missing GitHub token', async () => {
    const plan = prewarmPlan({ revision: undefined });
    const inserted = insertedPrewarm();
    agentPrewarmQuery
      .mockReturnValueOnce(listQuery([]))
      .mockReturnValueOnce({ insertAndFetch: jest.fn().mockResolvedValue(inserted) })
      .mockReturnValueOnce({ findById: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(1) })) })
      .mockReturnValueOnce(listQuery([inserted]));
    mockGetGithubClientToken.mockRejectedValue(new Error('token unavailable'));
    mockCreateAgentPvc.mockRejectedValue({ response: { statusCode: 409 } });
    const { service } = createService();
    jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(plan);

    await expect(service.prepareBuildPrewarm('build-123')).resolves.toMatchObject({ status: 'ready' });

    expect(mockCreateAgentPrewarmJob).toHaveBeenCalledWith(
      expect.objectContaining({ hasGitHubToken: false, revision: undefined })
    );
  });

  it('records trimmed monitor output when the prewarm job fails and still attempts cleanup', async () => {
    const plan = prewarmPlan();
    const inserted = insertedPrewarm();
    const errorPatch = jest.fn().mockResolvedValue(1);
    agentPrewarmQuery
      .mockReturnValueOnce(listQuery([]))
      .mockReturnValueOnce({ insertAndFetch: jest.fn().mockResolvedValue(inserted) })
      .mockReturnValueOnce({ findById: jest.fn(() => ({ patch: errorPatch })) });
    mockMonitorAgentPrewarmJob.mockResolvedValue({ success: false, logs: '  dependency install failed  ' });
    mockDeleteAgentApiKeySecret.mockRejectedValue(new Error('secret cleanup failed'));
    mockCleanupForwardedAgentEnvSecrets.mockRejectedValue(new Error('forwarded cleanup failed'));
    const { service } = createService();
    jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(plan);

    await expect(service.prepareBuildPrewarm('build-123')).rejects.toThrow('dependency install failed');

    expect(errorPatch).toHaveBeenCalledWith({ status: 'error', errorMessage: 'dependency install failed' });
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
  });

  it('uses the default job failure message when monitoring returns no useful logs', async () => {
    const plan = prewarmPlan();
    const inserted = insertedPrewarm();
    const errorPatch = jest.fn().mockResolvedValue(1);
    agentPrewarmQuery
      .mockReturnValueOnce(listQuery([]))
      .mockReturnValueOnce({ insertAndFetch: jest.fn().mockResolvedValue(inserted) })
      .mockReturnValueOnce({ findById: jest.fn(() => ({ patch: errorPatch })) });
    mockMonitorAgentPrewarmJob.mockResolvedValue({ success: false, logs: '   ' });
    const { service } = createService();
    jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(plan);

    await expect(service.prepareBuildPrewarm('build-123')).rejects.toThrow('Agent prewarm job failed');

    expect(errorPatch).toHaveBeenCalledWith({ status: 'error', errorMessage: 'Agent prewarm job failed' });
  });

  it('truncates long setup failures and preserves the original rejection when status persistence also fails', async () => {
    const plan = prewarmPlan();
    const inserted = insertedPrewarm();
    const longError = new Error('x'.repeat(5000));
    const errorPatch = jest.fn().mockRejectedValue(new Error('status write failed'));
    agentPrewarmQuery
      .mockReturnValueOnce(listQuery([]))
      .mockReturnValueOnce({ insertAndFetch: jest.fn().mockResolvedValue(inserted) })
      .mockReturnValueOnce({ findById: jest.fn(() => ({ patch: errorPatch })) });
    mockCreateAgentPvc.mockRejectedValue(longError);
    const { service } = createService();
    jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue(plan);

    await expect(service.prepareBuildPrewarm('build-123')).rejects.toBe(longError);

    const persistedMessage = errorPatch.mock.calls[0][0].errorMessage;
    expect(persistedMessage).toHaveLength(4000);
    expect(persistedMessage.endsWith('...')).toBe(true);
  });
});

describe('AgentPrewarmService plan validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildQuery.mockReset();
    agentPrewarmQuery.mockReset();
    mockResolveAgentSessionServiceCandidatesForBuild.mockResolvedValue([]);
    mockResolveRequestedAgentSessionServices.mockReturnValue([]);
    mockResolveAgentSessionServicePlan.mockReturnValue({
      workspaceRepos: [],
      services: [],
      selectedServices: [],
    });
    mockResolveAgentSessionSkillPlan.mockReturnValue({ skills: [] });
  });

  it.each([
    ['a missing build', null],
    ['a non-environment build', { kind: 'build', pullRequest: { fullName: 'example/repository', branchName: 'main' } }],
    ['a build without a pull request repository', { kind: 'environment', pullRequest: { branchName: 'main' } }],
    ['a build without a pull request branch', { kind: 'environment', pullRequest: { fullName: 'example/repository' } }],
  ])('does not queue %s', async (_label, build) => {
    buildQuery.mockReturnValue(findBuildQuery(build));
    const { service, queueAdd } = createService();

    await expect(service.queueBuildPrewarm('build-123')).resolves.toBe(false);

    expect(queueAdd).not.toHaveBeenCalled();
    expect(mockFetchLifecycleConfig).not.toHaveBeenCalled();
  });

  it('does not queue when lifecycle config declares no prewarm services', async () => {
    buildQuery.mockReturnValue(
      findBuildQuery({
        kind: 'environment',
        namespace: 'env-sample',
        pullRequest: { fullName: 'example/repository', branchName: 'main', latestCommit: null },
      })
    );
    mockFetchLifecycleConfig.mockResolvedValue({ environment: { agentSession: { prewarm: { services: [] } } } });
    const { service, queueAdd } = createService();

    await expect(service.queueBuildPrewarm('build-123')).resolves.toBe(false);

    expect(queueAdd).not.toHaveBeenCalled();
    expect(mockResolveAgentSessionServiceCandidatesForBuild).not.toHaveBeenCalled();
  });

  it('does not queue when service planning produces no workspace repository', async () => {
    const build = {
      kind: 'environment',
      namespace: 'env-sample',
      pullRequest: { fullName: 'example/repository', branchName: 'main', latestCommit: null },
    };
    buildQuery.mockReturnValue(findBuildQuery(build));
    mockFetchLifecycleConfig.mockResolvedValue({
      environment: { agentSession: { prewarm: { services: ['api'] } } },
    });
    mockResolveAgentSessionServiceCandidatesForBuild.mockResolvedValue([
      { name: 'api', deployId: 31, devConfig: { command: 'pnpm dev' } },
    ]);
    mockResolveRequestedAgentSessionServices.mockReturnValue([
      { name: 'api', deployId: 31, devConfig: { command: 'pnpm dev' } },
    ]);
    const { service, queueAdd } = createService();

    await expect(service.queueBuildPrewarm('build-123')).resolves.toBe(false);

    expect(queueAdd).not.toHaveBeenCalled();
  });
});
