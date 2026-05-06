/**
 * Copyright 2026 Lifecycle contributors
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

const mockDeployQuery = jest.fn();
const mockGenerateManifest = jest.fn();
const mockApplyManifests = jest.fn();
const mockWaitForPodReady = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockQueueAdd = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('server/lib/tracer', () => ({
  Tracer: {
    getInstance: jest.fn(() => ({
      initialize: jest.fn(),
    })),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));

jest.mock('shared/config', () => ({
  TMP_PATH: '/tmp',
  QUEUE_NAMES: {
    BUILD_QUEUE: 'build',
    RESOLVE_DEPLOY_BUILD_QUEUE: 'resolve-deploy',
    BUILD_CLEANUP_QUEUE: 'build-cleanup',
    BUILD_REQUEST_QUEUE: 'build-request',
    GLOBAL_CONFIG_CACHE_REFRESH: 'global-config-refresh',
    GITHUB_CLIENT_TOKEN_CACHE_REFRESH: 'github-client-token-refresh',
    INGRESS_MANIFEST_QUEUE: 'ingress-manifest',
    AGENT_PREWARM_QUEUE: 'agent-prewarm',
  },
}));

jest.mock('server/models', () => ({
  Build: class {},
  Deploy: {
    query: () => mockDeployQuery(),
  },
  Environment: class {},
  Service: class {},
  BuildServiceOverride: class {},
}));

jest.mock('server/lib/kubernetes', () => ({
  generateManifest: (...args: any[]) => mockGenerateManifest(...args),
  applyManifests: (...args: any[]) => mockApplyManifests(...args),
  waitForPodReady: (...args: any[]) => mockWaitForPodReady(...args),
  createOrUpdateNamespace: jest.fn(),
  createOrUpdateServiceAccount: jest.fn(),
}));

jest.mock('server/lib/github', () => ({
  createGitDeployment: jest.fn(),
  updateGitDeploymentStatus: jest.fn(),
  getPullRequest: jest.fn(),
}));

jest.mock('server/lib/helm', () => ({
  uninstallHelmReleases: jest.fn(),
}));

jest.mock('server/lib/helm/utils', () => ({
  ingressBannerSnippet: jest.fn(() => ''),
}));

jest.mock('server/lib/buildEnvVariables', () => ({
  BuildEnvironmentVariables: jest.fn().mockImplementation(() => ({
    resolve: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('server/services/webhook', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
    })),
  },
}));

jest.mock('server/lib/fastly', () =>
  jest.fn().mockImplementation(() => ({
    getServiceDashboardUrl: jest.fn(),
  }))
);

import BuildService from '../build';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';

describe('BuildService failure boundaries', () => {
  let buildService: BuildService;
  let recordDeployFailure: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    recordDeployFailure = jest.fn();
    const queueManager = {
      registerQueue: jest.fn(() => ({
        add: mockQueueAdd,
        process: jest.fn(),
        on: jest.fn(),
      })),
    };
    buildService = new BuildService(
      {
        services: {
          Deploy: {
            recordDeployFailure,
          },
        },
      } as any,
      {} as any,
      {} as any,
      queueManager as any
    );
    (buildService as any).ingressService = {
      ingressManifestQueue: {
        add: mockQueueAdd,
      },
    };
    mockGetAllConfigs.mockResolvedValue({ serviceAccount: { name: 'sample-service-account' } });
  });

  test('classic manifest failures stay build-scoped when no deploy can be identified', async () => {
    const deploys = [
      {
        id: 1,
        active: true,
        uuid: 'sample-api',
        status: DeployStatus.BUILT,
        service: { type: DeployTypes.GITHUB, name: 'sample-api' },
      },
      {
        id: 2,
        active: true,
        uuid: 'sample-worker',
        status: DeployStatus.BUILT,
        service: { type: DeployTypes.DOCKER, name: 'sample-worker' },
      },
    ];
    const query = {
      where: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue(deploys),
    };
    const rolloutError = new Error('Pods for build not ready after 15 minutes');
    mockDeployQuery.mockReturnValue(query);
    mockGenerateManifest.mockReturnValue('apiVersion: apps/v1\nkind: Deployment\n');
    mockApplyManifests.mockResolvedValue([]);
    mockWaitForPodReady.mockRejectedValue(rolloutError);

    await expect(
      buildService.generateAndApplyManifests({
        build: {
          id: 123,
          uuid: 'sample-build',
          runUUID: 'run-1',
          namespace: 'sample-namespace',
          enableFullYaml: false,
          $query: jest.fn(() => ({
            patch: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
        githubRepositoryId: null,
        namespace: 'sample-namespace',
      })
    ).rejects.toThrow(rolloutError);

    expect(recordDeployFailure).not.toHaveBeenCalled();
  });
});

describe('BuildService status updates', () => {
  test('updates only build status fields', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    const buildService = new BuildService(
      {
        services: {
          Webhook: {
            webhookQueue: {
              add: jest.fn(),
            },
          },
        },
      } as any,
      {} as any,
      {} as any,
      {
        registerQueue: jest.fn(() => ({
          add: mockQueueAdd,
          process: jest.fn(),
          on: jest.fn(),
        })),
      } as any
    );
    const build = {
      id: 1,
      uuid: 'sample-build',
      runUUID: 'run-1',
      kind: BuildKind.SANDBOX,
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch })),
    };

    await buildService.updateStatusAndComment(build as any, BuildStatus.DEPLOYED, 'run-1', true, true);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({
      status: BuildStatus.DEPLOYED,
      statusMessage: '',
    });
  });
});

describe('BuildService queue fingerprinting', () => {
  let buildService: BuildService;
  let mockBuildQuery: any;
  let mockBuildQueueAdd: jest.Mock;
  let mockResolveQueueAdd: jest.Mock;

  const createMockBuild = (overrides: any = {}) =>
    ({
      id: 1,
      enableFullYaml: true,
      commentRuntimeEnv: { FEATURE_FLAG: 'on' },
      commentInitEnv: {},
      pullRequest: { latestCommit: 'abcdef123456' },
      deploys: [
        {
          id: 11,
          uuid: 'api-deploy',
          githubRepositoryId: 100,
          branchName: 'feature-branch',
          active: true,
          publicUrl: 'https://example.test/api',
          env: { API_URL: 'https://api.test' },
          initEnv: { INIT_MODE: 'warm' },
          deployable: { name: 'api', commentBranchName: null },
          service: { name: 'api' },
        },
        {
          id: 22,
          uuid: 'worker-deploy',
          githubRepositoryId: 200,
          branchName: 'feature-branch',
          active: true,
          publicUrl: 'https://example.test/worker',
          env: { QUEUE: 'jobs' },
          initEnv: {},
          deployable: { name: 'worker', commentBranchName: 'worker-override' },
          service: { name: 'worker' },
        },
      ],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any);

  beforeEach(() => {
    jest.clearAllMocks();

    mockBuildQueueAdd = jest.fn().mockResolvedValue(undefined);
    mockResolveQueueAdd = jest.fn().mockResolvedValue(undefined);

    mockBuildQuery = {
      findOne: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn(),
    };

    const queueManager = {
      registerQueue: jest.fn(() => ({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      })),
    };

    buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn(() => mockBuildQuery),
          },
        },
        services: {},
      } as any,
      {} as any,
      {} as any,
      queueManager as any
    );
    (buildService as any).buildQueue = { add: mockBuildQueueAdd };
    (buildService as any).resolveAndDeployBuildQueue = { add: mockResolveQueueAdd };
  });

  test('changes fingerprint when comment runtime env changes', async () => {
    const baseBuild = createMockBuild();
    const changedBuild = createMockBuild({
      commentRuntimeEnv: { FEATURE_FLAG: 'off' },
    });

    const baseFingerprint = await buildService.computeBuildRequestFingerprint(baseBuild);
    const changedFingerprint = await buildService.computeBuildRequestFingerprint(changedBuild);

    expect(baseFingerprint).not.toEqual(changedFingerprint);
  });

  test('changes fingerprint when static mode changes', async () => {
    const previewBuild = createMockBuild({
      isStatic: false,
    });
    const staticBuild = createMockBuild({
      isStatic: true,
    });

    const previewFingerprint = await buildService.computeBuildRequestFingerprint(previewBuild);
    const staticFingerprint = await buildService.computeBuildRequestFingerprint(staticBuild);

    expect(previewFingerprint).not.toEqual(staticFingerprint);
  });

  test('changes fingerprint when repository filter changes', async () => {
    const build = createMockBuild();

    const apiFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);
    const workerFingerprint = await buildService.computeBuildRequestFingerprint(build, 200);

    expect(apiFingerprint).not.toEqual(workerFingerprint);
  });

  test('enqueues resolve queue with deduplication derived from the current build fingerprint', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      correlationId: 'corr-1',
    });

    expect(mockResolveQueueAdd).toHaveBeenCalledWith(
      'resolve-deploy',
      expect.objectContaining({
        buildId: 1,
        githubRepositoryId: 100,
        correlationId: 'corr-1',
      }),
      expect.objectContaining({
        deduplication: {
          id: `resolve:1:${expectedFingerprint}`,
          ttl: 30000,
        },
      })
    );
  });

  test('enqueues build queue with a deterministic job id derived from the current build fingerprint', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueBuildJob({
      buildId: 1,
      githubRepositoryId: 100,
      correlationId: 'corr-2',
    });

    expect(mockBuildQueueAdd).toHaveBeenCalledWith(
      'build',
      expect.objectContaining({
        buildId: 1,
        githubRepositoryId: 100,
        correlationId: 'corr-2',
      }),
      expect.objectContaining({
        jobId: `build:1:${expectedFingerprint}`,
      })
    );
  });
});
