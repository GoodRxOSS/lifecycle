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
  DEFAULT_E2B_TEMPLATE_BASE_IMAGE,
  DEFAULT_E2B_TEMPLATE_NAME,
  runWorkspaceTemplateBuild,
  startWorkspaceTemplateBuild,
} from '../templateBuild';
import { getTemplateBuildState, setTemplateBuildState } from '../templateBuildState';

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
  mockRedisStore.clear();
  mockTemplateCalls.length = 0;
  mockTemplateOptions.length = 0;
  mockResolveConfig.mockResolvedValue({ provider: 'e2b', e2b: { apiKey: 'e2b_secret_key', domain: 'e2b.app' } });
});

describe('startWorkspaceTemplateBuild', () => {
  it('rejects backends without managed template builds', async () => {
    await expect(startWorkspaceTemplateBuild('modal', {})).rejects.toThrow('does not support managed template builds');
    await expect(startWorkspaceTemplateBuild('nope', {})).rejects.toThrow('Unknown workspace backend');
  });

  it('requires a configured API key', async () => {
    mockResolveConfig.mockResolvedValue({ provider: 'e2b', e2b: {} });
    await expect(startWorkspaceTemplateBuild('e2b', {})).rejects.toThrow('E2B API key is not configured');
  });

  it('validates template name and resource bounds', async () => {
    await expect(startWorkspaceTemplateBuild('e2b', { templateName: 'Bad Name!' })).rejects.toThrow(
      'Template name must be'
    );
    await expect(startWorkspaceTemplateBuild('e2b', { cpuCount: 99 })).rejects.toThrow('cpuCount must be');
    await expect(startWorkspaceTemplateBuild('e2b', { memoryMB: 1 })).rejects.toThrow('memoryMB must be');
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
});
