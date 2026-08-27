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

const mockGetBuildByUUID = jest.fn();
const mockRepositoryQuery = jest.fn();
const mockGetEnvironmentPhase = jest.fn((build: { phase?: string }) => build.phase ?? 'in_progress');
const mockIsEnvironmentTerminal = jest.fn((build: { terminal?: boolean }) => Boolean(build.terminal));
const mockIsEnvironmentBuild = jest.fn((build: { environment?: boolean }) => build.environment !== false);
const mockSerializeEnvironmentState = jest.fn(
  (loaded: { build: { phase?: string; marker?: string } }, _options?: { format?: 'concise' | 'detailed' }) => ({
    phase: loaded.build.phase ?? 'in_progress',
    marker: loaded.build.marker ?? 'environment',
  })
);
const mockLoadMcpRuntimeConfig = jest.fn();
const mockMapCoreToolError = jest.fn((error: unknown) => error);

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getBuildByUUID: (...args: unknown[]) => mockGetBuildByUUID(...args),
  })),
}));

jest.mock('server/models/Repository', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockRepositoryQuery(...args) },
}));

jest.mock('server/lib/environments/readiness', () => ({
  getEnvironmentPhase: (build: { phase?: string }) => mockGetEnvironmentPhase(build),
  isEnvironmentTerminal: (build: { terminal?: boolean }) => mockIsEnvironmentTerminal(build),
}));

jest.mock('../config', () => ({
  DEFAULT_MCP_WAIT_SECONDS: 10,
  MAX_MCP_WAIT_SECONDS: 15,
  loadMcpRuntimeConfig: (...args: unknown[]) => mockLoadMcpRuntimeConfig(...args),
}));

jest.mock('../tools/core/getEnvironment', () => ({
  conciseEnvironmentSchema: { type: 'object' },
  isEnvironmentBuild: (build: { environment?: boolean }) => mockIsEnvironmentBuild(build),
  serializeEnvironmentState: (
    loaded: { build: { phase?: string; marker?: string } },
    options?: { format?: 'concise' | 'detailed' }
  ) => mockSerializeEnvironmentState(loaded, options),
}));

jest.mock('../tools/core/listRepositories', () => ({
  mapCoreToolError: (error: unknown) => mockMapCoreToolError(error),
}));

import { McpExecutionError } from '../errors';
import {
  createWaitForEnvironmentToolDefinition,
  type EnvironmentWaitLoadedTarget,
  type WaitCapacity,
} from '../tools/core/waitForEnvironment';

const UUID = 'candidate-123456';
const ENVIRONMENT_ID = 41;

function context(controller = new AbortController(), principal: Record<string, unknown> = {}) {
  return {
    principal: {
      kind: 'user',
      authMethod: 'oauth',
      userId: 'user-1',
      actor: 'user-1',
      ...principal,
    },
    requestId: 'request-1',
    signal: controller.signal,
  } as any;
}

function liveTarget(overrides: Record<string, unknown> = {}): EnvironmentWaitLoadedTarget {
  return {
    kind: 'live',
    loaded: {
      build: {
        id: ENVIRONMENT_ID,
        uuid: UUID,
        phase: 'in_progress',
        runUUID: 'run-current-1234',
        ...overrides,
      } as any,
      repository: { githubRepositoryId: 7, fullName: 'goodrx/example' },
    },
  };
}

function acquiredCapacity(release = jest.fn()): WaitCapacity {
  return { acquire: jest.fn(() => ({ acquired: true as const, release })) };
}

describe('wait_for_environment behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadMcpRuntimeConfig.mockReturnValue({ maxWaitSeconds: 15 });
    mockGetEnvironmentPhase.mockImplementation((build: { phase?: string }) => build.phase ?? 'in_progress');
    mockIsEnvironmentTerminal.mockImplementation((build: { terminal?: boolean }) => Boolean(build.terminal));
    mockIsEnvironmentBuild.mockImplementation((build: { environment?: boolean }) => build.environment !== false);
    mockSerializeEnvironmentState.mockImplementation((loaded: { build: { phase?: string; marker?: string } }) => ({
      phase: loaded.build.phase ?? 'in_progress',
      marker: loaded.build.marker ?? 'environment',
    }));
    mockMapCoreToolError.mockImplementation((error) => error);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the default loader to report a replaced environment without acquiring capacity', async () => {
    mockGetBuildByUUID.mockResolvedValueOnce(null);
    const definition = createWaitForEnvironmentToolDefinition();

    await expect(definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context())).rejects.toMatchObject({
      code: 'environment_replaced',
      details: { replacementExists: false },
    });
    expect(mockGetBuildByUUID).toHaveBeenCalledWith(UUID, {
      liveOnly: false,
      expectedBuildId: ENVIRONMENT_ID,
    });
    expect(mockMapCoreToolError).toHaveBeenCalledWith(expect.any(McpExecutionError));
  });

  it('uses the default loader to distinguish tombstones from live environments', async () => {
    mockGetBuildByUUID.mockResolvedValueOnce({ id: ENVIRONMENT_ID, uuid: UUID, deletedAt: new Date() });
    const tombstoneDefinition = createWaitForEnvironmentToolDefinition();

    await expect(
      tombstoneDefinition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID, goal: 'torn_down' }, context())
    ).resolves.toEqual({
      target: { uuid: UUID, environmentId: ENVIRONMENT_ID },
      result: {
        outcome: 'reached',
        note: 'Lifecycle released this exact environment name.',
      },
    });
    expect(mockRepositoryQuery).not.toHaveBeenCalled();

    const whereNull = jest.fn().mockResolvedValue({ fullName: 'resolved/example' });
    const findOne = jest.fn().mockReturnValue({ whereNull });
    mockRepositoryQuery.mockReturnValue({ findOne });
    const build = {
      id: ENVIRONMENT_ID,
      uuid: UUID,
      deletedAt: null,
      githubRepositoryId: '77',
      pullRequest: { fullName: 'fallback/example' },
      phase: 'ready',
    };
    mockGetBuildByUUID.mockResolvedValueOnce(build);
    const liveDefinition = createWaitForEnvironmentToolDefinition();

    const output = await liveDefinition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context());

    expect(findOne).toHaveBeenCalledWith({ githubRepositoryId: 77 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(mockSerializeEnvironmentState).toHaveBeenCalledWith(
      {
        build,
        repository: { githubRepositoryId: 77, fullName: 'resolved/example' },
      },
      { format: 'concise' }
    );
    expect(output.result).toMatchObject({ outcome: 'reached', environment: { phase: 'ready' } });
  });

  it('falls back to the pull-request repository name without querying for a missing repository id', async () => {
    const build = {
      id: ENVIRONMENT_ID,
      uuid: UUID,
      deletedAt: null,
      githubRepositoryId: null,
      pullRequest: { fullName: 'fallback/example' },
      phase: 'ready',
    };
    mockGetBuildByUUID.mockResolvedValueOnce(build);
    const definition = createWaitForEnvironmentToolDefinition();

    await definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context());

    expect(mockRepositoryQuery).not.toHaveBeenCalled();
    expect(mockSerializeEnvironmentState).toHaveBeenCalledWith(
      {
        build,
        repository: { githubRepositoryId: null, fullName: 'fallback/example' },
      },
      { format: 'concise' }
    );
  });

  it('rejects a live row that is not an environment before acquiring capacity', async () => {
    const capacity = { acquire: jest.fn() };
    mockIsEnvironmentBuild.mockReturnValueOnce(false);
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget({ environment: false }),
      capacity,
    });

    await expect(definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context())).rejects.toMatchObject({
      code: 'env_not_found',
    });
    expect(capacity.acquire).not.toHaveBeenCalled();
  });

  it('reports replica capacity separately and keys actor-only principals consistently', async () => {
    const replicaCapacity: WaitCapacity = {
      acquire: jest.fn(() => ({ acquired: false as const, reason: 'replica' as const })),
    };
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget({ phase: 'ready' }),
      capacity: replicaCapacity,
    });

    await expect(
      definition.handler(
        { uuid: UUID, environmentId: ENVIRONMENT_ID },
        context(undefined, { userId: null, actor: 'service-account' })
      )
    ).rejects.toMatchObject({
      code: 'wait_capacity',
      message: expect.stringContaining('maximum number of waits'),
      retryAfterSeconds: 5,
    });
    expect(replicaCapacity.acquire).toHaveBeenCalledWith('user:service-account');
  });

  it.each([
    [
      'a requested deploy is being torn down',
      { phase: 'tearing_down', runUUID: 'run-current-1234' },
      { goal: 'ready', deployId: 'run-current-1234' },
      'destroyed',
      'deploy cannot finish',
    ],
    [
      'terminal orchestration completed without readiness',
      { phase: 'deployed_not_ready', terminal: true },
      { goal: 'terminal' },
      'reached',
      'one or more services are not ready',
    ],
    [
      'terminal orchestration completed with readiness',
      { phase: 'ready', terminal: true },
      { goal: 'terminal' },
      'reached',
      'Deployment orchestration finished.',
    ],
  ])('returns immediately when %s', async (_name, build, input, outcome, note) => {
    const release = jest.fn();
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget(build),
      capacity: acquiredCapacity(release),
    });

    const output = await definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID, ...input }, context());

    expect(output.result).toMatchObject({ outcome, note: expect.stringContaining(note) });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['terminal', 'in_progress', 'Deployment orchestration is still running.'],
    ['torn_down', 'torn_down', 'Lifecycle has not released this exact environment name yet.'],
  ] as const)('returns the bounded %s observation after timing out', async (goal, phase, note) => {
    const release = jest.fn();
    const nowMilliseconds = jest.fn().mockReturnValueOnce(0).mockReturnValue(5_000);
    const sleep = jest.fn();
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget({ phase }),
      getMaxWaitSeconds: () => 2,
      nowMilliseconds,
      sleep,
      capacity: acquiredCapacity(release),
    });

    const output = await definition.handler(
      { uuid: UUID, environmentId: ENVIRONMENT_ID, goal, timeoutSeconds: 15 },
      context()
    );

    expect(output.result).toMatchObject({
      outcome: 'still_running',
      note: expect.stringContaining(note),
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases acquired capacity when polling fails', async () => {
    const release = jest.fn();
    const pollingError = new Error('poll aborted');
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget(),
      getMaxWaitSeconds: () => 5,
      nowMilliseconds: () => 0,
      sleep: jest.fn().mockRejectedValue(pollingError),
      capacity: acquiredCapacity(release),
    });

    await expect(definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context())).rejects.toBe(
      pollingError
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses the default sleep to reject an already-aborted wait and release capacity', async () => {
    const controller = new AbortController();
    controller.abort();
    const release = jest.fn();
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget(),
      getMaxWaitSeconds: () => 5,
      nowMilliseconds: () => 0,
      capacity: acquiredCapacity(release),
    });

    await expect(
      definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context(controller))
    ).rejects.toThrow('wait aborted');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses the default sleep timer and removes its abort listener before the next observation', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
    const controller = new AbortController();
    const removeEventListener = jest.spyOn(controller.signal, 'removeEventListener');
    const loadTarget = jest
      .fn()
      .mockResolvedValueOnce(liveTarget())
      .mockResolvedValueOnce(liveTarget({ phase: 'ready' }));
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget,
      getMaxWaitSeconds: () => 5,
    });

    const result = definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context(controller));
    await Promise.resolve();
    await Promise.resolve();
    await (
      jest as typeof jest & { advanceTimersByTimeAsync(milliseconds: number): Promise<void> }
    ).advanceTimersByTimeAsync(2_500);

    await expect(result).resolves.toMatchObject({ result: { outcome: 'reached' } });
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(loadTarget).toHaveBeenCalledTimes(2);
  });

  it('aborts an active default sleep and removes the listener before rejecting', async () => {
    const controller = new AbortController();
    const removeEventListener = jest.spyOn(controller.signal, 'removeEventListener');
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget(),
      getMaxWaitSeconds: () => 5,
      nowMilliseconds: () => 0,
      capacity: acquiredCapacity(),
    });

    const result = definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context(controller));
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toThrow('wait aborted');
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('enforces and releases the real per-principal wait capacity', async () => {
    const rejectSleep: Array<(error: Error) => void> = [];
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget(),
      getMaxWaitSeconds: () => 5,
      nowMilliseconds: () => 0,
      sleep: () =>
        new Promise((_resolve, reject) => {
          rejectSleep.push(reject);
        }),
    });
    const active = Array.from({ length: 4 }, () =>
      definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context())
    );
    for (let attempt = 0; attempt < 10 && rejectSleep.length < 4; attempt += 1) {
      await Promise.resolve();
    }
    expect(rejectSleep).toHaveLength(4);

    await expect(definition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context())).rejects.toMatchObject({
      code: 'wait_capacity',
      message: expect.stringContaining('caller already has too many active waits'),
    });

    rejectSleep.forEach((reject) => reject(new Error('test cleanup')));
    await Promise.allSettled(active);

    const readyDefinition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget({ phase: 'ready' }),
    });
    await expect(
      readyDefinition.handler({ uuid: UUID, environmentId: ENVIRONMENT_ID }, context())
    ).resolves.toMatchObject({ result: { outcome: 'reached' } });
  });

  it('enforces the real replica-wide wait capacity across callers', async () => {
    const rejectSleep: Array<(error: Error) => void> = [];
    const definition = createWaitForEnvironmentToolDefinition({
      loadTarget: async () => liveTarget(),
      getMaxWaitSeconds: () => 5,
      nowMilliseconds: () => 0,
      sleep: () =>
        new Promise((_resolve, reject) => {
          rejectSleep.push(reject);
        }),
    });
    const active = Array.from({ length: 32 }, (_unused, index) =>
      definition.handler(
        { uuid: UUID, environmentId: ENVIRONMENT_ID },
        context(undefined, { userId: `user-${Math.floor(index / 4)}`, actor: `user-${Math.floor(index / 4)}` })
      )
    );
    for (let attempt = 0; attempt < 20 && rejectSleep.length < 32; attempt += 1) {
      await Promise.resolve();
    }
    expect(rejectSleep).toHaveLength(32);

    await expect(
      definition.handler(
        { uuid: UUID, environmentId: ENVIRONMENT_ID },
        context(undefined, { userId: 'overflow-user', actor: 'overflow-user' })
      )
    ).rejects.toMatchObject({
      code: 'wait_capacity',
      message: expect.stringContaining('maximum number of waits'),
    });

    rejectSleep.forEach((reject) => reject(new Error('test cleanup')));
    await Promise.allSettled(active);
  });
});
