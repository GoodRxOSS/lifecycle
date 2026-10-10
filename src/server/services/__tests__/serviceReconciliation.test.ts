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

/**
 * Drives the real reconciliation path (webhook intent -> mailbox -> queue ->
 * claim -> config -> image -> rollout -> observe -> status) on a simulated
 * clock. Only the leaves are simulated: the image build, the Kubernetes
 * apply, the YAML import and the queue transport.
 */

const logs: string[] = [];
const sim: any = {};

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

jest.mock('server/lib/logger', () => {
  const record = (level: string) => (a: any, b?: any) => {
    const msg = typeof a === 'string' ? a : b;
    if (typeof msg === 'string') logs.push(`${level} ${msg}`);
  };
  return {
    getLogger: jest.fn(() => ({
      error: record('error'),
      fatal: record('fatal'),
      info: record('info'),
      warn: record('warn'),
      debug: () => undefined,
    })),
    withLogContext: jest.fn((_ctx, fn) => fn()),
    extractContextForQueue: jest.fn(() => ({})),
    updateLogContext: jest.fn(),
    LogStage: {},
  };
});

jest.mock('shared/config', () => ({
  TMP_PATH: '/tmp',
  QUEUE_NAMES: {
    DELETE_QUEUE: 'delete_queue_test',
    BUILD_QUEUE: 'build_queue_test',
    DEPLOYMENT_RECONCILIATION: 'deployment_reconciliation_test',
    SERVICE_RECONCILIATION: 'service_reconciliation_test',
    API_ENV_CREATE: 'api_env_create_test',
    API_ENV_EXPIRY: 'api_env_expiry_test',
    RESOLVE_AND_DEPLOY: 'resolve_and_deploy_test',
    BUILD_CLEANUP_QUEUE: 'build_cleanup_test',
    BUILD_REQUEST_QUEUE: 'build_request_test',
    DEPLOY_CLEANUP: 'deploy_cleanup_test',
    GLOBAL_CONFIG_CACHE_REFRESH: 'global-config-refresh',
    GITHUB_CLIENT_TOKEN_CACHE_REFRESH: 'github-client-token-refresh',
    INGRESS_MANIFEST_QUEUE: 'ingress-manifest',
    INGRESS_MANIFEST: 'ingress-manifest',
    INGRESS_CLEANUP: 'ingress-cleanup',
    AGENT_PREWARM_QUEUE: 'agent-prewarm',
  },
}));

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: () => sim.buildQuery(),
    transact: async (action: any) => action({}),
  },
}));

jest.mock('server/models/Deploy', () => ({
  __esModule: true,
  default: { query: () => sim.deployQuery() },
}));

jest.mock('server/models', () => ({
  Build: class {},
  Deploy: { query: () => sim.deployQuery() },
  Deployable: class {},
  Environment: class {},
  Repository: { query: () => sim.emptyQuery() },
}));

jest.mock('server/lib/kubernetes', () => ({
  generateManifest: jest.fn(),
  generateDeployManifest: jest.fn(),
  applyManifests: jest.fn(),
  waitForPodReady: jest.fn(),
  createOrUpdateNamespace: jest.fn(),
  deleteBuild: jest.fn(),
  deleteNamespace: jest.fn(),
}));
jest.mock('server/lib/cli', () => ({ deleteBuild: jest.fn() }));
jest.mock('server/lib/kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: jest.fn().mockResolvedValue('default'),
}));
jest.mock('server/lib/github', () => ({
  createGitDeployment: jest.fn(),
  updateGitDeploymentStatus: jest.fn(),
  getPullRequest: jest.fn(),
  getSHAForBranch: jest.fn(),
  compareCommits: jest.fn(),
  getYamlFileContent: jest.fn(),
  getYamlFileContentFromBranch: jest.fn(),
}));
jest.mock('server/lib/helm', () => ({ uninstallHelmReleases: jest.fn() }));
jest.mock('server/lib/helm/utils', () => ({ ingressBannerSnippet: jest.fn(() => '') }));
jest.mock('server/lib/buildEnvVariables', () => ({
  BuildEnvironmentVariables: jest.fn().mockImplementation(() => ({ resolve: jest.fn().mockResolvedValue({}) })),
}));
jest.mock('server/lib/dependencyGraph', () => ({ generateGraph: jest.fn().mockResolvedValue({}) }));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: jest.fn().mockResolvedValue({ serviceAccount: { name: 'default' } }),
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    })),
  },
}));
jest.mock('server/services/deployCleanup', () => jest.fn().mockImplementation(() => ({})));
jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('server/services/webhook', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('server/services/override', () => ({
  __esModule: true,
  isBranchOrExternalUrlEditable: () => true,
  default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('server/lib/fastly', () => jest.fn().mockImplementation(() => ({})));

import BuildService from '../build';
import { DeploymentSupersededError } from 'server/lib/deploymentReconciliation/errors';
import { AuthorityLockLostError } from 'server/lib/authorityLock';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes, PullRequestStatus } from 'shared/constants';
import { ParsingError } from 'server/lib/yamlConfigParser';

const MIN = 60_000;
const BUILD_ID = 7;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ServiceSpec {
  name: string;
  repo: number;
  buildMinutes: number;
}

function createWorld(specs: ServiceSpec[], options: { applyMinutes?: number; readyMinutes?: number } = {}) {
  const applyMs = (options.applyMinutes ?? 0.5) * MIN;
  const readyMs = (options.readyMinutes ?? 2) * MIN;
  const events: string[] = [];
  const now = () => Number((Date.now() / MIN).toFixed(1));
  const log = (line: string) => events.push(`t=${now()}m ${line}`);

  const pullRequest = {
    id: 11,
    status: PullRequestStatus.OPEN,
    deployOnUpdate: true,
    branchName: 'static',
    repository: { githubRepositoryId: 900, fullName: 'org/z' },
    $fetchGraph: async () => undefined,
  };
  const buildRow: any = {
    id: BUILD_ID,
    uuid: 'static-z',
    namespace: 'env-static-z',
    kind: BuildKind.ENVIRONMENT,
    isStatic: true,
    status: BuildStatus.DEPLOYED,
    statusMessage: '',
    runUUID: 'initial',
    deletedAt: null,
    pullRequestId: 11,
    deployEnabled: true,
    desiredGeneration: 0,
    observedGeneration: 0,
    acceptedRefs: {},
  };
  const deployRows: any[] = specs.map((spec, index) => ({
    id: index + 1,
    uuid: `${spec.name}-static-z`,
    buildId: BUILD_ID,
    githubRepositoryId: spec.repo,
    branchName: 'main',
    active: true,
    runUUID: 'initial',
    sha: `${spec.name}-v0`,
    dockerImage: `${spec.name}@${spec.name}-v0`,
    status: DeployStatus.READY,
    statusMessage: '',
    desiredGeneration: 0,
    observedGeneration: 0,
    deployableName: spec.name,
  }));
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));
  const registry = new Set<string>(deployRows.map((row) => row.dockerImage));
  const live = new Map<string, string>(deployRows.map((row) => [row.deployableName, row.dockerImage]));
  const liveAt = new Map<string, number>();
  const failImport = new Map<number, () => Error | null>();
  const failBuild = new Set<string>();
  const applyFailures: Error[] = [];
  const importCounts = new Map<string, number>();
  const serviceConfigFailures: Record<string, string> = {};
  const servicesAddedByConfig: ServiceSpec[] = [];
  const orphanRows = new Set<string>();
  const statusWrites: string[] = [];
  const dependsOn = new Map<string, string[]>();
  const serviceMoves: Array<{ name: string; repo: number; sha: string }> = [];
  const importRefs: Array<{
    filter: number | null;
    repo: number | null;
    ref: string | null;
    pins: Record<string, string> | null;
  }> = [];
  const counters = { builds: new Map<string, number>(), applies: new Map<string, number>() };

  const hydrateDeploy = (row: any) => {
    const deploy: any = {
      ...row,
      deployable: orphanRows.has(row.deployableName)
        ? null
        : {
            name: row.deployableName,
            type: DeployTypes.GITHUB,
            deploymentDependsOn: [...(dependsOn.get(row.deployableName) ?? [])],
          },
    };
    deploy.$fetchGraph = async () => undefined;
    deploy.reload = async () => Object.assign(deploy, row);
    deploy.$query = () => query(() => [row], hydrateDeploy, 'deploy');
    return deploy;
  };
  const hydrateBuild = (row: any) => {
    const build: any = { ...row };
    const attach = async () => {
      build.pullRequest = row.pullRequestId != null ? pullRequest : null;
      build.environment = { id: 5 };
      build.deploys = deployRows.map(hydrateDeploy);
      build.deployables = [];
    };
    void attach();
    build.$fetchGraph = async () => {
      if (sim.fetchGraphGate) {
        const gate = sim.fetchGraphGate;
        sim.fetchGraphGate = null;
        await gate;
      }
      return attach();
    };
    build.$setRelated = (relation: string, value: any) => {
      build[relation] = value;
    };
    build.reload = async () => Object.assign(build, row);
    build.$query = () => query(() => [row], hydrateBuild, 'build');
    return build;
  };

  function query(rows: () => any[], hydrate: (row: any) => any, table = 'deploy') {
    const conditions: Array<(row: any) => boolean> = [];
    let patch: any;
    let single = false;
    const evaluate = () => {
      const found = rows().filter((row) => conditions.every((condition) => condition(row)));
      if (patch) {
        if (sim.failPatchOnce?.(patch, table)) {
          sim.failPatchOnce = null;
          throw new Error('database connection reset');
        }
        found.forEach((row) => {
          if (row === buildRow && patch.status) statusWrites.push(`${patch.status}:${patch.statusMessage ?? ''}`);
          Object.assign(row, patch);
        });
        return found.length;
      }
      if (single) return found[0] ? hydrate(found[0]) : undefined;
      return found.map(hydrate);
    };
    const compare = (operator: string, left: any, right: any) => {
      switch (operator) {
        case '<':
          return Number(left) < Number(right);
        case '>':
          return Number(left) > Number(right);
        case '<=':
          return Number(left) <= Number(right);
        case '>=':
          return Number(left) >= Number(right);
        default:
          return left === right;
      }
    };
    const q: any = {
      select: () => q,
      withGraphFetched: () => q,
      forUpdate: () => q,
      orderBy: () => q,
      limit: () => q,
      findById: (id: number) => {
        single = true;
        conditions.push((row) => row.id === id);
        return q;
      },
      findOne: (criteria: Record<string, any>) => {
        single = true;
        Object.entries(criteria).forEach(([key, value]) => conditions.push((row) => row[key] === value));
        return q;
      },
      where: (key: any, operatorOrValue?: any, value?: any) => {
        if (typeof key === 'object') {
          Object.entries(key).forEach(([field, expected]) => conditions.push((row) => row[field] === expected));
        } else if (value === undefined) {
          conditions.push((row) => row[key] === operatorOrValue);
        } else {
          conditions.push((row) => compare(operatorOrValue, row[key], value));
        }
        return q;
      },
      whereRaw: (sql: string, bindings: string[]) => {
        const operator = sql.includes('>') ? '>' : '<';
        conditions.push((row) => compare(operator, row[bindings[0]], row[bindings[1]]));
        return q;
      },
      whereNull: (key: string) => {
        conditions.push((row) => row[key] == null);
        return q;
      },
      whereNot: (key: string, value: any) => {
        conditions.push((row) => row[key] !== value);
        return q;
      },
      whereNotIn: (key: string, values: any[]) => {
        conditions.push((row) => !values.includes(row[key]));
        return q;
      },
      whereIn: (key: string, values: any[]) => {
        conditions.push((row) => values.includes(row[key]));
        return q;
      },
      patch: (value: any) => {
        patch = value;
        return q;
      },
      then: (resolve: any, reject: any) => Promise.resolve().then(evaluate).then(resolve, reject),
    };
    return q;
  }

  sim.buildQuery = () => query(() => [buildRow], hydrateBuild, 'build');
  sim.deployQuery = () => query(() => deployRows, hydrateDeploy, 'deploy');
  sim.emptyQuery = () =>
    query(
      () => [],
      (row) => row,
      'none'
    );
  sim.failPatchOnce = null;
  sim.fetchGraphGate = null;
  sim.importGate = null;

  // One mutex per resource, so the simulator exercises the same serialization the Redis locks provide.
  const held = new Map<string, Promise<void>>();
  const redlock = {
    lock: async (resource: string) => {
      const previous = held.get(resource) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      held.set(
        resource,
        previous.then(() => current)
      );
      await previous;
      const lock: any = { unlock: async () => release(), extend: async () => lock };
      return lock;
    },
  };

  const isRowCurrent = (deployId: number, runUUID: string, generation?: number) => {
    const deploy = deployRows.find((row) => row.id === deployId);
    return Boolean(
      deploy?.runUUID === runUUID &&
        (generation == null || (deploy.desiredGeneration === generation && deploy.observedGeneration < generation))
    );
  };

  const fencedDeployPatch = (deployId: number, runUUID: string, patch: any) => {
    const deploy = deployRows.find((row) => row.id === deployId);
    if (deploy?.runUUID === runUUID) Object.assign(deploy, patch);
  };

  const DeployLeaf = {
    findOrCreateDeploys: async (
      _env: any,
      _build: any,
      githubRepositoryId?: number,
      sourceRef?: string | null,
      sourceBranch?: string | null,
      _sourceGithubRepositoryId?: number | null,
      acceptedSourcePins?: Record<string, string>
    ) => {
      for (const row of deployRows) {
        const target =
          !githubRepositoryId ||
          (row.githubRepositoryId === githubRepositoryId && (!sourceBranch || row.branchName === sourceBranch));
        if (!target) continue;
        if (sourceRef && row.githubRepositoryId === githubRepositoryId) row.sha = sourceRef;
        else row.sha = acceptedSourcePins?.[`${row.githubRepositoryId}:${row.branchName}`] ?? row.sha;
      }
      return deployRows.map(hydrateDeploy);
    },
    buildImage: async (
      deploy: any,
      _index: number,
      runUUID: string,
      _sourceRef: string | null,
      _sourceRepo: number | null,
      _sourceBranch: string | null,
      generation?: number
    ) => {
      const name = deploy.deployableName;
      if (!isRowCurrent(deploy.id, runUUID, generation)) return true;
      const row = deployRows.find((candidate) => candidate.id === deploy.id);
      const tag = `${name}@${row.sha}`;
      if (failBuild.has(name)) {
        fencedDeployPatch(deploy.id, runUUID, {
          status: DeployStatus.BUILD_FAILED,
          statusMessage: 'Image build failed.',
        });
        log(`gen${generation} ${name}: build FAILED`);
        return false;
      }
      if (registry.has(tag)) {
        fencedDeployPatch(deploy.id, runUUID, { status: DeployStatus.BUILT, dockerImage: tag });
        log(`gen${generation} ${name}: image exists ${tag}`);
        return true;
      }
      counters.builds.set(name, (counters.builds.get(name) ?? 0) + 1);
      fencedDeployPatch(deploy.id, runUUID, { status: DeployStatus.BUILDING });
      log(`gen${generation} ${name}: build start ${tag}`);
      await sleep(specByName.get(name)!.buildMinutes * MIN);
      registry.add(tag);
      if (!isRowCurrent(deploy.id, runUUID, generation)) {
        log(`gen${generation} ${name}: build done ${tag} (superseded, result not published)`);
        return true;
      }
      log(`gen${generation} ${name}: build done ${tag}`);
      fencedDeployPatch(deploy.id, runUUID, { status: DeployStatus.BUILT, dockerImage: tag });
      return true;
    },
  };

  const queue = {
    active: new Set<string>(),
    adds: [] as Array<{ data: any; opts: any }>,
    finalFailures: [] as string[],
    attempts: [] as string[],
    dropNext: 0,
    add(data: any, opts: any) {
      queue.adds.push({ data, opts });
      if (queue.dropNext > 0) {
        queue.dropNext -= 1;
        log(`SIGNAL DROPPED ${opts?.jobId}`);
        return Promise.resolve();
      }
      const jobId = opts?.jobId;
      if (queue.active.has(jobId)) return Promise.resolve();
      queue.active.add(jobId);
      const attempts = 10;
      const run = async (attemptsMade: number): Promise<void> => {
        queue.attempts.push(`${jobId}#${attemptsMade}`);
        try {
          await service.processDeploymentReconciliationQueue({ data, attemptsMade, opts: { attempts } });
          queue.active.delete(jobId);
        } catch (error: any) {
          if (attemptsMade + 1 >= attempts) {
            queue.active.delete(jobId);
            queue.finalFailures.push(`${jobId}: ${error?.message}`);
            return;
          }
          await sleep(5000 * 2 ** attemptsMade);
          return run(attemptsMade + 1);
        }
      };
      void run(0);
      return Promise.resolve();
    },
  };

  const service: any = new BuildService(
    {
      models: {
        Build: { query: sim.buildQuery },
        Deploy: { query: sim.deployQuery },
        Repository: { query: sim.emptyQuery },
      },
      services: {
        Deployable: {
          upsertDeployables: async (...args: any[]) => {
            const repo = args[5];
            const scope = repo == null ? 'root' : String(repo);
            importCounts.set(scope, (importCounts.get(scope) ?? 0) + 1);
            importRefs.push({
              filter: repo ?? null,
              repo: args[8] ?? null,
              ref: args[6] ?? null,
              pins: args[9] ?? null,
            });
            if (repo == null && sim.importGate) {
              const gate = sim.importGate;
              sim.importGate = null;
              await gate;
            }
            const failure = failImport.get(repo ?? 900)?.();
            if (failure) {
              log(`import repo=${scope} FAILED: ${failure.message}`);
              throw failure;
            }
            if (repo == null) {
              for (const move of serviceMoves.splice(0)) {
                const moved = deployRows.find((candidate) => candidate.deployableName === move.name)!;
                Object.assign(moved, { githubRepositoryId: move.repo, sha: move.sha });
                log(`import moved ${move.name} -> repo ${move.repo} @ ${move.sha}`);
              }
              for (const spec of servicesAddedByConfig.splice(0)) {
                deployRows.push({
                  id: deployRows.length + 1,
                  uuid: `${spec.name}-static-z`,
                  buildId: BUILD_ID,
                  githubRepositoryId: spec.repo,
                  branchName: 'main',
                  active: true,
                  runUUID: null,
                  sha: `${spec.name}-v0`,
                  dockerImage: `${spec.name}@${spec.name}-v0`,
                  status: DeployStatus.PENDING,
                  statusMessage: '',
                  desiredGeneration: 0,
                  observedGeneration: 0,
                  deployableName: spec.name,
                });
                specByName.set(spec.name, spec);
                registry.add(`${spec.name}@${spec.name}-v0`);
                live.set(spec.name, `${spec.name}@${spec.name}-v0`);
                log(`import created ${spec.name}`);
              }
            }
            return { canReconcile: false, configFailures: repo == null ? { ...serviceConfigFailures } : {} };
          },
        },
        Deploy: DeployLeaf,
        Webhook: {
          upsertWebhooksWithYaml: async () => undefined,
          webhookQueue: { add: async () => undefined },
        },
        ActivityStream: { updatePullRequestActivityStream: async () => undefined },
      },
    } as any,
    {} as any,
    redlock as any,
    {
      registerQueue: (name: string) => ({
        add: (_jobName: string, data: any, opts: any) =>
          name === 'service_reconciliation_test' ? queue.add(data, opts) : Promise.resolve(),
        process: jest.fn(),
        on: jest.fn(),
      }),
    } as any
  );

  jest.spyOn(service, 'generateAndApplyManifests').mockImplementation(async (params: any) => {
    const { build, runUUID, expectedGeneration, unresolvedServices } = params;
    const isCurrent = () => service.isDeploymentRunCurrent(build.id, runUUID, expectedGeneration);
    if (!(await isCurrent())) throw new DeploymentSupersededError();
    const injected = applyFailures.shift();
    if (injected) throw injected;
    const failed = new Set([DeployStatus.ERROR, DeployStatus.BUILD_FAILED, DeployStatus.DEPLOY_FAILED]);
    // A fenced rollout takes exactly the rows this run claimed; rows already READY were rolled out by an earlier attempt.
    const targets = deployRows.filter(
      (row) =>
        row.runUUID === runUUID &&
        row.desiredGeneration === expectedGeneration &&
        !failed.has(row.status) &&
        row.status !== DeployStatus.READY
    );
    const blocked = new Set<string>([
      ...(unresolvedServices ?? []),
      ...deployRows.filter((row) => failed.has(row.status)).map((row) => row.deployableName),
    ]);
    const applied: any[] = [];
    await sleep(applyMs);
    for (const row of targets) {
      // The per-service promotion gate re-checks the row inside the lock.
      if (!isRowCurrent(row.id, runUUID, expectedGeneration)) continue;
      const blockedBy = (dependsOn.get(row.deployableName) ?? []).find((name) => blocked.has(name));
      if (blockedBy) {
        Object.assign(row, { status: DeployStatus.DEPLOY_FAILED, statusMessage: `Not deployed: ${blockedBy} failed.` });
        log(`gen${expectedGeneration} ${row.deployableName}: BLOCKED by ${blockedBy}`);
        continue;
      }
      applied.push(row);
      // The real apply path writes progress fenced on the run token alone.
      fencedDeployPatch(row.id, runUUID, {
        status: DeployStatus.DEPLOYING,
        statusMessage: 'Waiting for pods to be ready',
      });
      const before = live.get(row.deployableName);
      live.set(row.deployableName, row.dockerImage);
      if (before !== row.dockerImage) liveAt.set(row.deployableName, now());
      counters.applies.set(row.deployableName, (counters.applies.get(row.deployableName) ?? 0) + 1);
      log(
        `gen${expectedGeneration} ${row.deployableName}: APPLIED ${row.dockerImage}${
          before === row.dockerImage ? ' (re-rollout)' : ''
        }`
      );
    }
    await sleep(readyMs);
    for (const row of applied) {
      if (isRowCurrent(row.id, runUUID, expectedGeneration)) Object.assign(row, { status: DeployStatus.READY });
    }
    if (!(await isCurrent())) throw new DeploymentSupersededError();
    return true;
  });

  let shaCounter = 0;
  const merge = async (name: string) => {
    const spec = specByName.get(name)!;
    shaCounter += 1;
    const sha = `${name}-v${shaCounter}`;
    log(`MERGE ${name} -> ${sha}`);
    await service.enqueueResolveAndDeployBuild({
      buildId: BUILD_ID,
      githubRepositoryId: spec.repo,
      sourceRef: sha,
      sourceGithubRepositoryId: spec.repo,
      sourceBranch: 'main',
    });
    return sha;
  };

  // A push that asks for a full pass, as a pull request with failed services does.
  const mergeFull = async (name: string) => {
    const spec = specByName.get(name)!;
    shaCounter += 1;
    const sha = `${name}-v${shaCounter}`;
    log(`MERGE(full) ${name} -> ${sha}`);
    await service.enqueueResolveAndDeployBuild({
      buildId: BUILD_ID,
      sourceRef: sha,
      sourceGithubRepositoryId: spec.repo,
      sourceBranch: 'main',
    });
    return sha;
  };

  const pushConfigRepo = async () => {
    shaCounter += 1;
    const sha = `z-v${shaCounter}`;
    log(`PUSH Z -> ${sha}`);
    await service.enqueueResolveAndDeployBuild({
      buildId: BUILD_ID,
      sourceRef: sha,
      sourceGithubRepositoryId: 900,
      sourceBranch: 'static',
    });
    return sha;
  };

  const redeployEnvironment = async (runUUID?: string) => {
    log(`ENV REDEPLOY ${runUUID ?? 'auto'}`);
    await service.enqueueResolveAndDeployBuild({ buildId: BUILD_ID, ...(runUUID ? { runUUID } : {}) });
  };

  const row = (name: string) => deployRows.find((candidate) => candidate.deployableName === name)!;
  const settled = () => deployRows.every((candidate) => candidate.observedGeneration === candidate.desiredGeneration);

  return {
    service,
    buildRow,
    deployRows,
    row,
    live,
    liveAt,
    registry,
    events,
    counters,
    failImport,
    failBuild,
    applyFailures,
    importCounts,
    serviceConfigFailures,
    servicesAddedByConfig,
    orphanRows,
    statusWrites,
    dependsOn,
    serviceMoves,
    importRefs,
    queue,
    merge,
    mergeFull,
    pushConfigRepo,
    redeployEnvironment,
    settled,
    log,
  };
}

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

beforeEach(() => {
  logs.length = 0;
  jest.useFakeTimers({ now: 0 });
});

afterEach(() => {
  jest.useRealTimers();
});

const SPECS: ServiceSpec[] = [
  { name: 'A', repo: 100, buildMinutes: 20 },
  { name: 'B', repo: 200, buildMinutes: 3 },
  { name: 'C', repo: 300, buildMinutes: 3 },
  { name: 'D', repo: 400, buildMinutes: 3 },
  { name: 'E', repo: 400, buildMinutes: 3 },
];

describe('service-independent reconciliation', () => {
  test('a merge to B while A builds leaves A untouched: A ships once, on its own schedule', async () => {
    const world = createWorld(SPECS);
    const aSha = await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);
    const bSha = await world.merge('B');
    await jest.advanceTimersByTimeAsync(6 * MIN);

    expect(world.live.get('B')).toBe(`B@${bSha}`);
    expect(world.buildRow.status).toBe(BuildStatus.BUILDING);

    await jest.advanceTimersByTimeAsync(30 * MIN);

    expect(world.live.get('A')).toBe(`A@${aSha}`);
    expect(world.liveAt.get('A')).toBe(20.5);
    expect(world.liveAt.get('B')).toBe(8.5);
    expect(world.counters.builds.get('A')).toBe(1);
    expect(world.counters.applies.get('B')).toBe(1);
    expect(logs.filter((line) => line.includes('rollout skipped'))).toEqual([]);
    expect(world.settled()).toBe(true);
    expect(world.buildRow.observedGeneration).toBe(world.buildRow.desiredGeneration);
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
  });

  test('a newer merge to A supersedes its in-flight run and only the newest SHA rolls out', async () => {
    const world = createWorld(SPECS);
    const first = await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);
    const second = await world.merge('A');
    await jest.advanceTimersByTimeAsync(40 * MIN);

    expect(world.live.get('A')).toBe(`A@${second}`);
    expect(world.events.some((line) => line.includes(`A@${first} (superseded, result not published)`))).toBe(true);
    expect(world.counters.builds.get('A')).toBe(2);
    expect(world.counters.applies.get('A')).toBe(1);
    expect(world.row('A').observedGeneration).toBe(2);
    expect(world.settled()).toBe(true);
  });

  test('a config error in C fails only C; A and B still ship and C recovers on its next merge', async () => {
    const world = createWorld(SPECS);
    const aSha = await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);
    const bSha = await world.merge('B');
    await jest.advanceTimersByTimeAsync(1 * MIN);
    world.failImport.set(300, () => new ParsingError('C lifecycle.yaml is invalid'));
    await world.merge('C');
    await jest.advanceTimersByTimeAsync(30 * MIN);

    expect(world.row('C').status).toBe(DeployStatus.ERROR);
    expect(world.row('C').statusMessage).toContain('C lifecycle.yaml is invalid');
    expect(world.row('C').observedGeneration).toBe(world.row('C').desiredGeneration);
    expect(world.live.get('C')).toBe('C@C-v0');
    expect(world.live.get('A')).toBe(`A@${aSha}`);
    expect(world.live.get('B')).toBe(`B@${bSha}`);
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('C');

    world.failImport.delete(300);
    const cSha = await world.merge('C');
    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(world.live.get('C')).toBe(`C@${cSha}`);
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
    expect(world.settled()).toBe(true);
  });

  test('a config-repo push supersedes in-flight work, and a later A merge supersedes only the A part of that redeploy', async () => {
    const world = createWorld(SPECS);
    const first = await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);
    await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(5 * MIN);
    const second = await world.merge('A');
    await jest.advanceTimersByTimeAsync(60 * MIN);

    expect(world.live.get('A')).toBe(`A@${second}`);
    expect(world.events.some((line) => line.includes(`A@${first} (superseded, result not published)`))).toBe(true);
    for (const name of ['B', 'C', 'D', 'E']) {
      expect(world.row(name).desiredGeneration).toBe(2);
      expect(world.row(name).observedGeneration).toBe(2);
      expect(world.counters.applies.get(name)).toBe(1);
    }
    expect(world.row('A').desiredGeneration).toBe(3);
    expect(world.row('A').observedGeneration).toBe(3);
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
    expect(world.settled()).toBe(true);
  });

  test('D failing its image leaves E, from the same repository, deploying and reports only D', async () => {
    const world = createWorld(SPECS);
    world.failBuild.add('D');
    const sha = await world.merge('D');
    await jest.advanceTimersByTimeAsync(15 * MIN);

    expect(world.row('D').status).toBe(DeployStatus.BUILD_FAILED);
    expect(world.row('D').observedGeneration).toBe(1);
    expect(world.live.get('D')).toBe('D@D-v0');
    expect(world.live.get('E')).toBe(`E@${sha}`);
    expect(world.row('E').status).toBe(DeployStatus.READY);
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('D');
    expect(world.buildRow.statusMessage).not.toContain('E');
    expect(world.settled()).toBe(true);
  });

  test('the service-row redeploy selects only that service repository', async () => {
    const world = createWorld(SPECS);
    await expect(world.service.redeployServiceFromBuild('static-z', 'B', BUILD_ID)).resolves.toMatchObject({
      status: 'success',
    });
    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(world.row('B').desiredGeneration).toBe(1);
    expect(world.row('B').observedGeneration).toBe(1);
    expect(world.counters.applies.get('B')).toBe(1);
    for (const name of ['A', 'C', 'D', 'E']) {
      expect(world.row(name).desiredGeneration).toBe(0);
      expect(world.counters.applies.get(name)).toBeUndefined();
    }
  });

  test('a disabled environment observes new work without building or deploying', async () => {
    const world = createWorld(SPECS);
    world.buildRow.deployEnabled = false;
    (world.buildRow as any).pullRequestId = null;
    await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);

    expect(world.row('A').desiredGeneration).toBe(1);
    expect(world.row('A').observedGeneration).toBe(1);
    expect(world.counters.builds.get('A')).toBeUndefined();
    expect(logs.some((line) => line.includes('observed without execution reason=deploy_disabled'))).toBe(true);
  });

  test('an environment that is tearing down defers pending work', async () => {
    const world = createWorld(SPECS);
    world.buildRow.status = BuildStatus.TEARING_DOWN;
    await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);

    expect(world.row('A').desiredGeneration).toBe(1);
    expect(world.row('A').observedGeneration).toBe(0);
    expect(world.counters.builds.get('A')).toBeUndefined();
    expect(logs.some((line) => line.includes('deferred reason=tearing_down'))).toBe(true);
  });

  test('a transient failure retries only the failing service while B ships, and the final attempt records it', async () => {
    const world = createWorld(SPECS);
    world.failImport.set(100, () => new Error('GitHub API rate limit exceeded'));
    await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);
    const bSha = await world.merge('B');
    await jest.advanceTimersByTimeAsync(60 * MIN);

    expect(world.live.get('B')).toBe(`B@${bSha}`);
    expect(world.liveAt.get('B')).toBe(8.5);
    expect(world.counters.applies.get('B')).toBe(1);
    expect(world.row('A').status).toBe(DeployStatus.ERROR);
    expect(world.row('A').statusMessage).toContain('rate limit');
    expect(world.row('A').observedGeneration).toBe(1);
    expect(world.live.get('A')).toBe('A@A-v0');
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.settled()).toBe(true);
  });

  test('a signal for a replaced generation executes nothing; only the newest intent owns the rows', async () => {
    const world = createWorld(SPECS);
    await world.merge('A');
    const second = await world.merge('A');
    await jest.advanceTimersByTimeAsync(30 * MIN);

    expect(world.row('A').desiredGeneration).toBe(2);
    expect(world.row('A').observedGeneration).toBe(2);
    expect(world.counters.builds.get('A')).toBe(1);
    expect(world.live.get('A')).toBe(`A@${second}`);
    expect(world.events.filter((line) => line.includes('gen1 A: APPLIED'))).toEqual([]);
    expect(world.settled()).toBe(true);
  });

  test('legacy queue payloads are adopted as intents and malformed jobs are rejected', async () => {
    const world = createWorld(SPECS);
    await world.service.processBuildQueue({
      data: {
        buildId: BUILD_ID,
        githubRepositoryId: 200,
        sourceRef: 'B-legacy',
        sourceGithubRepositoryId: 200,
        sourceBranch: 'main',
      },
    });
    expect(world.row('B').desiredGeneration).toBe(1);
    expect(world.queue.adds.filter(({ opts }) => opts.jobId === `reconcile-${BUILD_ID}-1`)).toHaveLength(1);
    await world.service.processResolveAndDeployBuildQueue({ data: { buildId: BUILD_ID, runUUID: 'legacy-full' } });
    expect(world.buildRow.acceptedRefs.all.gen).toBe(2);
    expect(world.queue.adds.filter(({ opts }) => opts.jobId === `reconcile-${BUILD_ID}-2`)).toHaveLength(1);
    await expect(world.service.processDeploymentReconciliationQueue({ data: {} } as any)).rejects.toThrow(
      'buildId and generation are required'
    );
  });

  test('the sweep signals every pending generation found on the rows', async () => {
    const world = createWorld(SPECS);
    world.row('A').desiredGeneration = 3;
    world.row('B').desiredGeneration = 4;
    world.buildRow.desiredGeneration = 4;
    world.buildRow.observedGeneration = 2;
    const add = jest.fn().mockResolvedValue(undefined);
    world.service.deploymentReconciliationQueue = { add };

    await world.service.enqueuePendingDeploymentReconciliations();

    const jobIds = add.mock.calls.map(([, , opts]) => opts.jobId).sort();
    expect(jobIds).toEqual([`reconcile-${BUILD_ID}-3`, `reconcile-${BUILD_ID}-4`]);
  });

  test('the sweep also signals a build whose watermark says settled while a row is still pending', async () => {
    const world = createWorld(SPECS);
    world.buildRow.desiredGeneration = 5;
    world.buildRow.observedGeneration = 5;
    world.row('A').desiredGeneration = 5;
    world.row('A').observedGeneration = 4;
    const add = jest.fn().mockResolvedValue(undefined);
    world.service.deploymentReconciliationQueue = { add };

    await world.service.enqueuePendingDeploymentReconciliations();

    expect(add.mock.calls.map(([, , opts]) => opts.jobId)).toEqual([`reconcile-${BUILD_ID}-5`]);
  });

  test('steady merges to other services never delay A', async () => {
    const many: ServiceSpec[] = [
      { name: 'A', repo: 100, buildMinutes: 20 },
      ...Array.from({ length: 12 }, (_, index) => ({ name: `S${index + 1}`, repo: 1000 + index, buildMinutes: 3 })),
    ];
    const world = createWorld(many);
    const aSha = await world.merge('A');
    for (let minute = 0; minute < 60; minute += 0.5) {
      await jest.advanceTimersByTimeAsync(0.5 * MIN);
      const now = minute + 0.5;
      if (now % 5 === 0) await world.merge(`S${(now / 5) % 12 || 12}`);
    }

    expect(world.live.get('A')).toBe(`A@${aSha}`);
    expect(world.liveAt.get('A')).toBe(20.5);
    expect(world.counters.builds.get('A')).toBe(1);
    expect(world.events.filter((line) => line.includes('(re-rollout)'))).toEqual([]);
  });
});

describe('service-independent reconciliation: review regressions', () => {
  test('a service row that no run has ever owned is claimed and deployed', async () => {
    const world = createWorld(SPECS);
    world.row('C').runUUID = null;
    const sha = await world.merge('C');
    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(world.live.get('C')).toBe(`C@${sha}`);
    expect(world.row('C').observedGeneration).toBe(1);
    expect(world.settled()).toBe(true);
  });

  test('a lost promotion lease after the claim retries the job and resumes the rows it already owns', async () => {
    const world = createWorld(SPECS);
    world.applyFailures.push(new AuthorityLockLostError('deploy-promotion.2'));
    const sha = await world.merge('B');
    await jest.advanceTimersByTimeAsync(15 * MIN);

    expect(world.live.get('B')).toBe(`B@${sha}`);
    expect(world.row('B').observedGeneration).toBe(1);
    expect(world.counters.builds.get('B')).toBe(1);
    expect(world.counters.applies.get('B')).toBe(1);
    expect(world.queue.finalFailures).toEqual([]);
    expect(world.settled()).toBe(true);
  });

  test('a finished generation is never re-imported while an older service is still building', async () => {
    const world = createWorld(SPECS);
    await world.merge('A');
    await jest.advanceTimersByTimeAsync(5 * MIN);
    await world.merge('B');
    await jest.advanceTimersByTimeAsync(6 * MIN);
    expect(world.row('B').observedGeneration).toBe(2);
    const importsAfterB = world.importCounts.get('200') ?? 0;

    const signalsBefore = world.queue.adds.filter(({ opts }) => opts.jobId === `reconcile-${BUILD_ID}-2`).length;
    for (let tick = 0; tick < 12; tick += 1) {
      await world.service.enqueuePendingDeploymentReconciliations();
      await jest.advanceTimersByTimeAsync(0.5 * MIN);
    }
    // The sweep signals only generations that rows still carry, so the finished one is never re-enqueued.
    expect(world.queue.adds.filter(({ opts }) => opts.jobId === `reconcile-${BUILD_ID}-2`).length).toBe(signalsBefore);

    // A replayed delivery of the finished generation exits before touching configuration.
    await world.service.processDeploymentReconciliationQueue({
      data: { buildId: BUILD_ID, generation: 2 },
      attemptsMade: 0,
      opts: { attempts: 10 },
    });
    expect(logs.filter((line) => line.includes('signal ignored reason=already_observed'))).toHaveLength(1);
    expect(world.importCounts.get('200')).toBe(importsAfterB);
    expect(world.row('A').observedGeneration).toBe(0);
  });

  test('a service with a broken lifecycle.yaml fails alone during a config-repo push; the root config and every other service proceed', async () => {
    const world = createWorld(SPECS);
    world.serviceConfigFailures.C = 'C lifecycle.yaml is invalid';
    await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(45 * MIN);

    expect(world.row('C').status).toBe(DeployStatus.ERROR);
    expect(world.row('C').statusMessage).toContain('C lifecycle.yaml is invalid');
    expect(world.row('C').observedGeneration).toBe(1);
    expect(world.counters.builds.get('C')).toBeUndefined();
    for (const name of ['A', 'B', 'D', 'E']) {
      expect(world.row(name).status).toBe(DeployStatus.READY);
      expect(world.row(name).observedGeneration).toBe(1);
    }
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('C');
    expect(world.settled()).toBe(true);
  });

  test('a config-repo push whose signal was lost is recovered by the sweep even after every row was taken by later merges', async () => {
    const world = createWorld([{ name: 'A', repo: 100, buildMinutes: 3 }]);
    world.servicesAddedByConfig.push({ name: 'N', repo: 500, buildMinutes: 3 });
    world.queue.dropNext = 1;
    await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(1 * MIN);
    const aSha = await world.merge('A');
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(world.live.get('A')).toBe(`A@${aSha}`);
    expect(world.deployRows.some((row) => row.deployableName === 'N')).toBe(false);

    for (let tick = 0; tick < 6; tick += 1) {
      await world.service.enqueuePendingDeploymentReconciliations();
      await jest.advanceTimersByTimeAsync(2 * MIN);
    }

    expect(world.deployRows.some((row) => row.deployableName === 'N')).toBe(true);
    expect(world.row('N').observedGeneration).toBe(1);
    expect(world.buildRow.acceptedRefs['source:900:static:all'].observedGen).toBe(1);
    expect(world.settled()).toBe(true);
  });

  test('a service with a broken lifecycle.yaml blocks its dependents and is reported when it has no row yet', async () => {
    const world = createWorld(SPECS);
    world.serviceConfigFailures.N = 'N lifecycle.yaml is invalid';
    await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(45 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('N');
    expect(world.buildRow.statusMessage).toContain('N lifecycle.yaml is invalid');
  });

  test('a root config error is cleared by the next push whose root import succeeds, even a service-scoped one', async () => {
    const world = createWorld(SPECS);
    world.failImport.set(900, () => new ParsingError('root lifecycle.yaml is invalid'));
    await world.redeployEnvironment('label-added');
    await jest.advanceTimersByTimeAsync(5 * MIN);
    expect(world.buildRow.status).toBe(BuildStatus.CONFIG_ERROR);
    expect(world.buildRow.statusMessage).toContain('root lifecycle.yaml is invalid');
    expect(world.settled()).toBe(true);

    world.failImport.delete(900);
    const aSha = await world.merge('A');
    await jest.advanceTimersByTimeAsync(30 * MIN);

    expect(world.importCounts.get('100')).toBe(1);
    expect(world.live.get('A')).toBe(`A@${aSha}`);
    expect(world.row('A').status).toBe(DeployStatus.READY);
    expect(world.settled()).toBe(true);
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
    expect(world.buildRow.statusMessage).toBe('');
    expect(world.statusWrites).toContain('config_error:root lifecycle.yaml is invalid');
  });

  test('a root config error recorded while another service finishes is never overwritten by that finish', async () => {
    const world = createWorld(SPECS);
    world.buildRow.status = BuildStatus.BUILDING;
    const configBuild = await sim.buildQuery().findById(BUILD_ID);

    let release!: () => void;
    sim.fetchGraphGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const derived = world.service.publishDerivedBuildStatus(BUILD_ID);
    await flush();
    expect(sim.fetchGraphGate).toBeNull();

    const rootError = world.service.recordRootConfigError(
      configBuild,
      new ParsingError('root lifecycle.yaml is invalid')
    );
    await flush();
    expect(world.buildRow.status).toBe(BuildStatus.BUILDING);

    release();
    await derived;
    await rootError;
    expect(world.statusWrites).toEqual(['deployed:', 'config_error:root lifecycle.yaml is invalid']);
    expect(world.buildRow.status).toBe(BuildStatus.CONFIG_ERROR);

    await world.service.publishDerivedBuildStatus(BUILD_ID);
    expect(world.buildRow.status).toBe(BuildStatus.CONFIG_ERROR);
  });

  test('a watermark write that fails after rollout is repaired by the retry, which republishes the final status', async () => {
    const world = createWorld(SPECS);
    sim.failPatchOnce = (patch: any, table: string) => table === 'build' && 'observedGeneration' in patch;

    const bSha = await world.merge('B');
    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(world.live.get('B')).toBe(`B@${bSha}`);
    expect(world.row('B').status).toBe(DeployStatus.READY);
    expect(world.queue.attempts).toEqual([`reconcile-${BUILD_ID}-1#0`, `reconcile-${BUILD_ID}-1#1`]);
    expect(world.queue.finalFailures).toEqual([]);
    expect(world.buildRow.observedGeneration).toBe(1);
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
    expect(world.buildRow.acceptedRefs['source:200:main'].observedGen).toBe(1);

    const signalsBefore = world.queue.adds.length;
    for (let tick = 0; tick < 3; tick += 1) {
      await world.service.enqueuePendingDeploymentReconciliations();
      await jest.advanceTimersByTimeAsync(5_000);
    }
    expect(world.queue.adds.length).toBe(signalsBefore);
    expect(logs.filter((line) => line.includes('signal ignored reason=already_observed'))).toHaveLength(0);
  });

  test('a database error during image setup fails the rows it was building; the detached sibling build cannot land after the intent finished', async () => {
    const world = createWorld(SPECS);
    sim.failPatchOnce = (patch: any) => 'deployPipelineId' in patch;

    await world.merge('D');
    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(logs.some((line) => line.includes('Docker: build error'))).toBe(true);
    expect(world.queue.finalFailures).toEqual([]);
    expect(world.settled()).toBe(true);
    expect(world.row('D').status).toBe(DeployStatus.BUILD_FAILED);
    expect(world.row('E').status).toBe(DeployStatus.BUILD_FAILED);
    expect(world.live.get('D')).toBe('D@D-v0');
    expect(world.live.get('E')).toBe('E@E-v0');
    expect(world.row('E').dockerImage).toBe('E@E-v0');
    expect(world.events.some((line) => line.includes('E: build done') && line.includes('result not published'))).toBe(
      true
    );
    expect(world.events.filter((line) => line.includes('APPLIED'))).toEqual([]);
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
  });

  test('an ingress failure note is kept by a derived republish and cleared only by a clean ingress apply', async () => {
    const world = createWorld(SPECS);
    world.buildRow.status = BuildStatus.DEPLOYED;
    world.buildRow.statusMessage = 'Ingress apply failed: kubectl apply exited 1';

    await world.service.publishDerivedBuildStatus(BUILD_ID);
    expect(world.buildRow.statusMessage).toBe('Ingress apply failed: kubectl apply exited 1');

    await world.service.publishDerivedBuildStatus(BUILD_ID, { clearStatusMessage: true });
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
    expect(world.buildRow.statusMessage).toBe('');
  });

  test('a retry after a successful rollout resumes the rows already live instead of rolling them out again', async () => {
    const world = createWorld(SPECS);
    world.service.ingressService.ingressManifestQueue.add = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue(undefined);

    const bSha = await world.merge('B');
    await jest.advanceTimersByTimeAsync(20 * MIN);

    expect(world.live.get('B')).toBe(`B@${bSha}`);
    expect(world.row('B').status).toBe(DeployStatus.READY);
    expect(world.settled()).toBe(true);
    expect(world.queue.attempts).toEqual([`reconcile-${BUILD_ID}-1#0`, `reconcile-${BUILD_ID}-1#1`]);
    expect(world.counters.builds.get('B')).toBe(1);
    expect(world.counters.applies.get('B')).toBe(1);
    expect(world.events.filter((line) => line.includes('(re-rollout)'))).toEqual([]);
    expect(world.service.ingressService.ingressManifestQueue.add).toHaveBeenCalledTimes(2);
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
  });

  test('a full redeploy accepted after a config push subsumes it: one root import and no second environment pass', async () => {
    const world = createWorld(SPECS);
    world.queue.dropNext = 1;
    await world.pushConfigRepo();
    await world.redeployEnvironment('manual');
    await jest.advanceTimersByTimeAsync(30 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.importCounts.get('root')).toBe(1);
    expect(world.buildRow.acceptedRefs['source:900:static:all'].observedGen).toBe(1);
    expect(world.buildRow.acceptedRefs.all.observedGen).toBe(2);
    expect(world.buildRow.observedGeneration).toBe(2);

    for (let tick = 0; tick < 3; tick += 1) {
      await world.service.enqueuePendingDeploymentReconciliations();
      await jest.advanceTimersByTimeAsync(5_000);
    }
    expect(world.queue.adds.filter(({ opts }) => opts.jobId === `reconcile-${BUILD_ID}-1`)).toHaveLength(1);
    expect(world.importCounts.get('root')).toBe(1);
  });

  test('a service whose definition disappeared fails alone; its sibling from the same repository still ships', async () => {
    const world = createWorld(SPECS);
    world.orphanRows.add('E');

    const sha = await world.merge('D');
    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(world.live.get('D')).toBe(`D@${sha}`);
    expect(world.row('E').status).toBe(DeployStatus.ERROR);
    expect(world.row('E').statusMessage).toBe('Service definition missing.');
    expect(world.live.get('E')).toBe('E@E-v0');
    expect(world.settled()).toBe(true);
    expect(world.queue.finalFailures).toEqual([]);
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('Service definition missing.');
  });

  test('a service that fails to import and has no row blocks its dependents and stays reported until an import clears it', async () => {
    const world = createWorld(SPECS);
    world.dependsOn.set('B', ['N']);
    world.serviceConfigFailures.N = 'N lifecycle.yaml is invalid';
    await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(45 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.row('B').status).toBe(DeployStatus.DEPLOY_FAILED);
    expect(world.row('B').statusMessage).toBe('Not deployed: N failed.');
    expect(world.live.get('B')).toBe('B@B-v0');
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('Not imported: N (N lifecycle.yaml is invalid)');

    const aSha = await world.merge('A');
    await jest.advanceTimersByTimeAsync(30 * MIN);
    expect(world.live.get('A')).toBe(`A@${aSha}`);
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('Not imported: N');

    // A manual full redeploy re-evaluates N and re-reports it from the newest environment-wide import.
    await world.redeployEnvironment('manual');
    await jest.advanceTimersByTimeAsync(45 * MIN);
    expect(world.settled()).toBe(true);
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('Not imported: N (N lifecycle.yaml is invalid)');

    delete world.serviceConfigFailures.N;
    await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(45 * MIN);
    expect(world.settled()).toBe(true);
    expect(world.row('B').status).toBe(DeployStatus.READY);
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
    expect(world.buildRow.statusMessage).toBe('');
  });

  test("a full redeploy accepted after a config push imports at that push's revision, not a lagging branch head", async () => {
    const world = createWorld(SPECS);
    world.queue.dropNext = 1;
    const zSha = await world.pushConfigRepo();
    await world.redeployEnvironment('manual');
    await jest.advanceTimersByTimeAsync(30 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.importRefs.filter((entry) => entry.filter == null)).toEqual([
      { filter: null, repo: null, ref: null, pins: { '900:static': zSha } },
    ]);
    expect(world.buildRow.acceptedRefs['source:900:static:all'].observedGen).toBe(1);
  });

  test("a service push honours the root config floor but pays for no other repository's lookup", async () => {
    const world = createWorld(SPECS);
    const zSha = await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(30 * MIN);
    await world.merge('B');
    await world.merge('A');
    await jest.advanceTimersByTimeAsync(30 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.importRefs.find((entry) => entry.filter === 100)?.pins).toEqual({ '900:static': zSha });
  });

  test("a full pass that replaces an earlier full-pass push still deploys that push's revision", async () => {
    const world = createWorld(SPECS);
    world.queue.dropNext = 1;
    const a1 = await world.mergeFull('A');
    const b1 = await world.mergeFull('B');
    await jest.advanceTimersByTimeAsync(45 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.buildRow.acceptedRefs['source:100:main:all'].observedGen).toBe(1);
    expect(world.live.get('A')).toBe(`A@${a1}`);
    expect(world.live.get('B')).toBe(`B@${b1}`);
  });

  test('a service that moves to another repository is still deployed by the push that claimed it', async () => {
    const world = createWorld(SPECS);
    let releaseImport!: () => void;
    sim.importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    await world.redeployEnvironment('full');
    await jest.advanceTimersByTimeAsync(1_000);
    world.serviceMoves.push({ name: 'A', repo: 101, sha: 'A-moved' });
    await world.merge('A');
    await jest.advanceTimersByTimeAsync(1_000);
    releaseImport();
    await jest.advanceTimersByTimeAsync(45 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.row('A').githubRepositoryId).toBe(101);
    expect(world.row('A').desiredGeneration).toBe(2);
    expect(world.live.get('A')).toBe('A@A-moved');
    expect(world.buildRow.status).toBe(BuildStatus.DEPLOYED);
  });

  test("a config error on a push that lands mid-rollout keeps its row failed despite the superseded run's late writes", async () => {
    const world = createWorld(SPECS);
    await world.merge('B');
    await jest.advanceTimersByTimeAsync(3.2 * MIN);
    expect(world.row('B').status).toBe(DeployStatus.BUILT);

    world.failImport.set(200, () => new ParsingError('B lifecycle.yaml is invalid'));
    await world.merge('B');
    await jest.advanceTimersByTimeAsync(5 * MIN);

    expect(world.settled()).toBe(true);
    expect(world.row('B').status).toBe(DeployStatus.ERROR);
    expect(world.row('B').statusMessage).toBe('B lifecycle.yaml is invalid');
    expect(world.buildRow.status).toBe(BuildStatus.ERROR);
    expect(world.buildRow.statusMessage).toContain('B lifecycle.yaml is invalid');
  });

  test('a config-repo push deploys every accepted service SHA instead of a laggy branch head', async () => {
    const world = createWorld(SPECS);
    const accepted = await world.merge('A');
    await world.pushConfigRepo();
    await jest.advanceTimersByTimeAsync(45 * MIN);

    expect(world.live.get('A')).toBe(`A@${accepted}`);
    expect(world.row('A').desiredGeneration).toBe(2);
    expect(world.row('A').observedGeneration).toBe(2);
    expect(world.settled()).toBe(true);
  });
});
