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

const mockQueueAdd = jest.fn();
const mockRedisStore = new Map<string, string>();
const mockRedis = {
  get: jest.fn(async (key: string) => mockRedisStore.get(key) ?? null),
  setex: jest.fn(async (key: string, _ttl: number, value: string) => {
    mockRedisStore.set(key, value);
  }),
  del: jest.fn(async (key: string) => {
    mockRedisStore.delete(key);
  }),
};
const mockResolveConfig = jest.fn();
const mockSetStoredE2bTemplateId = jest.fn();
const mockTemplateBuild = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockTemplateCalls: Array<{ method: string; args: unknown[] }> = [];
const mockTemplateOptions: unknown[] = [];

// The service registers its queue at module scope (import time), before the mock consts
// initialize — delegate lazily instead of referencing mockQueueAdd in the factory.
jest.mock('server/lib/queueManager', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      registerQueue: () => ({ add: (...args: unknown[]) => mockQueueAdd(...args) }),
    }),
  },
}));

jest.mock('server/lib/dependencies', () => ({
  __esModule: true,
  redisClient: { getConnection: jest.fn(() => ({})) },
}));

jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getRedis: jest.fn(() => mockRedis) })),
  },
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  __esModule: true,
  resolveAgentSessionWorkspaceBackendConfig: (...args: unknown[]) => mockResolveConfig(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ setStoredE2bTemplateId: mockSetStoredE2bTemplateId })),
  },
}));

jest.mock('../registry', () => ({
  __esModule: true,
  getWorkspaceBackendDescriptor: jest.fn((id: string) =>
    id === 'e2b'
      ? { id: 'e2b', displayName: 'E2B', secretFields: ['apiKey'] }
      : id === 'modal'
      ? { id: 'modal', displayName: 'Modal', secretFields: ['tokenId', 'tokenSecret'] }
      : undefined
  ),
  listWorkspaceBackendDescriptors: jest.fn(() => [{ id: 'e2b', displayName: 'E2B', secretFields: ['apiKey'] }]),
}));

jest.mock('e2b', () => {
  const template = () => {
    const recorder: Record<string, unknown> = {};
    for (const method of ['fromImage', 'copy', 'runCmd', 'setStartCmd']) {
      recorder[method] = (...args: unknown[]) => {
        mockTemplateCalls.push({ method, args });
        return recorder;
      };
    }
    return recorder;
  };
  const Template = Object.assign(
    jest.fn((options: unknown) => {
      mockTemplateOptions.push(options);
      return template();
    }),
    { build: mockTemplateBuild }
  );
  return { __esModule: true, Template };
});

import {
  composeE2bWorkspaceTemplate,
  DEFAULT_E2B_TEMPLATE_BASE_IMAGE,
  DEFAULT_E2B_TEMPLATE_NAME,
  getWorkspaceTemplateBuild,
  runWorkspaceTemplateBuild,
  startWorkspaceTemplateBuild,
} from '../templateBuild';
import {
  appendTemplateBuildLogs,
  getActiveTemplateBuild,
  getTemplateBuildState,
  isTemplateBuildTerminal,
  patchTemplateBuildState,
  setActiveTemplateBuild,
  setTemplateBuildState,
} from '../templateBuildState';
import fs from 'node:fs';

function seedRunningState(buildId: string): Promise<void> {
  return setTemplateBuildState(mockRedis as never, {
    buildId,
    backendId: 'e2b',
    status: 'queued',
    stage: 'queued',
    message: 'Template build queued.',
    templateName: DEFAULT_E2B_TEMPLATE_NAME,
    logs: [],
    templateId: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockResolveConfig.mockReset();
  mockSetStoredE2bTemplateId.mockReset().mockResolvedValue(undefined);
  mockTemplateBuild.mockReset();
  mockLoggerWarn.mockReset();
  mockLoggerError.mockReset();
  mockRedis.get.mockReset().mockImplementation(async (key: string) => mockRedisStore.get(key) ?? null);
  mockRedis.setex.mockReset().mockImplementation(async (key: string, _ttl: number, value: string) => {
    mockRedisStore.set(key, value);
  });
  mockRedis.del.mockReset().mockImplementation(async (key: string) => {
    mockRedisStore.delete(key);
  });
  mockRedisStore.clear();
  mockTemplateCalls.length = 0;
  mockTemplateOptions.length = 0;
  mockResolveConfig.mockResolvedValue({ provider: 'e2b', e2b: { apiKey: 'e2b_secret_key', domain: 'e2b.app' } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('startWorkspaceTemplateBuild', () => {
  it('rejects backends without managed template builds', async () => {
    await expect(startWorkspaceTemplateBuild('modal', {})).rejects.toThrow('does not support managed template builds');
    await expect(startWorkspaceTemplateBuild('nope', {})).rejects.toThrow('Unknown workspace backend');
  });

  it('requires a configured API key', async () => {
    mockResolveConfig.mockResolvedValue({ provider: 'e2b', e2b: {} });
    await expect(startWorkspaceTemplateBuild('e2b', {})).rejects.toThrow('E2B API key is not configured');

    mockResolveConfig.mockResolvedValue({ provider: 'e2b' });
    await expect(startWorkspaceTemplateBuild('e2b', {})).rejects.toThrow('E2B API key is not configured');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('validates template name and resource bounds', async () => {
    await expect(startWorkspaceTemplateBuild('e2b', { templateName: 'Bad Name!' })).rejects.toThrow(
      'Template name must be'
    );
    await expect(startWorkspaceTemplateBuild('e2b', { cpuCount: 99 })).rejects.toThrow('cpuCount must be');
    await expect(startWorkspaceTemplateBuild('e2b', { memoryMB: 1 })).rejects.toThrow('memoryMB must be');
  });

  it('normalizes a name and numeric strings while accepting both resource boundaries', async () => {
    const state = await startWorkspaceTemplateBuild('e2b', {
      templateName: '  My_Template-1  ',
      cpuCount: '8',
      memoryMB: '8192',
    });

    expect(state.templateName).toBe('my_template-1');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'build',
      { buildId: state.buildId, templateName: 'my_template-1', cpuCount: 8, memoryMB: 8192 },
      { jobId: state.buildId }
    );

    mockRedisStore.clear();
    await startWorkspaceTemplateBuild('e2b', { cpuCount: 1, memoryMB: 512 });
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      'build',
      expect.objectContaining({ cpuCount: 1, memoryMB: 512 }),
      expect.any(Object)
    );
  });

  it.each([
    ['non-numeric CPU', { cpuCount: 'many' }, 'cpuCount'],
    ['fractional CPU number', { cpuCount: 1.5 }, 'cpuCount'],
    ['non-finite memory', { memoryMB: Number.POSITIVE_INFINITY }, 'memoryMB'],
    ['overlong template name', { templateName: 'a'.repeat(65) }, 'Template name'],
  ])('rejects %s before Redis and queue side effects', async (_label, input, message) => {
    await expect(startWorkspaceTemplateBuild('e2b', input)).rejects.toThrow(message);
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.setex).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('fails before Redis and queue side effects when a required overlay file is absent', async () => {
    const realExistsSync = fs.existsSync;
    const existsSync = jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return String(candidate).endsWith('sysops/workspace-gateway/auth.mjs') ? false : realExistsSync(candidate);
    });

    try {
      await expect(startWorkspaceTemplateBuild('e2b', {})).rejects.toThrow(
        'Template build context is missing required files'
      );
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.setex).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    } finally {
      existsSync.mockRestore();
    }
  });

  it('queues a build and returns the queued state', async () => {
    const state = await startWorkspaceTemplateBuild('e2b', {});
    expect(state.status).toBe('queued');
    expect(state.templateName).toBe(DEFAULT_E2B_TEMPLATE_NAME);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'build',
      { buildId: state.buildId, templateName: DEFAULT_E2B_TEMPLATE_NAME, cpuCount: 2, memoryMB: 4096 },
      { jobId: state.buildId }
    );
    expect(await getTemplateBuildState(mockRedis as never, state.buildId)).toMatchObject({ status: 'queued' });
  });

  it('returns the running build instead of starting another', async () => {
    const first = await startWorkspaceTemplateBuild('e2b', {});
    const second = await startWorkspaceTemplateBuild('e2b', {});
    expect(second.buildId).toBe(first.buildId);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it.each(['ready', 'error'] as const)('replaces a terminal %s active build with a new queue job', async (status) => {
    await seedRunningState('completed-build');
    await patchTemplateBuildState(mockRedis as never, 'completed-build', { status, stage: status });
    await setActiveTemplateBuild(mockRedis as never, 'e2b', 'completed-build');

    const next = await startWorkspaceTemplateBuild('e2b', {});

    expect(next.buildId).not.toBe('completed-build');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(await getActiveTemplateBuild(mockRedis as never, 'e2b')).toBe(next.buildId);
  });

  it('replaces a stale active pointer whose build state has expired', async () => {
    await setActiveTemplateBuild(mockRedis as never, 'e2b', 'expired-build');

    const next = await startWorkspaceTemplateBuild('e2b', {});

    expect(next.buildId).not.toBe('expired-build');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});

describe('getWorkspaceTemplateBuild', () => {
  it('returns an owned build after trimming the supplied id', async () => {
    await seedRunningState('build-1');

    await expect(getWorkspaceTemplateBuild('e2b', '  build-1  ')).resolves.toMatchObject({
      buildId: 'build-1',
      backendId: 'e2b',
    });
  });

  it('rejects unknown backends before reading Redis', async () => {
    await expect(getWorkspaceTemplateBuild('missing', 'build-1')).rejects.toThrow('Unknown workspace backend');
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('rejects absent, empty, and differently owned build states', async () => {
    await expect(getWorkspaceTemplateBuild('e2b', '')).rejects.toThrow('Template build not found or expired');
    await expect(getWorkspaceTemplateBuild('e2b', 'absent')).rejects.toThrow('Template build not found or expired');
    await setTemplateBuildState(mockRedis as never, {
      buildId: 'modal-build',
      backendId: 'modal',
      status: 'queued',
      stage: 'queued',
      message: 'Queued',
      templateName: 'modal-template',
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(getWorkspaceTemplateBuild('e2b', 'modal-build')).rejects.toThrow(
      'Template build not found or expired'
    );
  });
});

describe('composeE2bWorkspaceTemplate', () => {
  it('honors its explicit context and base-image inputs while returning the SDK builder', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ['fromImage', 'copy', 'runCmd', 'setStartCmd']) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      };
    }
    const Template = Object.assign(
      jest.fn(() => builder),
      { build: jest.fn() }
    );

    const template = composeE2bWorkspaceTemplate({ Template } as unknown as typeof import('e2b'), {
      contextPath: '/tmp/custom-template-context',
      baseImage: 'registry.example.com/workspace:test',
    });

    expect(template).toBe(builder);
    expect(Template).toHaveBeenCalledWith({ fileContextPath: '/tmp/custom-template-context' });
    expect(calls[0]).toEqual({
      method: 'fromImage',
      args: ['registry.example.com/workspace:test'],
    });
    expect(calls.at(-1)).toEqual({
      method: 'setStartCmd',
      args: ['sh /opt/lifecycle/e2b-launcher.sh', 'test -d /tmp/lifecycle'],
    });
  });
});

describe('runWorkspaceTemplateBuild', () => {
  const request = { buildId: 'build-1', templateName: 'lifecycle-workspace', cpuCount: 2, memoryMB: 4096 };

  it('builds from the pinned base image with the gateway overlay and persists the template', async () => {
    await seedRunningState(request.buildId);
    mockTemplateBuild.mockResolvedValue({ name: 'lifecycle-workspace', templateId: 'tpl_123', buildId: 'b1' });

    await runWorkspaceTemplateBuild(request);

    expect(mockTemplateOptions[0]).toMatchObject({ fileContextPath: process.cwd() });
    const methods = mockTemplateCalls.map((call) => call.method);
    expect(methods[0]).toBe('fromImage');
    expect(mockTemplateCalls[0].args[0]).toBe(DEFAULT_E2B_TEMPLATE_BASE_IMAGE);
    expect(methods.filter((method) => method === 'copy').length).toBe(3);
    const launcherCopy = mockTemplateCalls.find(
      (call) => call.method === 'copy' && call.args[0] === 'scripts/e2b/e2b-launcher.sh'
    );
    expect(launcherCopy?.args[1]).toBe('/opt/lifecycle/e2b-launcher.sh');
    expect(launcherCopy?.args[2]).toMatchObject({ user: 'root', mode: 0o755 });
    const startCmd = mockTemplateCalls.find((call) => call.method === 'setStartCmd');
    expect(startCmd?.args).toEqual(['sh /opt/lifecycle/e2b-launcher.sh', 'test -d /tmp/lifecycle']);

    expect(mockTemplateBuild).toHaveBeenCalledWith(
      expect.anything(),
      'lifecycle-workspace',
      expect.objectContaining({ apiKey: 'e2b_secret_key', domain: 'e2b.app', cpuCount: 2, memoryMB: 4096 })
    );
    expect(mockSetStoredE2bTemplateId).toHaveBeenCalledWith('lifecycle-workspace');

    const state = await getTemplateBuildState(mockRedis as never, request.buildId);
    expect(state).toMatchObject({ status: 'ready', stage: 'ready', templateId: 'tpl_123' });
  });

  it('records missing runtime credentials without calling E2B or settings storage and clears the active pointer', async () => {
    await seedRunningState(request.buildId);
    await setActiveTemplateBuild(mockRedis as never, 'e2b', request.buildId);
    mockResolveConfig.mockResolvedValue({ provider: 'e2b' });

    await runWorkspaceTemplateBuild(request);

    expect(mockTemplateBuild).not.toHaveBeenCalled();
    expect(mockSetStoredE2bTemplateId).not.toHaveBeenCalled();
    expect(await getTemplateBuildState(mockRedis as never, request.buildId)).toMatchObject({
      status: 'error',
      stage: 'error',
      error: 'E2B API key is not configured.',
    });
    expect(await getActiveTemplateBuild(mockRedis as never, 'e2b')).toBeNull();
  });

  it('streams build logs into the state', async () => {
    await seedRunningState(request.buildId);
    mockTemplateBuild.mockImplementation(async (_template, _name, options) => {
      options.onBuildLogs({ level: 'info', message: 'Step 1/5: FROM …' });
      options.onBuildLogs({ level: 'info', message: 'Build finished' });
      return { name: 'lifecycle-workspace', templateId: 'tpl_123', buildId: 'b1' };
    });

    await runWorkspaceTemplateBuild(request);

    const state = await getTemplateBuildState(mockRedis as never, request.buildId);
    expect(state?.logs).toEqual(['[info] Step 1/5: FROM …', '[info] Build finished']);
  });

  it('records a scrubbed failure', async () => {
    await seedRunningState(request.buildId);
    mockTemplateBuild.mockRejectedValue(new Error('E2B rejected key e2b_secret_key'));

    await runWorkspaceTemplateBuild(request);

    const state = await getTemplateBuildState(mockRedis as never, request.buildId);
    expect(state?.status).toBe('error');
    expect(state?.error).toBe('E2B rejected key [redacted]');
    expect(mockSetStoredE2bTemplateId).not.toHaveBeenCalled();
  });

  it('normalizes a non-Error provider rejection and clears the active pointer', async () => {
    await seedRunningState(request.buildId);
    await setActiveTemplateBuild(mockRedis as never, 'e2b', request.buildId);
    mockTemplateBuild.mockRejectedValue('provider unavailable');

    await runWorkspaceTemplateBuild(request);

    expect(await getTemplateBuildState(mockRedis as never, request.buildId)).toMatchObject({
      status: 'error',
      error: 'provider unavailable',
      message: 'Template build failed: provider unavailable',
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: 'provider unavailable', buildId: request.buildId },
      'Workspace template build failed'
    );
    expect(await getActiveTemplateBuild(mockRedis as never, 'e2b')).toBeNull();
  });

  it('turns settings persistence failures into terminal build failures after E2B succeeds', async () => {
    await seedRunningState(request.buildId);
    mockTemplateBuild.mockResolvedValue({ name: 'selected-template', templateId: 'tpl_123', buildId: 'b1' });
    mockSetStoredE2bTemplateId.mockRejectedValue(new Error('settings store unavailable'));

    await runWorkspaceTemplateBuild(request);

    expect(mockTemplateBuild).toHaveBeenCalledTimes(1);
    expect(mockSetStoredE2bTemplateId).toHaveBeenCalledWith('selected-template');
    expect(await getTemplateBuildState(mockRedis as never, request.buildId)).toMatchObject({
      status: 'error',
      stage: 'error',
      error: 'settings store unavailable',
    });
  });

  it('flushes a 25-line burst through the immediate timer before the build completes', async () => {
    jest.useFakeTimers();
    await seedRunningState(request.buildId);
    mockTemplateBuild.mockImplementation((_template, _name, options) => {
      for (let index = 1; index <= 25; index += 1) {
        options.onBuildLogs({ level: 'info', message: `line ${index}` });
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve({ name: 'lifecycle-workspace', templateId: 'tpl_123', buildId: 'b1' }), 1);
      });
    });

    const running = runWorkspaceTemplateBuild(request);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockTemplateBuild).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await running;

    const state = await getTemplateBuildState(mockRedis as never, request.buildId);
    expect(state?.logs).toHaveLength(25);
    expect(state?.logs[0]).toBe('[info] line 1');
    expect(state?.logs[24]).toBe('[info] line 25');
  });

  it('warns on a Redis log-append failure but still completes the template build', async () => {
    await seedRunningState(request.buildId);
    let rejectedLogWrite = false;
    mockRedis.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
      const parsed = JSON.parse(value) as { logs?: unknown[] };
      if (!rejectedLogWrite && parsed.logs?.length) {
        rejectedLogWrite = true;
        throw new Error('Redis append unavailable');
      }
      mockRedisStore.set(key, value);
    });
    mockTemplateBuild.mockImplementation(async (_template, _name, options) => {
      options.onBuildLogs({ level: 'info', message: 'provider output' });
      return { name: 'lifecycle-workspace', templateId: 'tpl_123', buildId: 'b1' };
    });

    await runWorkspaceTemplateBuild(request);

    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.any(Object), 'Workspace template build: log append failed');
    expect(await getTemplateBuildState(mockRedis as never, request.buildId)).toMatchObject({
      status: 'ready',
      templateId: 'tpl_123',
      logs: [],
    });
  });

  it('records the bounded timeout when E2B never settles', async () => {
    jest.useFakeTimers();
    await seedRunningState(request.buildId);
    mockTemplateBuild.mockReturnValue(new Promise(() => undefined));

    const running = runWorkspaceTemplateBuild(request);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockTemplateBuild).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    await running;

    expect(await getTemplateBuildState(mockRedis as never, request.buildId)).toMatchObject({
      status: 'error',
      error: 'E2B template build timed out after 30 minutes.',
    });
    expect(mockSetStoredE2bTemplateId).not.toHaveBeenCalled();
  });
});

describe('template build state behavior', () => {
  it('classifies only ready and error states as terminal', () => {
    expect(isTemplateBuildTerminal({ status: 'queued' })).toBe(false);
    expect(isTemplateBuildTerminal({ status: 'running' })).toBe(false);
    expect(isTemplateBuildTerminal({ status: 'ready' })).toBe(true);
    expect(isTemplateBuildTerminal({ status: 'error' })).toBe(true);
  });

  it('returns null for missing or malformed state and normalizes malformed logs to an empty list', async () => {
    await expect(getTemplateBuildState(mockRedis as never, 'missing')).resolves.toBeNull();

    mockRedisStore.set('lifecycle:agent:workspace-template-build:malformed', '{not-json');
    await expect(getTemplateBuildState(mockRedis as never, 'malformed')).resolves.toBeNull();

    mockRedisStore.set(
      'lifecycle:agent:workspace-template-build:bad-logs',
      JSON.stringify({
        buildId: 'bad-logs',
        backendId: 'e2b',
        status: 'queued',
        stage: 'queued',
        message: 'Queued',
        templateName: 'template',
        logs: 'not-an-array',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      })
    );
    await expect(getTemplateBuildState(mockRedis as never, 'bad-logs')).resolves.toMatchObject({ logs: [] });
  });

  it('makes missing-state patches and empty or missing-state log appends no-ops', async () => {
    await expect(
      patchTemplateBuildState(mockRedis as never, 'missing', { status: 'error', stage: 'error' })
    ).resolves.toBeNull();
    await appendTemplateBuildLogs(mockRedis as never, 'missing', []);
    await appendTemplateBuildLogs(mockRedis as never, 'missing', ['orphaned output']);

    expect(mockRedis.setex).not.toHaveBeenCalled();
  });

  it('patches existing state and retains only the newest 500 log lines', async () => {
    const initialLogs = Array.from({ length: 499 }, (_, index) => `old-${index + 1}`);
    await setTemplateBuildState(mockRedis as never, {
      buildId: 'build-logs',
      backendId: 'e2b',
      status: 'queued',
      stage: 'queued',
      message: 'Queued',
      templateName: 'template',
      logs: initialLogs,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    });

    const patched = await patchTemplateBuildState(mockRedis as never, 'build-logs', {
      status: 'running',
      stage: 'building',
      message: 'Building',
    });
    await appendTemplateBuildLogs(mockRedis as never, 'build-logs', ['new-1', 'new-2', 'new-3']);
    const final = await getTemplateBuildState(mockRedis as never, 'build-logs');

    expect(patched).toMatchObject({ status: 'running', stage: 'building', message: 'Building' });
    expect(patched?.updatedAt).not.toBe('2026-08-27T00:00:00.000Z');
    expect(final?.logs).toHaveLength(500);
    expect(final?.logs.slice(0, 2)).toEqual(['old-3', 'old-4']);
    expect(final?.logs.slice(-3)).toEqual(['new-1', 'new-2', 'new-3']);
  });
});
