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

const registeredWorkers: { queue: string; handler: unknown; options: unknown }[] = [];
const workerOnHandlers: Record<string, Record<string, unknown>> = {};
const registeredQueues: { queue: string; options: unknown; add: jest.Mock }[] = [];
const mockQueueAddFactories = new Map<string, () => Promise<unknown>>();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockEmptyAndCloseAllQueues = jest.fn();
const mockRedisClose = jest.fn();

const registerWorker = (queue: string, handler: unknown, options: unknown) => {
  registeredWorkers.push({ queue, handler, options });
  return {
    on: (event: string, callback: unknown) => {
      workerOnHandlers[queue] = { ...(workerOnHandlers[queue] ?? {}), [event]: callback };
    },
  };
};

const registerQueue = (queue: string, options: unknown) => {
  const add = jest.fn(() => mockQueueAddFactories.get(queue)?.() ?? Promise.resolve(undefined));
  registeredQueues.push({ queue, options, add });
  return { add, on: jest.fn() };
};

const mockQueueManager = {
  registerWorker: jest.fn(registerWorker),
  registerQueue: jest.fn(registerQueue),
  emptyAndCloseAllQueues: (...args: unknown[]) => mockEmptyAndCloseAllQueues(...args),
};

jest.mock('server/lib/dependencies', () => ({
  defaultDb: { services: null },
  redisClient: { getConnection: jest.fn(() => ({ connection: 'redis' })) },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: jest.fn(),
  }),
}));
jest.mock('server/services/agent/aiSdkRuntime', () => ({ loadAiSdk: jest.fn() }));
jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS: 300_000,
  resolveAgentSessionCleanupConfig: jest.fn(),
}));
jest.mock('../agentSessionCleanup', () => ({ processAgentSessionCleanup: jest.fn() }));
jest.mock('../agentSessionPrewarm', () => ({ processAgentSessionPrewarm: jest.fn() }));
jest.mock('../agentSandboxSessionLaunch', () => ({ processAgentSandboxSessionLaunch: jest.fn() }));
jest.mock('../agentRunExecute', () => ({ processAgentRunExecute: jest.fn() }));
jest.mock('../agentRunDispatchRecovery', () => ({ processAgentRunDispatchRecovery: jest.fn() }));
jest.mock('../agentEnvironmentWatch', () => ({ processAgentEnvironmentWatch: jest.fn() }));
jest.mock('../workspaceTemplateBuild', () => ({ processWorkspaceTemplateBuild: jest.fn() }));
jest.mock('../apiTokenOwnerSweep', () => ({
  API_TOKEN_OWNER_SWEEP_INTERVAL_MS: 3_600_000,
  processApiTokenOwnerSweep: jest.fn(),
  warnIfApiTokenOwnerSweepUnconfigured: jest.fn(),
}));
jest.mock('server/services/agent/EnvironmentWatchService', () => ({ AGENT_ENV_WATCH_QUEUE_NAME: 'agent_env_watch' }));
jest.mock('server/lib/queueManager', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(() => mockQueueManager) },
}));
jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ close: (...args: unknown[]) => mockRedisClose(...args) })),
  },
}));

import bootstrapJobs from 'server/jobs/index';
import { resolveAgentSessionCleanupConfig } from 'server/lib/agentSession/runtimeConfig';
import { defaultDb } from 'server/lib/dependencies';
import QueueManager from 'server/lib/queueManager';
import RedisClient from 'server/lib/redisClient';
import { loadAiSdk } from 'server/services/agent/aiSdkRuntime';
import { QUEUE_NAMES } from 'shared/config';
import { processApiTokenOwnerSweep, warnIfApiTokenOwnerSweepUnconfigured } from '../apiTokenOwnerSweep';

type JobGlobals = typeof global & {
  sigintHandler?: () => Promise<void>;
  sigtermHandler?: () => Promise<void>;
};

const jobGlobals = global as JobGlobals;

function createServices() {
  return {
    GithubService: { processWebhooks: jest.fn(), processGithubDeployment: jest.fn() },
    ActivityStream: { processComments: jest.fn() },
    GlobalConfig: { setupCacheRefreshJob: jest.fn(), processCacheRefresh: jest.fn() },
    TTLCleanupService: { setupTTLCleanupJob: jest.fn(), processTTLCleanupQueue: jest.fn() },
    SitesService: { setupSitesCleanupJob: jest.fn(), processSitesCleanupQueue: jest.fn() },
    BuildService: {
      setupApiEnvironmentExpiryJob: jest.fn().mockResolvedValue(undefined),
      setupDeploymentReconciliationSweep: jest.fn(),
      processApiEnvironmentCreateQueue: jest.fn(),
      handleApiEnvironmentCreateFailure: jest.fn(),
      processApiEnvironmentExpiryQueue: jest.fn(),
      processDeleteQueue: jest.fn(),
      processResolveAndDeployBuildQueue: jest.fn(),
      processBuildQueue: jest.fn(),
      processDeploymentReconciliationQueue: jest.fn(),
    },
    Webhook: { processWebhookQueue: jest.fn() },
    Ingress: { createOrUpdateIngressForBuild: jest.fn(), ingressCleanupForBuild: jest.fn() },
    DeployCleanupService: { processCleanupQueue: jest.fn() },
    LabelService: { processLabelQueue: jest.fn() },
  } as any;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('bootstrapJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registeredWorkers.length = 0;
    registeredQueues.length = 0;
    Object.keys(workerOnHandlers).forEach((key) => delete workerOnHandlers[key]);
    mockQueueAddFactories.clear();
    defaultDb.services = null;
    delete process.env.NEXT_MANUAL_SIG_HANDLE;
    delete jobGlobals.sigintHandler;
    delete jobGlobals.sigtermHandler;
    mockQueueManager.registerWorker.mockImplementation(registerWorker);
    mockQueueManager.registerQueue.mockImplementation(registerQueue);
    (QueueManager.getInstance as jest.Mock).mockReturnValue(mockQueueManager);
    (RedisClient.getInstance as jest.Mock).mockReturnValue({
      close: (...args: unknown[]) => mockRedisClose(...args),
    });
    (loadAiSdk as jest.Mock).mockResolvedValue(undefined);
    (resolveAgentSessionCleanupConfig as jest.Mock).mockResolvedValue({ intervalMs: 45_000 });
    mockEmptyAndCloseAllQueues.mockResolvedValue(undefined);
    mockRedisClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    defaultDb.services = null;
    delete process.env.NEXT_MANUAL_SIG_HANDLE;
    delete jobGlobals.sigintHandler;
    delete jobGlobals.sigtermHandler;
    jest.restoreAllMocks();
  });

  it('registers workers, recurring queues, and the API-environment failure backstop', async () => {
    const services = createServices();

    bootstrapJobs(services);
    await flushPromises();

    const createWorker = registeredWorkers.find((worker) => worker.queue === QUEUE_NAMES.API_ENV_CREATE);
    const expiryWorker = registeredWorkers.find((worker) => worker.queue === QUEUE_NAMES.API_ENV_EXPIRY);
    const reconciliationWorker = registeredWorkers.find(
      (worker) => worker.queue === QUEUE_NAMES.DEPLOYMENT_RECONCILIATION
    );
    expect(createWorker).toMatchObject({
      handler: services.BuildService.processApiEnvironmentCreateQueue,
      options: { connection: { connection: 'redis' }, concurrency: 5 },
    });
    expect(expiryWorker?.handler).toBe(services.BuildService.processApiEnvironmentExpiryQueue);
    expect(reconciliationWorker?.handler).toBe(services.BuildService.processDeploymentReconciliationQueue);
    expect(workerOnHandlers[QUEUE_NAMES.API_ENV_CREATE]?.failed).toBe(
      services.BuildService.handleApiEnvironmentCreateFailure
    );
    expect(services.GlobalConfig.setupCacheRefreshJob).toHaveBeenCalledTimes(1);
    expect(services.TTLCleanupService.setupTTLCleanupJob).toHaveBeenCalledTimes(1);
    expect(services.SitesService.setupSitesCleanupJob).toHaveBeenCalledTimes(1);
    expect(services.BuildService.setupApiEnvironmentExpiryJob).toHaveBeenCalledTimes(1);
    expect(services.BuildService.setupDeploymentReconciliationSweep).toHaveBeenCalledTimes(1);

    const ownerSweepWorker = registeredWorkers.find((worker) => worker.queue === QUEUE_NAMES.API_TOKEN_OWNER_SWEEP);
    expect(ownerSweepWorker?.handler).toBe(processApiTokenOwnerSweep);
    expect(warnIfApiTokenOwnerSweepUnconfigured).toHaveBeenCalledTimes(1);

    const ownerSweepQueue = registeredQueues.find((queue) => queue.queue === QUEUE_NAMES.API_TOKEN_OWNER_SWEEP);
    expect(ownerSweepQueue?.add).toHaveBeenCalledWith(
      'api-token-owner-sweep',
      {},
      { jobId: 'api-token-owner-sweep', repeat: { every: 3_600_000 } }
    );
    const cleanupQueue = registeredQueues.find((queue) => queue.queue === QUEUE_NAMES.AGENT_SESSION_CLEANUP);
    expect(cleanupQueue?.add).toHaveBeenCalledWith('agent-session-cleanup', {}, { repeat: { every: 45_000 } });
    const recoveryQueue = registeredQueues.find((queue) => queue.queue === QUEUE_NAMES.AGENT_RUN_RECOVERY);
    expect(recoveryQueue?.add).toHaveBeenCalledWith(
      'agent-run-recovery',
      {},
      { jobId: 'agent-run-recovery', repeat: { every: 60_000 } }
    );
    expect(defaultDb.services).toBe(services);
    expect(mockLoggerInfo).toHaveBeenCalledWith('Jobs: bootstrap complete');
  });

  it('does nothing when another bootstrap already installed the services', () => {
    const installedServices = createServices();
    defaultDb.services = installedServices;

    bootstrapJobs(createServices());

    expect(defaultDb.services).toBe(installedServices);
    expect(loadAiSdk).not.toHaveBeenCalled();
    expect(mockQueueManager.registerWorker).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('logs asynchronous setup failures and falls back to the default cleanup interval', async () => {
    const services = createServices();
    const preloadError = new Error('AI import failed');
    const expiryError = new Error('expiry schedule failed');
    const ownerSweepError = new Error('owner sweep schedule failed');
    const cleanupConfigError = new Error('cleanup config invalid');
    (loadAiSdk as jest.Mock).mockRejectedValueOnce(preloadError);
    services.BuildService.setupApiEnvironmentExpiryJob.mockRejectedValueOnce(expiryError);
    mockQueueAddFactories.set(QUEUE_NAMES.API_TOKEN_OWNER_SWEEP, () => Promise.reject(ownerSweepError));
    (resolveAgentSessionCleanupConfig as jest.Mock).mockRejectedValueOnce(cleanupConfigError);

    bootstrapJobs(services);
    await flushPromises();

    expect(mockLoggerWarn).toHaveBeenCalledWith({ error: preloadError }, 'Jobs: ai sdk preload failed');
    expect(mockLoggerError).toHaveBeenCalledWith({ error: expiryError }, 'Jobs: api environment expiry setup failed');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error: ownerSweepError },
      'Jobs: api token owner sweep schedule failed'
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error: cleanupConfigError },
      'Jobs: cleanup schedule config failed queue=agent_session_cleanup'
    );
    const cleanupQueue = registeredQueues.find((queue) => queue.queue === QUEUE_NAMES.AGENT_SESSION_CLEANUP);
    expect(cleanupQueue?.add).toHaveBeenCalledWith('agent-session-cleanup', {}, { repeat: { every: 300_000 } });
  });

  it('replaces hot-reload signal handlers and closes queues and Redis before exit', async () => {
    process.env.NEXT_MANUAL_SIG_HANDLE = '1';
    const previousSigint = jest.fn(async () => undefined);
    const previousSigterm = jest.fn(async () => undefined);
    jobGlobals.sigintHandler = previousSigint;
    jobGlobals.sigtermHandler = previousSigterm;
    const processOn = jest.spyOn(process, 'on').mockImplementation(() => process);
    const processOff = jest.spyOn(process, 'off').mockImplementation(() => process);
    const processExit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    bootstrapJobs(createServices());
    await flushPromises();

    expect(processOff).toHaveBeenCalledWith('SIGINT', previousSigint);
    expect(processOff).toHaveBeenCalledWith('SIGTERM', previousSigterm);
    expect(processOn).toHaveBeenCalledWith('SIGINT', jobGlobals.sigintHandler);
    expect(processOn).toHaveBeenCalledWith('SIGTERM', jobGlobals.sigtermHandler);
    expect(mockLoggerInfo).toHaveBeenCalledWith('Jobs: signal handlers registered');

    await jobGlobals.sigintHandler?.();
    expect(mockEmptyAndCloseAllQueues).toHaveBeenCalledTimes(1);
    expect(mockRedisClose).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(0);
    expect(mockLoggerInfo).toHaveBeenCalledWith('Jobs: shutting down signal=SIGINT');
  });

  it('logs shutdown failures and still requests a clean process exit', async () => {
    process.env.NEXT_MANUAL_SIG_HANDLE = '1';
    jest.spyOn(process, 'on').mockImplementation(() => process);
    const processExit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const shutdownError = new Error('queue close failed');
    mockEmptyAndCloseAllQueues.mockRejectedValueOnce(shutdownError);

    bootstrapJobs(createServices());
    await flushPromises();
    await jobGlobals.sigtermHandler?.();

    expect(mockRedisClose).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith({ error: shutdownError }, 'Jobs: shutdown failed');
    expect(processExit).toHaveBeenCalledWith(0);
  });
});
