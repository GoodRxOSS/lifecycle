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

const registeredWorkers: { queue: string; handler: unknown }[] = [];
const workerOnHandlers: Record<string, Record<string, unknown>> = {};

jest.mock('server/lib/dependencies', () => ({
  defaultDb: { services: null },
  redisClient: { getConnection: jest.fn(() => ({})) },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/services/agent/aiSdkRuntime', () => ({ loadAiSdk: jest.fn().mockResolvedValue(undefined) }));
jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionCleanupConfig: jest.fn(() => Promise.resolve({ intervalMs: 1000 })),
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
  default: {
    getInstance: () => ({
      registerWorker: (queue: string, handler: unknown) => {
        registeredWorkers.push({ queue, handler });
        const worker = {
          on: (event: string, cb: unknown) => {
            workerOnHandlers[queue] = { ...(workerOnHandlers[queue] ?? {}), [event]: cb };
          },
        };
        return worker;
      },
      registerQueue: () => ({ add: jest.fn().mockResolvedValue(undefined), on: jest.fn() }),
    }),
  },
}));

import bootstrapJobs from 'server/jobs/index';
import { QUEUE_NAMES } from 'shared/config';
import { processApiTokenOwnerSweep, warnIfApiTokenOwnerSweepUnconfigured } from '../apiTokenOwnerSweep';

describe('bootstrapJobs API-environment wiring', () => {
  it('registers the create + expiry workers and attaches the failed-handler backstop', () => {
    const handleApiEnvironmentCreateFailure = jest.fn();
    const processApiEnvironmentCreateQueue = jest.fn();
    const processApiEnvironmentExpiryQueue = jest.fn();
    const setupApiEnvironmentExpiryJob = jest.fn().mockResolvedValue(undefined);

    const services: any = {
      GithubService: { processWebhooks: jest.fn() },
      ActivityStream: { processComments: jest.fn() },
      GlobalConfig: { setupCacheRefreshJob: jest.fn(), processCacheRefresh: jest.fn() },
      TTLCleanupService: { setupTTLCleanupJob: jest.fn(), processTTLCleanupQueue: jest.fn() },
      SitesService: { setupSitesCleanupJob: jest.fn(), processSitesCleanupQueue: jest.fn() },
      BuildService: {
        setupApiEnvironmentExpiryJob,
        processApiEnvironmentCreateQueue,
        handleApiEnvironmentCreateFailure,
        processApiEnvironmentExpiryQueue,
        processDeleteQueue: jest.fn(),
        processResolveAndDeployBuildQueue: jest.fn(),
        processBuildQueue: jest.fn(),
      },
      Webhook: { processWebhookQueue: jest.fn() },
      Ingress: { createOrUpdateIngressForBuild: jest.fn(), ingressCleanupForBuild: jest.fn() },
      DeployCleanupService: { processCleanupQueue: jest.fn() },
      LabelService: { processLabelQueue: jest.fn() },
    };

    bootstrapJobs(services);

    const createWorker = registeredWorkers.find((w) => w.queue === QUEUE_NAMES.API_ENV_CREATE);
    const expiryWorker = registeredWorkers.find((w) => w.queue === QUEUE_NAMES.API_ENV_EXPIRY);

    expect(createWorker?.handler).toBe(processApiEnvironmentCreateQueue);
    expect(expiryWorker?.handler).toBe(processApiEnvironmentExpiryQueue);
    expect(workerOnHandlers[QUEUE_NAMES.API_ENV_CREATE]?.failed).toBe(handleApiEnvironmentCreateFailure);
    expect(setupApiEnvironmentExpiryJob).toHaveBeenCalled();

    const ownerSweepWorker = registeredWorkers.find((w) => w.queue === QUEUE_NAMES.API_TOKEN_OWNER_SWEEP);
    expect(ownerSweepWorker?.handler).toBe(processApiTokenOwnerSweep);
    expect(warnIfApiTokenOwnerSweepUnconfigured).toHaveBeenCalled();
  });
});
