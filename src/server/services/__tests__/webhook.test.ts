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

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};
const mockGetLogger = jest.fn((_context?: unknown) => mockLogger);
const mockWithLogContext = jest.fn((_context, callback) => callback());
const mockUpdateLogContext = jest.fn();
const mockResolveBuildSourceRepository = jest.fn();
const mockFetchLifecycleConfigByRepository = jest.fn();
const mockResolveEnvironment = jest.fn();
const mockValidateWebhook = jest.fn();
const mockExecuteDockerWebhook = jest.fn();
const mockExecuteCommandWebhook = jest.fn();
const mockRegisterQueue = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn(() => 'redis-connection') },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: (context?: unknown) => mockGetLogger(context),
  withLogContext: (context: unknown, callback: () => unknown) => mockWithLogContext(context, callback),
  updateLogContext: (context: unknown) => mockUpdateLogContext(context),
  LogStage: {
    WEBHOOK_COMPLETE: 'webhook_complete',
    WEBHOOK_PROCESSING: 'webhook_processing',
  },
}));

jest.mock('server/models', () => ({}));

jest.mock('server/lib/buildSource', () => ({
  resolveBuildSourceRepository: (build: unknown) => mockResolveBuildSourceRepository(build),
}));

jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfigByRepository: (repository: unknown, ref: string) =>
    mockFetchLifecycleConfigByRepository(repository, ref),
}));

jest.mock('server/lib/configFileWebhookEnvVariables', () => ({
  ConfigFileWebhookEnvironmentVariables: jest.fn().mockImplementation(() => ({
    resolve: (build: unknown, webhook: unknown) => mockResolveEnvironment(build, webhook),
  })),
}));

jest.mock('server/lib/webhook/webhookValidator', () => ({
  validateWebhook: (webhook: unknown) => mockValidateWebhook(webhook),
}));

jest.mock('server/lib/webhook', () => ({
  executeDockerWebhook: (webhook: unknown, build: unknown, data: unknown) =>
    mockExecuteDockerWebhook(webhook, build, data),
  executeCommandWebhook: (webhook: unknown, build: unknown, data: unknown) =>
    mockExecuteCommandWebhook(webhook, build, data),
}));

jest.mock('shared/config', () => ({
  QUEUE_NAMES: { WEBHOOK_QUEUE: 'webhook-queue' },
}));

import { BuildStatus } from 'shared/constants';
import WebhookService, { WebhookError } from '../webhook';

type Webhook = {
  name: string;
  state: string;
  type: string;
  [key: string]: unknown;
};

function webhook(type: string, overrides: Partial<Webhook> = {}): Webhook {
  return {
    name: `${type}-hook`,
    state: BuildStatus.DEPLOYED,
    type,
    ...overrides,
  };
}

function buildRecord(overrides: Record<string, unknown> = {}) {
  const patch = jest.fn().mockResolvedValue(1);
  return {
    id: 41,
    uuid: 'build-uuid',
    runUUID: 'run-uuid',
    branchName: 'feature/webhooks',
    triggerType: 'pull-request',
    configSha: 'config-sha',
    status: BuildStatus.DEPLOYED,
    webhooksYaml: JSON.stringify([]),
    commentRuntimeEnv: { COMMENT_VALUE: 'from-comment' },
    $query: jest.fn(() => ({ patch })),
    ...overrides,
    patch,
  };
}

function createService({
  features,
  findBuild = jest.fn(),
  invocationCreate = jest.fn(),
  triggerCodefresh = jest.fn(),
}: {
  features?: Record<string, unknown>;
  findBuild?: jest.Mock;
  invocationCreate?: jest.Mock;
  triggerCodefresh?: jest.Mock;
} = {}) {
  const findOne = jest.fn().mockImplementation((query) => findBuild(query));
  const buildQuery = jest.fn(() => ({ findOne }));
  const getAllConfigs = jest.fn().mockResolvedValue({ features });
  const db: any = {
    models: {
      Build: { query: buildQuery },
      WebhookInvocations: { create: invocationCreate },
    },
    services: {
      GlobalConfig: { getAllConfigs },
      Codefresh: { triggerYamlConfigWebhookPipeline: triggerCodefresh },
    },
  };
  mockRegisterQueue.mockReturnValue({ add: jest.fn() });
  const service = new WebhookService(
    db,
    {} as any,
    {} as any,
    {
      registerQueue: mockRegisterQueue,
    } as any
  );
  db.services.Webhook = service;
  return {
    service,
    db,
    buildQuery,
    findOne,
    getAllConfigs,
    invocationCreate,
    triggerCodefresh,
  };
}

describe('WebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchLifecycleConfigByRepository.mockResolvedValue(null);
    mockResolveEnvironment.mockResolvedValue({ CONFIG_VALUE: 'from-config' });
    mockValidateWebhook.mockReturnValue([]);
    mockExecuteDockerWebhook.mockResolvedValue({
      jobName: 'docker-job',
      success: true,
      metadata: { status: 'succeeded' },
    });
    mockExecuteCommandWebhook.mockResolvedValue({
      jobName: 'command-job',
      success: true,
      metadata: { status: 'succeeded' },
    });
  });

  it('registers the webhook queue with the current queue contract', () => {
    createService();

    expect(mockRegisterQueue).toHaveBeenCalledWith('webhook-queue', {
      connection: 'redis-connection',
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  });

  describe('upsertWebhooksWithYaml', () => {
    it('rejects a request with neither a build nor a pull request', async () => {
      const { service } = createService();

      await expect(service.upsertWebhooksWithYaml(null as any, null)).rejects.toEqual(
        expect.objectContaining({ message: 'Pull Request and Build cannot be null when upserting webhooks' })
      );
      expect(mockFetchLifecycleConfigByRepository).not.toHaveBeenCalled();
    });

    it('fetches a pull-request ref, stores its webhooks, and records build context', async () => {
      const build = buildRecord();
      const configuredWebhooks = [webhook('codefresh')];
      const repository = { id: 7 };
      const pullRequest = {
        branchName: 'feature/from-pr',
        repository,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };
      mockFetchLifecycleConfigByRepository.mockResolvedValue({
        environment: { webhooks: configuredWebhooks },
      });
      const { service } = createService();

      await expect(service.upsertWebhooksWithYaml(build as any, pullRequest as any)).resolves.toBe(configuredWebhooks);

      expect(mockUpdateLogContext).toHaveBeenCalledWith({ buildUuid: 'build-uuid' });
      expect(pullRequest.$fetchGraph).toHaveBeenCalledWith('repository');
      expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'feature/from-pr');
      expect(build.patch).toHaveBeenCalledWith({ webhooksYaml: JSON.stringify(configuredWebhooks) });
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Webhook: config updated webhooks=${JSON.stringify(configuredWebhooks)}`
      );
    });

    it('honors an explicit source ref when reading configuration', async () => {
      const build = buildRecord();
      const repository = { id: 7 };
      const pullRequest = {
        branchName: 'feature/from-pr',
        repository,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };
      const { service } = createService();

      await service.upsertWebhooksWithYaml(build as any, pullRequest as any, 'explicit-sha');

      expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'explicit-sha');
    });

    it('returns no webhooks when a pull request without a source repository is the only input', async () => {
      const pullRequest = {
        branchName: 'feature/from-pr',
        repository: null,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };
      const { service } = createService();

      await expect(service.upsertWebhooksWithYaml(null as any, pullRequest as any)).resolves.toEqual([]);

      expect(pullRequest.$fetchGraph).toHaveBeenCalledWith('repository');
      expect(mockUpdateLogContext).not.toHaveBeenCalled();
      expect(mockFetchLifecycleConfigByRepository).not.toHaveBeenCalled();
    });

    it('uses an API build config SHA and clears stale webhook YAML when configuration is empty', async () => {
      const build = buildRecord({ triggerType: 'api' });
      const repository = { id: 8 };
      mockResolveBuildSourceRepository.mockResolvedValue(repository);
      mockFetchLifecycleConfigByRepository.mockResolvedValue({ environment: {} });
      const { service } = createService();

      await expect(service.upsertWebhooksWithYaml(build as any, null)).resolves.toEqual([]);

      expect(mockResolveBuildSourceRepository).toHaveBeenCalledWith(build);
      expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'config-sha');
      expect(build.patch).toHaveBeenCalledWith({ webhooksYaml: null });
      expect(mockLogger.info).toHaveBeenCalledWith('Webhook: config empty');
    });

    it('falls back to the build branch when an ordinary build has no explicit ref', async () => {
      const build = buildRecord({ uuid: null });
      const repository = { id: 8 };
      mockResolveBuildSourceRepository.mockResolvedValue(repository);
      const { service } = createService();

      await service.upsertWebhooksWithYaml(build as any, undefined);

      expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'feature/webhooks');
    });

    it.each([
      ['source repository', null, 'feature/webhooks'],
      ['source branch', { id: 8 }, null],
    ])('does not read or persist configuration without a %s', async (_label, repository, branchName) => {
      const build = buildRecord({ branchName });
      mockResolveBuildSourceRepository.mockResolvedValue(repository);
      const { service } = createService();

      await expect(service.upsertWebhooksWithYaml(build as any, null)).resolves.toEqual([]);

      expect(mockFetchLifecycleConfigByRepository).not.toHaveBeenCalled();
      expect(build.patch).not.toHaveBeenCalled();
    });
  });

  describe('runWebhooksForBuild', () => {
    it('skips every webhook when the feature is explicitly disabled', async () => {
      const build = buildRecord({ webhooksYaml: JSON.stringify([webhook('codefresh')]) });
      const { service, invocationCreate } = createService({ features: { webhooks: false } });

      await service.runWebhooksForBuild(build as any);

      expect(invocationCreate).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('Webhooks feature flag is disabled, skipping webhook execution');
    });

    it('skips a build status that cannot trigger lifecycle webhooks', async () => {
      const build = buildRecord({ status: BuildStatus.BUILDING });
      const { service } = createService();

      await service.runWebhooksForBuild(build as any);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        `Skipping Lifecycle Webhooks execution for status: ${BuildStatus.BUILDING}`
      );
      expect(mockResolveEnvironment).not.toHaveBeenCalled();
    });

    it.each([BuildStatus.DEPLOYED, BuildStatus.ERROR, BuildStatus.TORN_DOWN])(
      'accepts the terminal build status %s',
      async (status) => {
        const build = buildRecord({ status, webhooksYaml: null });
        const { service } = createService();

        await service.runWebhooksForBuild(build as any);

        expect(mockLogger.debug).not.toHaveBeenCalledWith(
          expect.stringContaining('Skipping Lifecycle Webhooks execution for status:')
        );
      }
    );

    it('records when configured webhooks do not match the current status', async () => {
      const build = buildRecord({ webhooksYaml: JSON.stringify([webhook('codefresh', { state: BuildStatus.ERROR })]) });
      const { service } = createService();

      await service.runWebhooksForBuild(build as any);

      expect(mockLogger.info).toHaveBeenCalledWith(`Webhook: skipped reason=noMatch status=${BuildStatus.DEPLOYED}`);
      expect(mockResolveEnvironment).not.toHaveBeenCalled();
    });

    it('runs Codefresh, Docker, and command webhooks sequentially and stores their outcomes', async () => {
      const hooks = [webhook('codefresh'), webhook('docker'), webhook('command')];
      const build = buildRecord({ webhooksYaml: JSON.stringify(hooks) });
      const dockerPatch = jest.fn().mockResolvedValue(1);
      const commandPatch = jest.fn().mockResolvedValue(1);
      const invocationCreate = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ $query: () => ({ patch: dockerPatch }) })
        .mockResolvedValueOnce({ $query: () => ({ patch: commandPatch }) });
      const triggerCodefresh = jest.fn().mockResolvedValue('cf-build-id');
      const { service } = createService({ invocationCreate, triggerCodefresh });

      await service.runWebhooksForBuild(build as any);

      expect(mockResolveEnvironment).toHaveBeenCalledTimes(3);
      expect(triggerCodefresh).toHaveBeenCalledWith(hooks[0], {
        CONFIG_VALUE: 'from-config',
        COMMENT_VALUE: 'from-comment',
      });
      expect(invocationCreate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          buildId: 41,
          name: 'codefresh-hook',
          metadata: { link: 'https://g.codefresh.io/build/cf-build-id' },
          status: 'completed',
        })
      );
      expect(mockExecuteDockerWebhook).toHaveBeenCalledWith(hooks[1], build, {
        CONFIG_VALUE: 'from-config',
        COMMENT_VALUE: 'from-comment',
      });
      expect(dockerPatch).toHaveBeenCalledWith({
        metadata: { jobName: 'docker-job', success: true, status: 'succeeded' },
        status: 'completed',
      });
      expect(mockExecuteCommandWebhook).toHaveBeenCalledWith(hooks[2], build, {
        CONFIG_VALUE: 'from-config',
        COMMENT_VALUE: 'from-comment',
      });
      expect(commandPatch).toHaveBeenCalledWith({
        metadata: { jobName: 'command-job', success: true, status: 'succeeded' },
        status: 'completed',
      });
      expect(mockGetLogger).toHaveBeenCalledWith({ stage: 'webhook_complete' });
      expect(mockLogger.info).toHaveBeenCalledWith(`Webhook: completed count=3 status=${BuildStatus.DEPLOYED}`);
    });

    it.each([
      ['docker', mockExecuteDockerWebhook],
      ['command', mockExecuteCommandWebhook],
    ])('persists a failed %s result without throwing', async (type, execute) => {
      const hook = webhook(type);
      const build = buildRecord({ webhooksYaml: JSON.stringify([hook]) });
      const patch = jest.fn().mockResolvedValue(1);
      const invocationCreate = jest.fn().mockResolvedValue({ $query: () => ({ patch }) });
      execute.mockResolvedValue({ jobName: `${type}-job`, success: false, metadata: { reason: 'exit-code' } });
      const { service } = createService({ invocationCreate });

      await service.runWebhooksForBuild(build as any);

      expect(patch).toHaveBeenCalledWith({
        metadata: { jobName: `${type}-job`, success: false, reason: 'exit-code' },
        status: 'failed',
      });
    });

    it('rejects invalid configuration before resolving environment or recording history', async () => {
      const hook = webhook('docker');
      const build = buildRecord({ webhooksYaml: JSON.stringify([hook]) });
      mockValidateWebhook.mockReturnValue([
        { field: 'image', message: 'is required' },
        { field: 'timeout', message: 'must be positive' },
      ]);
      const { service, invocationCreate } = createService();

      await expect(service.runWebhooksForBuild(build as any)).rejects.toThrow(
        'Invalid webhook configuration: image: is required, timeout: must be positive'
      );
      expect(mockResolveEnvironment).not.toHaveBeenCalled();
      expect(invocationCreate).not.toHaveBeenCalled();
    });

    it('propagates environment resolution failures before webhook execution', async () => {
      const failure = new Error('build graph unavailable');
      const build = buildRecord({ webhooksYaml: JSON.stringify([webhook('docker')]) });
      mockResolveEnvironment.mockRejectedValue(failure);
      const { service } = createService();

      await expect(service.runWebhooksForBuild(build as any)).rejects.toBe(failure);
      expect(mockExecuteDockerWebhook).not.toHaveBeenCalled();
    });

    it.each([
      ['codefresh', new Error('codefresh unavailable')],
      ['docker', new Error('cluster unavailable')],
      ['command', 'command rejected'],
      ['future-type', new Error('unused')],
    ])('records a failed invocation when a %s webhook cannot complete', async (type, failure) => {
      const hook = webhook(type);
      const build = buildRecord({ webhooksYaml: JSON.stringify([hook]) });
      const invocationCreate = jest.fn().mockResolvedValue({ $query: () => ({ patch: jest.fn() }) });
      const triggerCodefresh = jest.fn().mockRejectedValue(failure);
      mockExecuteDockerWebhook.mockRejectedValue(failure);
      mockExecuteCommandWebhook.mockRejectedValue(failure);
      const { service } = createService({ invocationCreate, triggerCodefresh });

      await expect(service.runWebhooksForBuild(build as any)).resolves.toBeUndefined();

      const expectedError =
        type === 'future-type'
          ? 'Unsupported webhook type: future-type'
          : failure instanceof Error
          ? failure.message
          : undefined;
      expect(invocationCreate).toHaveBeenLastCalledWith({
        buildId: 41,
        runUUID: 'run-uuid',
        name: `${type}-hook`,
        type,
        state: BuildStatus.DEPLOYED,
        yamlConfig: JSON.stringify(hook),
        metadata: { error: expectedError },
        status: 'failed',
      });
      expect(mockLogger.error).toHaveBeenCalledWith('Webhook: invocation failed');
    });
  });

  describe('processWebhookQueue', () => {
    function queuedJob() {
      return {
        data: {
          buildId: 41,
          sender: 'api-user',
          correlationId: 'correlation-id',
          _ddTraceContext: { traceparent: 'trace-context' },
        },
      };
    }

    it('loads the build and runs webhooks inside the queued logging context', async () => {
      const build = buildRecord();
      const findBuild = jest.fn().mockResolvedValue(build);
      const { service, db, findOne } = createService({ findBuild });
      const runWebhooksForBuild = jest.fn().mockResolvedValue(undefined);
      db.services.Webhook = { runWebhooksForBuild };

      await service.processWebhookQueue(queuedJob());

      expect(mockWithLogContext).toHaveBeenCalledWith(
        {
          correlationId: 'correlation-id',
          sender: 'api-user',
          _ddTraceContext: { traceparent: 'trace-context' },
        },
        expect.any(Function)
      );
      expect(findOne).toHaveBeenCalledWith({ id: 41 });
      expect(mockUpdateLogContext).toHaveBeenCalledWith({ buildUuid: 'build-uuid' });
      expect(runWebhooksForBuild).toHaveBeenCalledWith(build);
    });

    it('contains queue-processing failures and records their processing stage', async () => {
      const failure = new Error('webhook execution failed');
      const findBuild = jest.fn().mockResolvedValue(undefined);
      const { service, db } = createService({ findBuild });
      db.services.Webhook = { runWebhooksForBuild: jest.fn().mockRejectedValue(failure) };

      await expect(service.processWebhookQueue(queuedJob())).resolves.toBeUndefined();

      expect(mockUpdateLogContext).not.toHaveBeenCalled();
      expect(mockGetLogger).toHaveBeenCalledWith({ stage: 'webhook_processing' });
      expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Webhook: invocation failed');
    });
  });
});

describe('WebhookError', () => {
  it('preserves explicit lifecycle context and supports omitted context', () => {
    expect(new WebhookError('explicit', 'build-uuid', 'payments')).toEqual(
      expect.objectContaining({ message: 'explicit', uuid: 'build-uuid', service: 'payments' })
    );
    expect(new WebhookError('defaults')).toEqual(
      expect.objectContaining({ message: 'defaults', uuid: null, service: null })
    );
  });
});
