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
const mockRepositoryQuery = jest.fn();
const mockGenerateManifest = jest.fn();
const mockGenerateDeployManifest = jest.fn();
const mockApplyManifests = jest.fn();
const mockWaitForPodReady = jest.fn();
const mockDeleteKubernetesBuild = jest.fn();
const mockDeleteNamespace = jest.fn();
const mockDeleteCliBuild = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockIsFeatureEnabled = jest.fn();
const mockCleanupDeploy = jest.fn();
const mockDeleteServiceRows = jest.fn();
const mockRecordBuildEvent = jest.fn();
const mockRecordIntentConfigFailures = jest.fn();
const mockRecordFirstRollout = jest.fn();
const mockGetServiceOverrideStates = jest.fn();
const mockGenerateGraph = jest.fn().mockResolvedValue({});
const mockWebhookQueueAdd = jest.fn();
const mockGetYamlFileContent = jest.fn();
const mockResolveEnvironmentServices = jest.fn();
const mockAcceptDeploymentIntent = jest.fn().mockResolvedValue({
  accepted: true,
  generation: 1,
  scopeKey: 'all',
  replaced: [],
});

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

jest.mock('../buildEvents', () => ({
  ...jest.requireActual('../buildEvents'),
  recordBuildEvent: (...args: any[]) => mockRecordBuildEvent(...args),
  recordFirstRollout: (...args: any[]) => mockRecordFirstRollout(...args),
}));

jest.mock('server/lib/deploymentReconciliation/mailbox', () => {
  const actual = jest.requireActual('server/lib/deploymentReconciliation/mailbox');
  return {
    ...actual,
    acceptDeploymentIntent: (...args: any[]) => mockAcceptDeploymentIntent(...args),
    recordIntentConfigFailures: (...args: any[]) => mockRecordIntentConfigFailures(...args),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    fatal: jest.fn(),
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
    DELETE_QUEUE: 'delete_queue_test',
    BUILD_QUEUE: 'build_queue_test',
    DEPLOYMENT_RECONCILIATION: 'deployment_reconciliation_test',
    API_ENV_CREATE: 'api_env_create_test',
    API_ENV_EXPIRY: 'api_env_expiry_test',
    RESOLVE_AND_DEPLOY: 'resolve_and_deploy_test',
    BUILD_CLEANUP_QUEUE: 'build_cleanup_test',
    BUILD_REQUEST_QUEUE: 'build_request_test',
    DEPLOY_CLEANUP: 'deploy_cleanup_test',
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
  Repository: {
    query: (...args: any[]) => mockRepositoryQuery(...args),
  },
}));

jest.mock('server/models/yaml', () => {
  const actual = jest.requireActual('server/models/yaml');
  return {
    ...actual,
    resolveEnvironmentServices: (...args: any[]) => mockResolveEnvironmentServices(...args),
  };
});

jest.mock('server/lib/kubernetes', () => ({
  generateManifest: (...args: any[]) => mockGenerateManifest(...args),
  generateDeployManifest: (...args: any[]) => mockGenerateDeployManifest(...args),
  applyManifests: (...args: any[]) => mockApplyManifests(...args),
  waitForPodReady: (...args: any[]) => mockWaitForPodReady(...args),
  createOrUpdateNamespace: jest.fn(),
  deleteBuild: (...args: any[]) => mockDeleteKubernetesBuild(...args),
  deleteNamespace: (...args: any[]) => mockDeleteNamespace(...args),
}));

jest.mock('server/lib/cli', () => ({
  deleteBuild: (...args: any[]) => mockDeleteCliBuild(...args),
}));

jest.mock('server/lib/kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: jest.fn().mockResolvedValue('default'),
}));

jest.mock('server/lib/github', () => ({
  createGitDeployment: jest.fn(),
  updateGitDeploymentStatus: jest.fn(),
  getPullRequest: jest.fn(),
  getSHAForBranch: jest.fn(),
  compareCommits: jest.fn(),
  getYamlFileContent: (...args: any[]) => mockGetYamlFileContent(...args),
  getYamlFileContentFromBranch: jest.fn(),
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

jest.mock('server/lib/dependencyGraph', () => ({
  generateGraph: (...args: any[]) => mockGenerateGraph(...args),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
      isFeatureEnabled: (...args: any[]) => mockIsFeatureEnabled(...args),
    })),
  },
}));

jest.mock('server/services/deployCleanup', () =>
  jest.fn().mockImplementation(() => ({
    cleanupDeploy: (...args: any[]) => mockCleanupDeploy(...args),
    deleteServiceRows: (...args: any[]) => mockDeleteServiceRows(...args),
  }))
);

jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    patchAndUpdateActivityFeed: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('server/services/webhook', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    upsertWebhooksWithYaml: jest.fn().mockResolvedValue(undefined),
    webhookQueue: { add: (...args: any[]) => mockWebhookQueueAdd(...args) },
  })),
}));

jest.mock('server/services/override', () => ({
  __esModule: true,
  isBranchOrExternalUrlEditable: (type?: string) => ['github', 'helm', 'externalHTTP'].includes(type ?? ''),
  default: jest.fn().mockImplementation(() => ({
    getServiceOverrideStates: (...args: any[]) => mockGetServiceOverrideStates(...args),
  })),
}));

jest.mock('server/lib/fastly', () =>
  jest.fn().mockImplementation(() => ({
    getServiceDashboardUrl: jest.fn(),
  }))
);

import BuildService from '../build';
import { BuildStatus } from 'shared/constants';
import { ValidationError } from 'server/lib/yamlConfigValidator';

type Row = Record<string, any>;

/** An in-memory deploys table that answers the worker's queries, so the row bookkeeping runs for real. */
function inMemoryDeploys(rows: Row[]) {
  const query = () => {
    const predicates: Array<(row: Row) => boolean> = [];
    let patch: Row | null = null;
    let first = false;
    let size = false;
    const builder: any = {
      where(column: any, operator?: any, value?: any) {
        if (typeof column === 'object') {
          predicates.push((row) => Object.entries(column).every(([key, expected]) => row[key] === expected));
        } else if (value === undefined) {
          predicates.push((row) => row[column] === operator);
        } else if (operator === '<') {
          predicates.push((row) => row[column] < value);
        } else if (operator === '>') {
          predicates.push((row) => row[column] > value);
        } else {
          throw new Error(`unsupported operator ${operator}`);
        }
        return builder;
      },
      whereNull(column: string) {
        predicates.push((row) => row[column] == null);
        return builder;
      },
      whereNot(column: string, value: any) {
        predicates.push((row) => row[column] !== value);
        return builder;
      },
      whereNotIn(column: string, values: any[]) {
        predicates.push((row) => !values.includes(row[column]));
        return builder;
      },
      select: () => builder,
      orderBy: () => builder,
      withGraphFetched: () => builder,
      findOne(column: any) {
        first = true;
        return builder.where(column);
      },
      patch(values: Row) {
        patch = values;
        return builder;
      },
      resultSize() {
        size = true;
        return builder;
      },
      then(resolve: any, reject: any) {
        const matched = rows.filter((row) => predicates.every((predicate) => predicate(row)));
        let result: unknown = matched;
        if (patch) {
          for (const row of matched) Object.assign(row, patch);
          result = matched.length;
        } else if (size) {
          result = matched.length;
        } else if (first) {
          result = matched[0];
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  };
  return { query };
}

const queueManager = () => ({
  registerQueue: jest.fn(() => ({ add: jest.fn(), process: jest.fn(), on: jest.fn() })),
});
const buildRecord = (overrides: Row = {}): Row => ({
  id: 7,
  uuid: 'b7',
  status: BuildStatus.DEPLOYED,
  deployEnabled: true,
  pullRequestId: 1,
  pullRequest: { status: 'open' },
  deletedAt: null,
  environment: {},
  $fetchGraph: async () => undefined,
  ...overrides,
});
const buildModel = (build: Row) => ({
  query: () => {
    const builder: any = {
      findById: () => builder,
      select: () => builder,
      whereNull: () => builder,
      then: (resolve: any, reject: any) => Promise.resolve(build).then(resolve, reject),
    };
    return builder;
  },
});
const serviceRow = (id: number, name: string, githubRepositoryId: number, generation: number): Row => ({
  id,
  buildId: 7,
  active: true,
  githubRepositoryId,
  branchName: 'feature',
  desiredGeneration: generation,
  observedGeneration: generation - 1,
  runUUID: null,
  status: 'queued',
  statusMessage: null,
  deployable: { name, type: 'github' },
});
/** What the worker stores on the accepted intent, read back by the next attempt's claim. */
const storedConfigFailures = new Map<number, Record<string, string>>();
const recorded = () =>
  mockRecordBuildEvent.mock.calls.map(([, event]: any[]) => ({
    kind: event.kind,
    status: event.status ?? null,
    reason: event.reason ?? null,
    services: event.meta?.services ?? null,
  }));
const finishedMeta = () =>
  mockRecordBuildEvent.mock.calls
    .filter(([, event]: any[]) => event.kind === 'run_finished')
    .map(([, event]: any[]) => event.meta);

function worker(
  rows: Row[],
  intent: Row,
  options: {
    build?: Row;
    configFailures?: Record<string, string>;
    execute?: () => Promise<Row | null>;
    blocked?: string | null;
  } = {}
) {
  const build = options.build ?? buildRecord();
  const service = new BuildService(
    { models: { Deploy: inMemoryDeploys(rows), Build: buildModel(build) } } as any,
    {} as any,
    {} as any,
    queueManager() as any
  );
  const s: any = service;
  jest
    .spyOn(s, 'tryWithDeploymentGenerationLock')
    .mockImplementation((_buildId: unknown, _generation: unknown, action: any) => action());
  jest.spyOn(s, 'claimDeploymentIntent').mockImplementation(async () => ({
    generation: intent.gen,
    token: intent.requestId,
    intent: storedConfigFailures.has(intent.gen)
      ? { ...intent, configFailures: storedConfigFailures.get(intent.gen) }
      : intent,
    acceptedSourcePins: {},
  }));
  jest
    .spyOn(s, 'withCurrentBuildDeploymentLock')
    .mockImplementation(async (_buildId: unknown, _isPending: unknown, action: any) => ({
      admitted: true,
      value: await action(),
    }));
  jest.spyOn(s, 'loadBuildDeploymentAuthority').mockResolvedValue(build);
  if (options.blocked !== undefined) jest.spyOn(s, 'deploymentBlockReason').mockReturnValue(options.blocked);
  jest.spyOn(s, 'claimDeploymentRun').mockResolvedValue(intent.requestId);
  jest.spyOn(s, 'resolveCurrentSourceRef').mockResolvedValue('abc');
  jest.spyOn(s, 'resolveAcceptedSourcePins').mockResolvedValue({});
  jest.spyOn(s, 'importYamlConfigFile').mockResolvedValue({ configFailures: options.configFailures ?? {} });
  jest.spyOn(s, 'prepareDeploymentScope').mockResolvedValue({ build, runUUID: intent.requestId });
  jest.spyOn(s, 'adoptDeploysForIntent').mockResolvedValue(undefined);
  jest.spyOn(s, 'markConfigurationsAsBuilt').mockResolvedValue(undefined);
  jest.spyOn(s, 'publishDerivedBuildStatus').mockResolvedValue(undefined);
  jest.spyOn(s, 'enqueueIngressManifest').mockResolvedValue(undefined);
  const finishIntent = jest.spyOn(s, 'finishIntent').mockResolvedValue(undefined);
  const execute = jest.spyOn(s, 'executeDeploymentScope').mockImplementation(options.execute ?? (async () => null));
  const job = (attemptsMade = 0): any => ({
    data: { buildId: 7, generation: intent.gen },
    attemptsMade,
    opts: { attempts: 10 },
  });
  return { service, finishIntent, execute, job };
}

const push = {
  type: 'source',
  requestId: 'push-1',
  target: 'repository',
  githubRepositoryId: 100,
  branch: 'feature',
  sha: 'abc',
  gen: 5,
};

beforeEach(() => {
  mockRecordBuildEvent.mockReset();
  storedConfigFailures.clear();
  mockRecordIntentConfigFailures
    .mockReset()
    .mockImplementation(async (_buildId: number, generation: number, failures) => {
      storedConfigFailures.set(generation, failures);
      return true;
    });
});

describe('run outcomes over an in-memory deploy table', () => {
  test('a push whose service lifecycle.yaml is broken fails with that reason instead of counting as taken over', async () => {
    const rows = [serviceRow(1, 'api', 100, 5)];
    const { service, finishIntent } = worker(rows, push, {
      blocked: null,
      configFailures: { api: 'Invalid lifecycle.yaml: services[0].name is required' },
    });

    await service.processDeploymentReconciliationQueue(worker(rows, push).job());

    expect(rows[0]).toMatchObject({ runUUID: 'push-1', status: 'error', observedGeneration: 5 });
    expect(recorded()).toEqual([
      { kind: 'run_claimed', status: null, reason: null, services: null },
      {
        kind: 'run_finished',
        status: 'failed',
        reason: 'Invalid lifecycle.yaml: services[0].name is required',
        services: 1,
      },
    ]);
    expect(finishIntent).toHaveBeenCalledWith(7, 5);
  });

  test('a service whose lifecycle.yaml fails before it has a row fails the run, with or without other rows', async () => {
    const failure = { api: 'Invalid lifecycle.yaml: services[0].name is required' };
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const rows = [serviceRow(1, 'web', 100, 5)];
    const withRows = worker(rows, label, {
      blocked: null,
      configFailures: failure,
      execute: async () => {
        rows[0].status = 'ready';
        return (withRows.service as any).summarizeIntentDeploys(7, 'label-1', 5);
      },
    });
    await withRows.service.processDeploymentReconciliationQueue(withRows.job());
    expect(recorded()).toEqual([
      {
        kind: 'run_finished',
        status: 'failed',
        reason: 'Invalid lifecycle.yaml: services[0].name is required',
        services: 2,
      },
    ]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 2,
        failed: 1,
        rollout: true,
        serviceOutcomes: [
          { name: 'api', type: null, status: null, outcome: 'failed', message: failure.api },
          { name: 'web', type: 'github', status: 'ready', outcome: 'ready', message: null },
        ],
      },
    ]);

    mockRecordBuildEvent.mockReset();
    const rowless = worker([], label, { blocked: null, configFailures: failure });
    await rowless.service.processDeploymentReconciliationQueue(rowless.job());
    expect(recorded()).toEqual([
      {
        kind: 'run_finished',
        status: 'failed',
        reason: 'Invalid lifecycle.yaml: services[0].name is required',
        services: 1,
      },
    ]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 1,
        failed: 1,
        serviceOutcomes: [{ name: 'api', type: null, status: null, outcome: 'failed', message: failure.api }],
      },
    ]);
    expect(rowless.finishIntent).toHaveBeenCalledWith(7, 5);
  });

  test('a retry after a config-failed row was observed repeats the first outcome instead of double counting', async () => {
    const rows = [serviceRow(1, 'api', 100, 5), serviceRow(2, 'web', 200, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const retried = worker(rows, label, {
      blocked: null,
      configFailures: { api: 'Invalid lifecycle.yaml: services[0].name is required' },
    });
    retried.execute.mockImplementation(async () => {
      rows[1].status = 'ready';
      return (retried.service as any).summarizeIntentDeploys(7, 'label-1', 5);
    });
    retried.finishIntent.mockRejectedValueOnce(new Error('Redis connection reset')).mockResolvedValue(undefined);

    await expect(retried.service.processDeploymentReconciliationQueue(retried.job(0))).rejects.toThrow(
      'Redis connection reset'
    );
    await retried.service.processDeploymentReconciliationQueue(retried.job(1));

    const finishes = recorded().filter((event) => event.kind === 'run_finished');
    expect(finishes).toEqual([
      {
        kind: 'run_finished',
        status: 'failed',
        reason: 'Invalid lifecycle.yaml: services[0].name is required',
        services: 2,
      },
      {
        kind: 'run_finished',
        status: 'failed',
        reason: 'Invalid lifecycle.yaml: services[0].name is required',
        services: 2,
      },
    ]);
    expect(rows[0]).toMatchObject({ status: 'error', observedGeneration: 5, runUUID: 'label-1' });
  });

  test('a retried repository run keeps counting the service that never had a row', async () => {
    const rows = [serviceRow(1, 'api', 100, 5)];
    const retried = worker(
      rows,
      { ...push },
      {
        blocked: null,
        configFailures: { api: 'Invalid lifecycle.yaml: boom', worker: 'Invalid lifecycle.yaml: boom' },
      }
    );
    retried.finishIntent.mockRejectedValueOnce(new Error('Redis connection reset')).mockResolvedValue(undefined);

    await expect(retried.service.processDeploymentReconciliationQueue(retried.job(0))).rejects.toThrow(
      'Redis connection reset'
    );
    expect(storedConfigFailures.get(5)).toEqual({ worker: 'Invalid lifecycle.yaml: boom' });
    await retried.service.processDeploymentReconciliationQueue(retried.job(1));

    expect(recorded().filter((event) => event.kind === 'run_finished')).toEqual([
      { kind: 'run_finished', status: 'failed', reason: 'Invalid lifecycle.yaml: boom', services: 2 },
      { kind: 'run_finished', status: 'failed', reason: 'Invalid lifecycle.yaml: boom', services: 2 },
    ]);
  });

  test('a retry whose import now rejects a service that already deployed leaves that row ready', async () => {
    const rows = [{ ...serviceRow(1, 'api', 100, 5), status: 'ready', observedGeneration: 5, runUUID: 'label-1' }];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, job } = worker(rows, label, {
      blocked: null,
      configFailures: { api: 'Invalid lifecycle.yaml: services[0].name is required' },
    });

    await service.processDeploymentReconciliationQueue(job(1));

    expect(rows[0]).toMatchObject({ status: 'ready', observedGeneration: 5, runUUID: 'label-1' });
    expect(recorded()).toEqual([{ kind: 'run_finished', status: 'succeeded', reason: null, services: 1 }]);
  });

  test('the final queue attempt records the queue error on the rows it owned, not their queued state', async () => {
    const rows = [{ ...serviceRow(1, 'api', 100, 5), runUUID: 'label-1' }];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service } = worker(rows, label, { blocked: null });

    await expect(
      (service as any).recordFinalDeploymentReconciliationFailure(
        7,
        { generation: 5, token: 'label-1', intent: label },
        new Error('GitHub API 502')
      )
    ).resolves.toBe(true);

    expect(rows[0]).toMatchObject({ status: 'error', statusMessage: 'GitHub API 502', observedGeneration: 5 });
    expect(recorded()).toEqual([{ kind: 'run_finished', status: 'failed', reason: 'GitHub API 502', services: 1 }]);
  });

  test('the final queue attempt of a first deploy whose rows were created but never stamped records the queue error', async () => {
    const rows = [serviceRow(1, 'api', 100, 4)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service } = worker(rows, label, { blocked: null });

    await expect(
      (service as any).recordFinalDeploymentReconciliationFailure(
        7,
        { generation: 5, token: 'label-1', intent: label },
        new Error('GitHub API 502')
      )
    ).resolves.toBe(false);

    expect(rows[0]).toMatchObject({ status: 'queued', desiredGeneration: 4, runUUID: null });
    expect(recorded()).toEqual([{ kind: 'run_finished', status: 'failed', reason: 'GitHub API 502', services: null }]);
    expect(finishedMeta()).toEqual([{ generation: 5, services: null, failed: null }]);
    expect(finishedMeta()[0]).not.toHaveProperty('serviceOutcomes');
  });

  test('the final queue attempt counts the services the import could not read, with or without rows', async () => {
    const failure = { worker: 'Invalid lifecycle.yaml: worker has no image' };
    const label = { type: 'all', requestId: 'label-1', gen: 5, configFailures: failure };

    const rowless = worker([], label, { blocked: null });
    await (rowless.service as any).recordFinalDeploymentReconciliationFailure(
      7,
      { generation: 5, token: 'label-1', intent: label },
      new Error('GitHub API 502')
    );
    expect(recorded()).toEqual([
      { kind: 'run_finished', status: 'failed', reason: 'Invalid lifecycle.yaml: worker has no image', services: 1 },
    ]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 1,
        failed: 1,
        serviceOutcomes: [{ name: 'worker', type: null, status: null, outcome: 'failed', message: failure.worker }],
      },
    ]);

    mockRecordBuildEvent.mockReset();
    const rows = [{ ...serviceRow(1, 'api', 100, 5), status: 'ready', runUUID: 'label-1' }];
    const withRows = worker(rows, label, { blocked: null });
    await (withRows.service as any).recordFinalDeploymentReconciliationFailure(
      7,
      { generation: 5, token: 'label-1', intent: label },
      new Error('GitHub API 502')
    );
    expect(rows[0]).toMatchObject({ status: 'ready' });
    expect(recorded()).toEqual([
      { kind: 'run_finished', status: 'failed', reason: 'Invalid lifecycle.yaml: worker has no image', services: 2 },
    ]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 2,
        failed: 1,
        serviceOutcomes: [
          { name: 'worker', type: null, status: null, outcome: 'failed', message: failure.worker },
          { name: 'api', type: 'github', status: 'ready', outcome: 'ready', message: null },
        ],
      },
    ]);
  });

  test('a service the import could not read fails the run ahead of a row that failed for another reason', async () => {
    const rows = [serviceRow(1, 'api', 100, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, job } = worker(rows, label, {
      blocked: null,
      configFailures: { worker: 'Invalid lifecycle.yaml: worker has no image' },
      execute: async () => {
        Object.assign(rows[0], { status: 'deploy_failed', statusMessage: 'Rollout timed out' });
        return (service as any).summarizeIntentDeploys(7, 'label-1', 5);
      },
    });

    await service.processDeploymentReconciliationQueue(job());

    expect(recorded()).toEqual([
      { kind: 'run_finished', status: 'failed', reason: 'Invalid lifecycle.yaml: worker has no image', services: 2 },
    ]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 2,
        failed: 2,
        rollout: true,
        serviceOutcomes: [
          {
            name: 'worker',
            type: null,
            status: null,
            outcome: 'failed',
            message: 'Invalid lifecycle.yaml: worker has no image',
          },
          { name: 'api', type: 'github', status: 'deploy_failed', outcome: 'failed', message: 'Rollout timed out' },
        ],
      },
    ]);
  });

  test('a succeeded run lists every service it rolled out as ready', async () => {
    const rows = [serviceRow(1, 'api', 100, 5), serviceRow(2, 'web', 200, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, job } = worker(rows, label, {
      blocked: null,
      execute: async () => {
        for (const row of rows) row.status = 'ready';
        return (service as any).summarizeIntentDeploys(7, 'label-1', 5);
      },
    });

    await service.processDeploymentReconciliationQueue(job());

    expect(recorded()).toEqual([{ kind: 'run_finished', status: 'succeeded', reason: null, services: 2 }]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 2,
        failed: 0,
        rollout: true,
        serviceOutcomes: [
          { name: 'api', type: 'github', status: 'ready', outcome: 'ready', message: null },
          { name: 'web', type: 'github', status: 'ready', outcome: 'ready', message: null },
        ],
      },
    ]);
  });

  test('a failed service is listed with its status message, compacted, or the fallback for its status', async () => {
    const rows = [serviceRow(1, 'api', 100, 5), serviceRow(2, 'web', 200, 5), serviceRow(3, 'worker', 300, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, job } = worker(rows, label, {
      blocked: null,
      execute: async () => {
        Object.assign(rows[0], { status: 'deploy_failed', statusMessage: 'Rollout timed out\n   after 10m' });
        rows[1].status = 'ready';
        rows[2].status = 'build_failed';
        return (service as any).summarizeIntentDeploys(7, 'label-1', 5);
      },
    });

    await service.processDeploymentReconciliationQueue(job());

    expect(recorded()).toEqual([
      { kind: 'run_finished', status: 'failed', reason: 'Rollout timed out after 10m', services: 3 },
    ]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 3,
        failed: 2,
        rollout: true,
        serviceOutcomes: [
          {
            name: 'api',
            type: 'github',
            status: 'deploy_failed',
            outcome: 'failed',
            message: 'Rollout timed out after 10m',
          },
          { name: 'web', type: 'github', status: 'ready', outcome: 'ready', message: null },
          {
            name: 'worker',
            type: 'github',
            status: 'build_failed',
            outcome: 'failed',
            message: 'Build failed. Check build logs for details.',
          },
        ],
      },
    ]);
  });

  test('a service that did not report ready is listed as unfinished, without a message', async () => {
    const rows = [serviceRow(1, 'api', 100, 5), serviceRow(2, 'web', 200, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, job } = worker(rows, label, {
      blocked: null,
      execute: async () => {
        rows[0].status = 'built';
        rows[1].status = 'ready';
        return (service as any).summarizeIntentDeploys(7, 'label-1', 5);
      },
    });

    await service.processDeploymentReconciliationQueue(job());

    expect(recorded()).toEqual([
      { kind: 'run_finished', status: 'failed', reason: 'api did not report ready (built)', services: 2 },
    ]);
    expect(finishedMeta()).toEqual([
      {
        generation: 5,
        services: 2,
        failed: 0,
        rollout: true,
        serviceOutcomes: [
          { name: 'api', type: 'github', status: 'built', outcome: 'unfinished', message: null },
          { name: 'web', type: 'github', status: 'ready', outcome: 'ready', message: null },
        ],
      },
    ]);
  });

  test('a run stopped by a broken root lifecycle.yaml records the error without per-service outcomes', async () => {
    const rows = [serviceRow(1, 'api', 100, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, finishIntent, job } = worker(rows, label, { blocked: null });
    jest.spyOn(service as any, 'recordRootConfigError').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'importYamlConfigFile')
      .mockRejectedValue(new ValidationError('services[0].name is required'));

    await service.processDeploymentReconciliationQueue(job());

    expect(rows[0]).toMatchObject({ runUUID: 'label-1', status: 'queued', observedGeneration: 5 });
    expect(recorded()).toEqual([
      { kind: 'run_finished', status: 'failed', reason: 'services[0].name is required', services: null },
    ]);
    expect(finishedMeta()).toEqual([{ generation: 5, services: null, failed: null }]);
    expect(finishedMeta()[0]).not.toHaveProperty('serviceOutcomes');
    expect(finishIntent).toHaveBeenCalledWith(7, 5);
  });

  test('a run taken over mid-run is superseded even when a service failed before it had a row', async () => {
    const rows = [serviceRow(1, 'web', 200, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, job } = worker(rows, label, {
      blocked: null,
      configFailures: { api: 'Invalid lifecycle.yaml: boom' },
      execute: async () => {
        Object.assign(rows[0], { desiredGeneration: 6, runUUID: null, status: 'queued' });
        return { deployed: 0, failed: 0, services: 0, status: 'succeeded', reason: null };
      },
    });

    await service.processDeploymentReconciliationQueue(job());

    expect(recorded()).toEqual([{ kind: 'run_superseded', status: null, reason: 'rows_taken', services: null }]);
  });

  test('a completed run whose finish step fails once records its outcome before the retry, which repeats it', async () => {
    const rows = [serviceRow(1, 'api', 100, 5)];
    const { service, finishIntent, job } = worker(rows, push, {
      blocked: null,
      execute: async () => {
        rows[0].status = 'ready';
        return { deployed: 1, failed: 0, services: 1, status: 'succeeded', reason: null };
      },
    });
    finishIntent.mockRejectedValueOnce(new Error('Redis connection reset')).mockResolvedValue(undefined);

    await expect(service.processDeploymentReconciliationQueue(job(0))).rejects.toThrow('Redis connection reset');
    await service.processDeploymentReconciliationQueue(job(1));

    expect(rows[0]).toMatchObject({ runUUID: 'push-1', status: 'ready', observedGeneration: 5 });
    expect(recorded().map((event) => [event.kind, event.status ?? event.reason])).toEqual([
      ['run_claimed', null],
      ['run_finished', 'succeeded'],
      ['run_finished', 'succeeded'],
    ]);
    expect(finishIntent).toHaveBeenCalledTimes(2);
  });

  test('an environment-wide run whose rows were all taken during the run is superseded, not an empty success', async () => {
    const rows = [serviceRow(1, 'api', 100, 5), serviceRow(2, 'web', 200, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service } = worker(rows, label, {
      blocked: null,
      execute: async () => {
        for (const row of rows) Object.assign(row, { desiredGeneration: 6, runUUID: null, status: 'queued' });
        return { deployed: 0, failed: 0, services: 0, status: 'succeeded', reason: null };
      },
    });

    await service.processDeploymentReconciliationQueue(worker(rows, label).job());

    expect(recorded()).toEqual([{ kind: 'run_superseded', status: null, reason: 'rows_taken', services: null }]);
  });

  test('a request found queued on an environment that is already torn down is recorded as blocked by that teardown', async () => {
    const tornDown = buildRecord({
      status: BuildStatus.TEARING_DOWN,
      deployEnabled: false,
      pullRequestId: null,
      pullRequest: null,
    });
    const rows = [serviceRow(1, 'api', 100, 5)];
    const label = { type: 'all', requestId: 'label-1', gen: 5 };
    const { service, finishIntent } = worker(rows, label, { build: tornDown });

    await service.processDeploymentReconciliationQueue(worker(rows, label).job());

    expect(recorded()).toEqual([{ kind: 'run_blocked', status: null, reason: 'torn_down', services: null }]);
    expect(rows[0].observedGeneration).toBe(5);
    expect(finishIntent).toHaveBeenCalledWith(7, 5);
  });
});
