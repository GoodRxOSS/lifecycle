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

const mockGetAllConfigs = jest.fn();
const mockGetYamlFileContentFromBranch = jest.fn();
const mockListBranchesForRepo = jest.fn();
const mockResolveEnvironmentServices = jest.fn();
let lastActualResolution:
  | import('server/models/yaml/resolveEnvironmentServices').ResolvedEnvironmentServices
  | undefined;

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn() },
}));
jest.mock('server/lib/tracer', () => ({
  Tracer: { getInstance: jest.fn(() => ({ initialize: jest.fn() })) },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));
jest.mock('server/lib/kubernetes', () => ({
  generateManifest: jest.fn(),
  applyManifests: jest.fn(),
  waitForPodReady: jest.fn(),
  createOrUpdateNamespace: jest.fn(),
  deleteBuild: jest.fn(),
  deleteNamespace: jest.fn(),
}));
jest.mock('server/lib/kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: jest.fn().mockResolvedValue('default'),
}));
jest.mock('server/lib/github', () => ({
  getYamlFileContent: jest.fn(),
  getYamlFileContentFromBranch: (...args: unknown[]) => mockGetYamlFileContentFromBranch(...args),
  listBranchesForRepo: (...args: unknown[]) => mockListBranchesForRepo(...args),
  getSHAForBranch: jest.fn(),
  getPullRequest: jest.fn(),
}));
jest.mock('server/models/yaml', () => ({
  resolveEnvironmentServices: (...args: unknown[]) => mockResolveEnvironmentServices(...args),
}));
jest.mock('server/lib/helm', () => ({ uninstallHelmReleases: jest.fn() }));
jest.mock('server/lib/helm/utils', () => ({ ingressBannerSnippet: jest.fn(() => '') }));
jest.mock('server/lib/cli', () => ({ deployBuild: jest.fn(), deleteBuild: jest.fn() }));
jest.mock('server/lib/buildEnvVariables', () => ({
  BuildEnvironmentVariables: jest.fn().mockImplementation(() => ({ resolve: jest.fn().mockResolvedValue({}) })),
}));
jest.mock('server/lib/dependencyGraph', () => ({ generateGraph: jest.fn() }));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
      getConfig: async (key: string) => (await mockGetAllConfigs())?.[key],
      isFeatureEnabled: jest.fn(),
    })),
  },
}));
jest.mock('server/services/deployCleanup', () =>
  jest.fn().mockImplementation(() => ({ cleanupDeploy: jest.fn(), deleteServiceRows: jest.fn() }))
);
jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ patchAndUpdateActivityFeed: jest.fn() })),
}));
jest.mock('server/services/webhook', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ upsertWebhooksWithYaml: jest.fn() })),
}));
jest.mock('server/services/override', () => ({
  __esModule: true,
  isBranchOrExternalUrlEditable: (type?: string) => ['github', 'helm', 'externalHTTP'].includes(type ?? ''),
  default: jest.fn().mockImplementation(() => ({
    applyServiceOverrides: jest.fn(),
    getServiceOverrideStates: jest.fn().mockResolvedValue([]),
  })),
}));
jest.mock('server/services/agentPrewarm', () =>
  jest.fn().mockImplementation(() => ({ queueBuildPrewarm: jest.fn().mockResolvedValue(undefined) }))
);
jest.mock('server/lib/fastly', () => jest.fn().mockImplementation(() => ({ getServiceDashboardUrl: jest.fn() })));
jest.mock('server/models', () => ({
  Build: class {},
  Deploy: class {},
  Environment: class {},
  BuildServiceOverride: class {},
  Repository: class {},
}));
jest.mock('server/lib/paginate', () => ({
  paginate: jest.fn(),
  getPaginationParamsFromURL: jest.fn(),
}));

import BuildService from '../build';

const rootRepository = { id: 11, githubRepositoryId: 42, fullName: 'org/root', defaultEnvId: 5 };
const remoteRepository = { id: 12, githubRepositoryId: 84, fullName: 'org/remote', defaultEnvId: 6 };

const LOCAL_ONLY_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: local
services:
  - name: local
    docker:
      dockerImage: redis
      defaultTag: latest
`;

const LOCAL_BRANCH_SERVICES_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: github-app
    - name: helm-app
    - name: external-app
    - name: cache
services:
  - name: github-app
    github:
      repository: org/github-source
      branchName: main
      docker:
        defaultTag: latest
        app:
          dockerfilePath: Dockerfile
  - name: helm-app
    helm:
      repository: org/helm-source
      branchName: main
      chart:
        name: helm-app
  - name: external-app
    externalHttp:
      defaultInternalHostname: external.internal
      defaultPublicUrl: external.example.com
  - name: cache
    docker:
      dockerImage: redis
      defaultTag: latest
`;

const LEGACY_DUPLICATE_BRANCH_REFERENCE_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: github-app
    - name: github-app
      repository: ORG/ROOT
      branch: main
services:
  - name: github-app
    github:
      repository: org/github-source
      branchName: main
      docker:
        defaultTag: latest
        app:
          dockerfilePath: Dockerfile
`;

const BLANK_REPOSITORY_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: blank-repository
      repository: ''
services:
  - name: blank-repository
    docker:
      dockerImage: redis
      defaultTag: latest
`;

const CROSS_REPOSITORY_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: local
    - name: remote-handle
      repository: org/remote
services:
  - name: local
    docker:
      dockerImage: redis
      defaultTag: latest
`;

const INVALID_CROSS_REPOSITORY_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: remote-handle
      repository: org/remote
services:
  - name: local
    docker:
      dockerImage: redis
`;

const SERVICE_ID_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: yaml-service
      serviceId: 123
services:
  - name: yaml-service
    docker:
      dockerImage: redis
      defaultTag: latest
`;

const REMOTE_SERVICE_ID_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: remote-database-service
      serviceId: 123
`;

const SAME_REPOSITORY_BRANCH_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: app
      repository: org/root
      branch: release
services:
  - name: app
    docker:
      dockerImage: app
      defaultTag: latest
`;

const SAME_REPOSITORY_RELEASE_YAML = `
version: '1.0.0'
environment: {}
services:
  - name: app
    helm:
      chart:
        name: app
`;

const SAME_REPOSITORY_RELEASE_WITH_SOURCE_YAML = `
version: '1.0.0'
environment: {}
services:
  - name: app
    helm:
      repository: org/app-source
      branchName: main
      chart:
        name: app
`;

const SAME_SERVICE_DIFFERENT_BRANCHES_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: app
      repository: org/remote
      branch: release-a
    - name: app
      repository: org/remote
      branch: release-b
services:
  - name: local
    docker:
      dockerImage: redis
      defaultTag: latest
`;

const DUPLICATE_SAME_BRANCH_YAML = `
version: '1.0.0'
environment:
  defaultServices:
    - name: app
      repository: org/remote
      branch: release-a
    - name: app
      repository: org/remote
      branch: release-a
services:
  - name: local
    docker:
      dockerImage: redis
      defaultTag: latest
`;

function makeService(repositoryResults = [rootRepository]) {
  const queryChains: Array<{
    whereRaw: jest.Mock;
    whereNull: jest.Mock;
    first: jest.Mock;
  }> = [];
  const pendingResults = [...repositoryResults];
  const repositoryQuery = jest.fn(() => {
    const chain = {} as (typeof queryChains)[number];
    chain.whereRaw = jest.fn(() => chain);
    chain.whereNull = jest.fn(() => chain);
    chain.first = jest.fn().mockResolvedValue(pendingResults.shift());
    queryChains.push(chain);
    return chain;
  });
  const models = {
    Repository: { query: repositoryQuery },
    Build: { query: jest.fn() },
    Environment: { query: jest.fn() },
    Deployable: { query: jest.fn() },
  };
  const queueManager = {
    registerQueue: jest.fn(() => ({ add: jest.fn() })),
    registerWorker: jest.fn(),
  };
  const service = new BuildService({ models, services: {} } as any, {} as any, {} as any, queueManager as any);
  return { service, queryChains, repositoryQuery };
}

function useActualResolver() {
  const { resolveEnvironmentServices } = jest.requireActual(
    'server/models/yaml/resolveEnvironmentServices'
  ) as typeof import('server/models/yaml/resolveEnvironmentServices');
  mockResolveEnvironmentServices.mockImplementation(async (input) => {
    lastActualResolution = await resolveEnvironmentServices(input);
    return lastActualResolution;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  lastActualResolution = undefined;
  mockGetAllConfigs.mockResolvedValue({ api_environments: { enabled: true } });
});

describe('previewEnvironmentConfig cross-repository resolution', () => {
  it('preserves the unreadable-root response and does not consult the flag or resolver', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockRejectedValue(new Error('Config file not found'));

    await expect(service.previewEnvironmentConfig('org/root', 'main')).resolves.toEqual({
      valid: false,
      error: 'lifecycle.yaml was not found or could not be read at this ref.',
      services: [],
    });
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
  });

  it('preserves valid local-only preview rows as legacy four-field objects', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(LOCAL_ONLY_YAML);

    const result = await service.previewEnvironmentConfig('org/root', 'feature');

    expect(result).toEqual({
      valid: true,
      services: [{ name: 'local', type: 'docker', defaultActive: true, editable: false }],
    });
    expect(Object.keys(result.services[0])).toEqual(['name', 'type', 'defaultActive', 'editable']);
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
  });

  it('exposes source repositories for legacy GitHub and Helm rows without changing other service types', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(LOCAL_BRANCH_SERVICES_YAML);

    const result = await service.previewEnvironmentConfig('org/root', 'feature');

    expect(result).toEqual({
      valid: true,
      services: [
        {
          name: 'github-app',
          type: 'github',
          defaultActive: true,
          editable: true,
          branchRepository: 'org/github-source',
          branchConfigurationRepository: null,
          effectiveBranch: 'main',
        },
        {
          name: 'helm-app',
          type: 'helm',
          defaultActive: true,
          editable: true,
          branchRepository: 'org/helm-source',
          branchConfigurationRepository: null,
          effectiveBranch: 'main',
        },
        { name: 'external-app', type: 'externalHTTP', defaultActive: true, editable: true },
        { name: 'cache', type: 'docker', defaultActive: true, editable: false },
      ],
    });
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
  });

  it('promotes a later explicit same-repository branch requirement when legacy rows deduplicate', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(LEGACY_DUPLICATE_BRANCH_REFERENCE_YAML);
    mockGetAllConfigs.mockResolvedValue({ api_environments: { enabled: false } });

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(result).toEqual({
      valid: true,
      services: [
        {
          name: 'github-app',
          type: 'github',
          defaultActive: true,
          editable: true,
          branchRepository: 'org/github-source',
          branchConfigurationRepository: 'org/root',
          effectiveBranch: 'main',
        },
      ],
    });
    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
  });

  it('does not call the resolver for invalid root yaml', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(INVALID_CROSS_REPOSITORY_YAML);

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(result.valid).toBe(false);
    expect(result.services).toEqual([{ name: 'remote-handle', type: null, defaultActive: true, editable: false }]);
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
  });

  it('keeps explicit remote references on the legacy type-null path when the flag is off', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(CROSS_REPOSITORY_YAML);
    mockGetAllConfigs.mockResolvedValue({ api_environments: { enabled: false } });

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(result).toEqual({
      valid: true,
      services: [
        { name: 'local', type: 'docker', defaultActive: true, editable: false },
        { name: 'remote-handle', type: null, defaultActive: true, editable: false },
      ],
    });
    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
  });

  it('reports serviceId references as unsupported even when the API-environments flag is off', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(SERVICE_ID_YAML);
    mockGetAllConfigs.mockResolvedValue({ api_environments: { enabled: false } });
    useActualResolver();

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(result).toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: false,
      services: [
        {
          name: 'yaml-service',
          type: null,
          defaultActive: true,
          editable: false,
          repository: 'org/root',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: 'serviceId references in lifecycle.yaml are no longer supported.',
        },
      ],
      unresolved: [
        {
          name: 'yaml-service',
          repository: 'org/root',
          branch: 'main',
          status: 'unresolved',
          reason: 'serviceId references in lifecycle.yaml are no longer supported.',
        },
      ],
    });
    expect(mockResolveEnvironmentServices).toHaveBeenCalledTimes(1);
    expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit same-repository branch on the legacy root config when the flag is off', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(SAME_REPOSITORY_BRANCH_YAML);
    mockGetAllConfigs.mockResolvedValue({ api_environments: { enabled: false } });

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(result).toEqual({
      valid: true,
      services: [{ name: 'app', type: 'docker', defaultActive: true, editable: false }],
    });
    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
    expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledTimes(1);
  });

  it('resolves an explicit same-repository branch without treating it as composition', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch
      .mockResolvedValueOnce(SAME_REPOSITORY_BRANCH_YAML)
      .mockResolvedValueOnce(SAME_REPOSITORY_RELEASE_WITH_SOURCE_YAML);
    useActualResolver();

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(mockGetYamlFileContentFromBranch).toHaveBeenNthCalledWith(2, 'org/root', 'release');
    expect(mockListBranchesForRepo).not.toHaveBeenCalled();
    expect(lastActualResolution?.services).toEqual([
      expect.objectContaining({
        name: 'app',
        type: 'helm',
        repository: 'org/root',
        branch: 'release',
        status: 'resolved',
      }),
    ]);
    expect(result).toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: false,
      services: [
        {
          name: 'app',
          type: 'helm',
          defaultActive: true,
          editable: true,
          branchRepository: 'org/app-source',
          branchConfigurationRepository: 'org/root',
          effectiveBranch: 'main',
        },
      ],
      unresolved: [],
    });
    expect(Object.keys(result.services[0])).toEqual([
      'name',
      'type',
      'defaultActive',
      'editable',
      'branchRepository',
      'branchConfigurationRepository',
      'effectiveBranch',
    ]);
  });

  it('keeps same-name exact services from different branches as collision-safe preview-only rows', async () => {
    const { service } = makeService([rootRepository, remoteRepository]);
    mockGetYamlFileContentFromBranch
      .mockResolvedValueOnce(SAME_SERVICE_DIFFERENT_BRANCHES_YAML)
      .mockResolvedValueOnce(SAME_REPOSITORY_RELEASE_YAML)
      .mockResolvedValueOnce(SAME_REPOSITORY_RELEASE_YAML);
    useActualResolver();

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledWith('org/remote', 'release-a');
    expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledWith('org/remote', 'release-b');
    expect(lastActualResolution?.services).toHaveLength(2);
    expect(
      lastActualResolution?.services.map(({ originalName, branch }) => ({
        originalName,
        branch,
      }))
    ).toEqual([
      { originalName: 'app', branch: 'release-a' },
      { originalName: 'app', branch: 'release-b' },
    ]);
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toEqual({
      name: 'app',
      type: 'helm',
      defaultActive: true,
      editable: false,
      branchRepository: null,
      branchConfigurationRepository: 'org/remote',
      effectiveBranch: 'main',
      repository: 'org/remote',
      resolvedFromRepositoryId: 84,
      status: 'resolved',
      reason: 'Service-name collisions are preview-only until collision-safe build names are persisted.',
      previewOnly: true,
    });
    expect(result.services[1]).toEqual({
      ...result.services[0],
      name: expect.stringMatching(/^app-[0-9a-f]{6}$/),
    });
    expect(new Set(result.services.map(({ name }) => name)).size).toBe(2);
  });

  it('collapses duplicate same-branch exact references into one actionable row', async () => {
    const { service } = makeService([rootRepository, remoteRepository]);
    mockGetYamlFileContentFromBranch
      .mockResolvedValueOnce(DUPLICATE_SAME_BRANCH_YAML)
      .mockResolvedValueOnce(SAME_REPOSITORY_RELEASE_YAML);
    useActualResolver();

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledTimes(2);
    expect(mockGetYamlFileContentFromBranch).toHaveBeenNthCalledWith(2, 'org/remote', 'release-a');
    expect(lastActualResolution?.services).toEqual([
      expect.objectContaining({
        key: 'service:84@release-a:app',
        name: 'app',
        originalName: 'app',
        branch: 'release-a',
      }),
    ]);
    expect(result.services).toEqual([
      {
        name: 'app',
        type: 'helm',
        defaultActive: true,
        editable: true,
        branchRepository: null,
        branchConfigurationRepository: 'org/remote',
        effectiveBranch: 'main',
        repository: 'org/remote',
        resolvedFromRepositoryId: 84,
        status: 'resolved',
      },
    ]);
    expect(result.services[0]).not.toHaveProperty('previewOnly');
  });

  it('routes a blank-but-present repository through the resolver as a non-actionable failure', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(BLANK_REPOSITORY_YAML);
    mockResolveEnvironmentServices.mockResolvedValue({
      complete: true,
      pending: [],
      truncated: false,
      services: [
        {
          key: 'issue:org/root:blank-repository',
          name: 'blank-repository',
          originalName: 'blank-repository',
          type: null,
          defaultActive: true,
          repository: 'org/root',
          branch: 'main',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: 'repository_name_missing',
        },
      ],
      unresolved: [
        {
          key: 'issue:org/root:blank-repository',
          name: 'blank-repository',
          originalName: 'blank-repository',
          defaultActive: true,
          repository: 'org/root',
          branch: 'main',
          status: 'unresolved',
          reason: 'repository_name_missing',
        },
      ],
    });

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(mockResolveEnvironmentServices).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: false,
      services: [
        {
          name: 'blank-repository',
          type: null,
          defaultActive: true,
          editable: false,
          repository: 'org/root',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: 'Service reference is missing a repository name.',
        },
      ],
      unresolved: [
        {
          name: 'blank-repository',
          repository: 'org/root',
          branch: 'main',
          status: 'unresolved',
          reason: 'Service reference is missing a repository name.',
        },
      ],
    });
  });

  it('never reinterprets a serviceId reference as its coincident YAML service', async () => {
    const { service } = makeService([rootRepository]);
    mockGetYamlFileContentFromBranch.mockResolvedValue(SERVICE_ID_YAML);
    useActualResolver();

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(lastActualResolution?.services).toEqual([
      expect.objectContaining({
        key: 'issue:org/root@main:yaml-service:service_id_not_supported',
        name: 'yaml-service',
        type: null,
        repository: 'org/root',
        resolvedFromRepositoryId: null,
        branch: 'main',
        status: 'unresolved',
        reason: 'service_id_not_supported',
      }),
    ]);
    expect(result).toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: false,
      services: [
        {
          name: 'yaml-service',
          type: null,
          defaultActive: true,
          editable: false,
          repository: 'org/root',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: 'serviceId references in lifecycle.yaml are no longer supported.',
        },
      ],
      unresolved: [
        {
          name: 'yaml-service',
          repository: 'org/root',
          branch: 'main',
          status: 'unresolved',
          reason: 'serviceId references in lifecycle.yaml are no longer supported.',
        },
      ],
    });
    expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledTimes(1);
  });

  it('reports a remote name miss as an unresolved row without expanding the referenced repository', async () => {
    const { service } = makeService([rootRepository, remoteRepository]);
    mockGetYamlFileContentFromBranch
      .mockResolvedValueOnce(CROSS_REPOSITORY_YAML)
      .mockResolvedValueOnce(REMOTE_SERVICE_ID_YAML);
    useActualResolver();

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(mockGetYamlFileContentFromBranch).toHaveBeenNthCalledWith(2, 'org/remote', 'main');
    expect(mockListBranchesForRepo).not.toHaveBeenCalled();
    expect(result).toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: false,
      services: [
        { name: 'local', type: 'docker', defaultActive: true, editable: false },
        {
          name: 'remote-handle',
          type: null,
          defaultActive: true,
          editable: false,
          repository: 'org/remote',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: "Service was not found in this repository's lifecycle.yaml.",
        },
      ],
      unresolved: [
        {
          name: 'remote-handle',
          repository: 'org/remote',
          branch: 'main',
          status: 'unresolved',
          reason: "Service was not found in this repository's lifecycle.yaml.",
        },
      ],
    });
  });

  it('lets generic remote GitHub failures reach the resolver classifier', async () => {
    const { service } = makeService([rootRepository, remoteRepository]);
    const githubError = Object.assign(new Error('GitHub gateway failed'), { status: 500 });
    mockGetYamlFileContentFromBranch.mockResolvedValueOnce(CROSS_REPOSITORY_YAML).mockRejectedValueOnce(githubError);
    useActualResolver();

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(mockGetYamlFileContentFromBranch).toHaveBeenNthCalledWith(2, 'org/remote', 'main');
    expect(mockListBranchesForRepo).not.toHaveBeenCalled();
    expect(result).toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: false,
      services: [
        { name: 'local', type: 'docker', defaultActive: true, editable: false },
        {
          name: 'remote-handle',
          type: null,
          defaultActive: true,
          editable: false,
          repository: 'org/remote',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: 'lifecycle.yaml could not be loaded from this repository.',
        },
      ],
      unresolved: [
        {
          name: 'remote-handle',
          repository: 'org/remote',
          branch: 'main',
          status: 'unresolved',
          reason: 'lifecycle.yaml could not be loaded from this repository.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('config_unavailable');
  });

  it('projects resolved, collision, and failure rows and passes truncation through', async () => {
    const { service, queryChains } = makeService([rootRepository, remoteRepository]);
    mockGetYamlFileContentFromBranch
      .mockResolvedValueOnce(CROSS_REPOSITORY_YAML)
      .mockResolvedValueOnce(LOCAL_ONLY_YAML);
    mockResolveEnvironmentServices.mockImplementation(async (input) => {
      const repository = await input.dependencies.resolveRepository('ORG/REMOTE');
      await input.dependencies.fetchConfig(repository, 'main');
      return {
        complete: true,
        pending: [],
        truncated: true,
        services: [
          {
            key: 'service:42:local',
            name: 'local',
            originalName: 'local',
            type: 'docker',
            defaultActive: true,
            repository: 'org/root',
            branch: 'main',
            resolvedFromRepositoryId: 42,
            status: 'resolved',
          },
          {
            key: 'service:84:remote-exact',
            name: 'remote-exact',
            originalName: 'remote-exact',
            type: 'github',
            defaultActive: true,
            repository: 'org/remote',
            branch: 'remote-main',
            resolvedFromRepositoryId: 84,
            status: 'resolved',
          },
          {
            key: 'service:84:shared',
            name: 'shared',
            originalName: 'shared',
            type: 'github',
            defaultActive: true,
            repository: 'org/remote',
            branch: 'release',
            resolvedFromRepositoryId: 84,
            status: 'resolved',
          },
          {
            key: 'service:85:shared',
            name: 'shared-a1b2c3',
            originalName: 'shared',
            type: 'github',
            defaultActive: true,
            repository: 'org/other',
            branch: 'release',
            resolvedFromRepositoryId: 85,
            status: 'resolved',
          },
          {
            key: 'service:84:mixed-collision',
            name: 'mixed-collision-a1b2c3',
            originalName: 'mixed-collision',
            type: 'github',
            defaultActive: true,
            repository: 'org/remote',
            branch: 'release',
            resolvedFromRepositoryId: 84,
            status: 'resolved',
          },
          {
            key: 'issue:org/missing:mixed-collision',
            name: 'mixed-collision',
            originalName: 'mixed-collision',
            type: null,
            defaultActive: false,
            repository: 'org/missing',
            branch: 'main',
            resolvedFromRepositoryId: null,
            status: 'unresolved',
            reason: 'service_not_found',
          },
          {
            key: 'issue:org/remote:rate',
            name: 'rate-limited-service',
            originalName: 'rate-limited-service',
            type: null,
            defaultActive: false,
            repository: 'org/remote',
            branch: 'remote-main',
            resolvedFromRepositoryId: null,
            status: 'rate_limited',
            reason: 'github_rate_limited',
          },
        ],
        unresolved: [
          {
            key: 'issue:org/missing:mixed-collision',
            name: 'mixed-collision',
            originalName: 'mixed-collision',
            defaultActive: false,
            repository: 'org/missing',
            branch: 'main',
            status: 'unresolved',
            reason: 'service_not_found',
          },
          {
            key: 'issue:org/remote:rate',
            name: 'rate-limited-service',
            originalName: 'rate-limited-service',
            defaultActive: false,
            repository: 'org/remote',
            branch: 'remote-main',
            status: 'rate_limited',
            reason: 'github_rate_limited',
          },
        ],
      };
    });

    const result = await service.previewEnvironmentConfig('org/root', 'main');

    expect(mockResolveEnvironmentServices).toHaveBeenCalledWith(
      expect.objectContaining({
        rootRepository,
        rootBranch: 'main',
      })
    );
    expect(queryChains).toHaveLength(2);
    expect(queryChains[1].whereRaw).toHaveBeenCalledWith('lower("fullName") = ?', ['org/remote']);
    expect(queryChains[1].whereNull).toHaveBeenCalledWith('deletedAt');
    expect(mockListBranchesForRepo).not.toHaveBeenCalled();
    expect(mockGetYamlFileContentFromBranch).toHaveBeenNthCalledWith(2, 'org/remote', 'main');
    expect(result).toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: true,
      services: [
        { name: 'local', type: 'docker', defaultActive: true, editable: false },
        {
          name: 'remote-exact',
          type: 'github',
          defaultActive: true,
          editable: true,
          repository: 'org/remote',
          resolvedFromRepositoryId: 84,
          status: 'resolved',
        },
        {
          name: 'shared',
          type: 'github',
          defaultActive: true,
          editable: false,
          repository: 'org/remote',
          resolvedFromRepositoryId: 84,
          status: 'resolved',
          reason: 'Service-name collisions are preview-only until collision-safe build names are persisted.',
          previewOnly: true,
        },
        {
          name: 'shared-a1b2c3',
          type: 'github',
          defaultActive: true,
          editable: false,
          repository: 'org/other',
          resolvedFromRepositoryId: 85,
          status: 'resolved',
          reason: 'Service-name collisions are preview-only until collision-safe build names are persisted.',
          previewOnly: true,
        },
        {
          name: 'mixed-collision-a1b2c3',
          type: 'github',
          defaultActive: true,
          editable: false,
          repository: 'org/remote',
          resolvedFromRepositoryId: 84,
          status: 'resolved',
          reason: 'Service-name collisions are preview-only until collision-safe build names are persisted.',
          previewOnly: true,
        },
        {
          name: 'mixed-collision',
          type: null,
          defaultActive: false,
          editable: false,
          repository: 'org/missing',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: "Service was not found in this repository's lifecycle.yaml.",
          previewOnly: true,
        },
        {
          name: 'rate-limited-service',
          type: null,
          defaultActive: false,
          editable: false,
          repository: 'org/remote',
          resolvedFromRepositoryId: null,
          status: 'rate_limited',
          reason: 'GitHub rate limit reached. Try again shortly.',
        },
      ],
      unresolved: [
        {
          name: 'mixed-collision',
          repository: 'org/missing',
          branch: 'main',
          status: 'unresolved',
          reason: "Service was not found in this repository's lifecycle.yaml.",
        },
        {
          name: 'rate-limited-service',
          repository: 'org/remote',
          branch: 'remote-main',
          status: 'rate_limited',
          reason: 'GitHub rate limit reached. Try again shortly.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('github_rate_limited');
  });
});
