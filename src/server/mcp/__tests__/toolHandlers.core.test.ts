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

import type Build from 'server/models/Build';
import type { Principal } from 'server/lib/principal';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import type { McpJsonObject, McpRuntimePolicy, McpToolInvocationContext } from '../contracts';
import type { McpExecutionErrorEnvelope } from '../errors';
import { McpToolRegistry, type McpToolCallAuditRecord } from '../registry';
import { createCoreToolDefinitions, type CoreToolDependencies } from '../tools/core';

const UUID = 'candidate-123456';
const ENVIRONMENT_ID = 41;
const EXPIRES_AT = '2026-08-01T00:00:00.000Z';
const LIFECYCLE_UI_BASE_URL = 'https://lifecycle.example.test';
const LIFECYCLE_UI_ENVIRONMENT_URL = `${LIFECYCLE_UI_BASE_URL}/environments/${UUID}`;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

function environmentBuild(overrides: Record<string, unknown> = {}): Build {
  return {
    id: ENVIRONMENT_ID,
    uuid: UUID,
    kind: BuildKind.ENVIRONMENT,
    status: BuildStatus.DEPLOYED,
    branchName: 'main',
    triggerType: 'api',
    isStatic: false,
    deployEnabled: true,
    autoTrack: false,
    trackDefaultBranches: false,
    expiresAt: EXPIRES_AT,
    namespace: 'env-candidate-123456',
    runUUID: 'run-1234567890',
    createdByGithubLogin: 'octocat',
    commentRuntimeEnv: { B_KEY: 'x', A_KEY: 'y' },
    commentInitEnv: {},
    deploys: [
      {
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        updatedAt: '2026-07-01T00:00:00.000Z',
        publicHref: 'https://api.example.com',
        deployable: { name: 'api', type: DeployTypes.DOCKER },
      },
    ],
    ...overrides,
  } as unknown as Build;
}

function loadedEnvironment(build: Build) {
  return { build, repository: { githubRepositoryId: 7, fullName: 'goodrx/example' } };
}

const PRINCIPAL: Principal = {
  kind: 'user',
  authMethod: 'oauth',
  userId: 'user-1',
  actor: 'user-1',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
} as Principal;

interface Harness {
  audits: McpToolCallAuditRecord[];
  call: (
    name: string,
    input: McpJsonObject,
    principal?: Principal
  ) => Promise<{ output?: McpJsonObject; error?: McpJsonObject }>;
}

function harness(dependencies: CoreToolDependencies): Harness {
  const audits: McpToolCallAuditRecord[] = [];
  const registry = new McpToolRegistry(
    createCoreToolDefinitions({
      ...dependencies,
      waitForEnvironment: {
        loadTarget: () => Promise.reject(new Error('loadTarget not stubbed')),
        getMaxWaitSeconds: () => 15,
        ...dependencies.waitForEnvironment,
      },
    }),
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    { record: (record) => void audits.push(record) }
  );
  const policy: McpRuntimePolicy = { enabled: true, allowChanges: true, sitesAvailable: true };
  return {
    audits,
    call: async (name, input, principal = PRINCIPAL) => {
      const context: McpToolInvocationContext = {
        principal,
        requestId: 'request-1',
        signal: new AbortController().signal,
      };
      const result = await registry.callTool(name, input, context, policy);
      if (result.isError) {
        const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text) as McpExecutionErrorEnvelope;
        return { error: envelope.error as unknown as McpJsonObject };
      }
      return { output: result.structuredContent as McpJsonObject };
    },
  };
}

const originalLifecycleUiUrl = process.env.LIFECYCLE_UI_URL;

beforeAll(() => {
  process.env.LIFECYCLE_UI_URL = LIFECYCLE_UI_BASE_URL;
  process.env.ENCRYPTION_KEY = '7'.repeat(64);
});

afterAll(() => {
  if (originalLifecycleUiUrl === undefined) delete process.env.LIFECYCLE_UI_URL;
  else process.env.LIFECYCLE_UI_URL = originalLifecycleUiUrl;
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

describe('get_context', () => {
  const config = {
    apiEnvironments: { defaultTtlHours: 72, maxTtlHours: 720, extensionHours: 24 },
    maxWaitSeconds: 15,
  };

  it('reports the signed-in user and dynamic lifetime and wait policies', async () => {
    const { call, audits } = harness({ getContext: { loadConfig: async () => config } });
    const { output } = await call('get_context', {});
    expect(output).toMatchObject({
      user: { id: 'user-1', displayName: 'user-1' },
      environmentPolicy: { defaultTtlHours: 72, maxTtlHours: 720, extensionHours: 24 },
      limits: { defaultWaitSeconds: 10, maxWaitSeconds: 15 },
    });
    expect(output).not.toHaveProperty('capabilities');
    expect(output).not.toHaveProperty('hints');
    expect(audits).toEqual([]);
  });

  it('clamps the dynamic wait policy to the server ceiling', async () => {
    const { call } = harness({ getContext: { loadConfig: async () => ({ ...config, maxWaitSeconds: 999 }) } });
    const { output } = await call('get_context', {});
    expect(output).toMatchObject({ limits: { defaultWaitSeconds: 10, maxWaitSeconds: 15 } });
  });
});

describe('list_repositories', () => {
  it('lists onboarded repositories with a continuation cursor', async () => {
    const { call } = harness({
      listRepositories: {
        listOnboardedRepositories: async () =>
          ({
            repositories: [
              { fullName: 'goodrx/example', defaultEnvId: 3 },
              { fullName: 'goodrx/other', defaultEnvId: null },
            ],
            pagination: { current: 1, total: 2, items: 2, limit: 25 },
          } as never),
        nowSeconds: () => 1_000,
      },
    });
    const { output } = await call('list_repositories', { request: { mode: 'list' } });
    const result = output!.result as McpJsonObject;
    expect(result).toMatchObject({
      mode: 'list',
      repositories: [
        { fullName: 'goodrx/example', hasDefaultEnvironment: true },
        { fullName: 'goodrx/other', hasDefaultEnvironment: false },
      ],
    });
    expect(typeof result.nextCursor).toBe('string');
  });

  it('returns repository detail with deduplicated branches and the default branch included', async () => {
    const { call } = harness({
      listRepositories: {
        findRepository: async () => ({ githubRepositoryId: 7, fullName: 'goodrx/example', defaultEnvId: 3 }),
        listBranches: async () => ({ branches: ['main', 'dev', 'main'], defaultBranch: 'trunk' }),
        listRepositoryEnvironments: async () => [
          { environmentConfigId: 3, name: 'full-stack', isDefault: true },
          { environmentConfigId: 5, name: 'minimal', isDefault: false },
        ],
      },
    });
    const { output } = await call('list_repositories', {
      request: { mode: 'detail', repository: 'goodrx/example' },
    });
    expect(output!.result).toMatchObject({
      mode: 'detail',
      repository: {
        fullName: 'goodrx/example',
        defaultBranch: 'trunk',
        hasDefaultEnvironment: true,
        environments: [
          { environmentConfigId: 3, name: 'full-stack', isDefault: true },
          { environmentConfigId: 5, name: 'minimal', isDefault: false },
        ],
        branches: ['main', 'dev', 'trunk'],
      },
    });
  });

  it('reports an unknown repository as not onboarded', async () => {
    const { call } = harness({ listRepositories: { findRepository: async () => null } });
    const { error } = await call('list_repositories', {
      request: { mode: 'detail', repository: 'goodrx/missing' },
    });
    expect(error).toMatchObject({ code: 'repo_not_onboarded', nextAction: 'fix_input' });
  });
});

describe('preview_environment_config', () => {
  it('previews resolvable services and reports the rest as unresolved', async () => {
    const { call } = harness({
      previewEnvironmentConfig: {
        findRepository: async () => ({ githubRepositoryId: 7, fullName: 'goodrx/example', defaultEnvId: 3 }),
        previewEnvironmentConfig: async () => ({
          valid: true,
          services: [
            {
              name: 'api',
              type: 'docker',
              defaultActive: true,
              editable: true,
              status: 'resolved',
              previewOnly: false,
            },
            {
              name: 'weird',
              type: 'mystery',
              defaultActive: false,
              editable: false,
              status: 'resolved',
              previewOnly: false,
            },
          ],
          unresolved: [{ name: 'ext', status: 'unresolved', reason: 'no branch' }],
        }),
        loadEnvironmentPolicy: async () => ({ defaultTtlHours: 72, maxTtlHours: 720 }),
      },
    });
    const { output } = await call('preview_environment_config', {
      repository: 'goodrx/example',
      branch: 'main',
    });
    expect(output).toMatchObject({
      valid: true,
      services: [{ name: 'api', type: 'docker' }],
      unresolved: ['ext', 'weird'],
      truncated: false,
      policy: { defaultTtlHours: 72, maxTtlHours: 720 },
    });
  });

  it('reports an unreadable configuration as config_invalid', async () => {
    const { call } = harness({
      previewEnvironmentConfig: {
        findRepository: async () => ({ githubRepositoryId: 7, fullName: 'goodrx/example', defaultEnvId: 3 }),
        previewEnvironmentConfig: async () => ({ valid: false, error: 'lifecycle.yaml is missing', services: [] }),
        loadEnvironmentPolicy: async () => ({ defaultTtlHours: 72, maxTtlHours: 720 }),
      },
    });
    const { error } = await call('preview_environment_config', {
      repository: 'goodrx/example',
      branch: 'main',
    });
    expect(error).toMatchObject({ code: 'config_invalid', message: 'lifecycle.yaml is missing' });
  });
});

describe('validate_lifecycle_config', () => {
  it('returns bounded issues for inline content', async () => {
    const { call } = harness({
      validateLifecycleConfig: {
        validateContent: async () => ({
          valid: false,
          errors: [{ path: '$.services[0]', message: 'name is required' }],
        }),
      },
    });
    const { output } = await call('validate_lifecycle_config', {
      source: { mode: 'content', content: 'version: 1' },
    });
    expect(output).toMatchObject({
      valid: false,
      errors: [{ path: '$.services[0]', message: 'name is required' }],
    });
  });

  it('reports a GitHub read failure as retryable upstream unavailability', async () => {
    const { call } = harness({
      validateLifecycleConfig: {
        findRepository: async () => ({ githubRepositoryId: 7, fullName: 'goodrx/example', defaultEnvId: 3 }),
        fetchRepositoryContent: async () => Promise.reject(new Error('github down')),
      },
    });
    const { error } = await call('validate_lifecycle_config', {
      source: { mode: 'repository', repository: 'goodrx/example', branch: 'main' },
    });
    expect(error).toMatchObject({ code: 'upstream_unavailable', retryable: true });
  });
});

describe('list_environments', () => {
  const row = {
    uuid: UUID,
    environmentId: ENVIRONMENT_ID,
    status: 'deployed',
    phase: 'ready',
    repository: 'goodrx/example',
    branch: 'main',
    trigger: 'api',
    isStatic: false,
    deployEnabled: true,
    expiresAt: EXPIRES_AT,
    activeServiceCount: 1,
    ready: true,
    author: 'octocat',
    pullRequest: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };

  it('lists environments and pages with a filter-bound cursor', async () => {
    const listEnvironments = jest.fn().mockResolvedValue({
      data: [row],
      paginationMetadata: { current: 1, total: 3, items: 1, limit: 25 },
    });
    const { call } = harness({ listEnvironments: { listEnvironments, nowSeconds: () => 1_000 } });
    const first = await call('list_environments', {});
    expect(first.output!.environments).toEqual([
      expect.objectContaining({ uuid: UUID, phase: 'ready', lifecycleUiUrl: LIFECYCLE_UI_ENVIRONMENT_URL }),
    ]);
    const cursor = first.output!.nextCursor as string;
    expect(typeof cursor).toBe('string');

    await call('list_environments', { cursor });
    expect(listEnvironments.mock.calls[1][0].pagination).toEqual({ page: 2, limit: 25 });

    const mismatched = await call('list_environments', { cursor, search: 'other' });
    expect(mismatched.error).toMatchObject({ code: 'invalid_cursor' });
  });

  it('normalizes Date-backed list timestamps before output validation', async () => {
    const listEnvironments = jest.fn().mockResolvedValue({
      data: [
        {
          ...row,
          expiresAt: new Date(EXPIRES_AT),
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-02T00:00:00.000Z'),
          deletedAt: new Date('2026-07-03T00:00:00.000Z'),
        },
      ],
      paginationMetadata: { current: 1, total: 1, items: 1, limit: 25 },
    });
    const { call } = harness({ listEnvironments: { listEnvironments } });

    const { output } = await call('list_environments', { includeTornDown: true });

    expect((output!.environments as McpJsonObject[])[0]).toMatchObject({
      expiresAt: EXPIRES_AT,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      deletedAt: '2026-07-03T00:00:00.000Z',
    });
  });

  it('scopes mine to the signed-in user and short-circuits without an identity', async () => {
    const listEnvironments = jest.fn().mockResolvedValue({
      data: [row],
      paginationMetadata: { current: 1, total: 1, items: 1, limit: 25 },
    });
    const { call } = harness({ listEnvironments: { listEnvironments } });
    await call('list_environments', { mine: true });
    expect(listEnvironments.mock.calls[0][0]).toMatchObject({ ownerUserId: 'user-1' });

    const anonymous = { ...PRINCIPAL, userId: null, identity: null } as unknown as Principal;
    const { output } = await call('list_environments', { mine: true }, anonymous);
    expect(output).toMatchObject({ environments: [] });
    expect(listEnvironments.mock.calls).toHaveLength(1);
  });

  it('rejects a repository filter that is not onboarded', async () => {
    const { call } = harness({
      listEnvironments: {
        listEnvironments: jest.fn(),
        findRepository: async () => null,
      },
    });
    const { error } = await call('list_environments', { repository: 'goodrx/missing' });
    expect(error).toMatchObject({ code: 'repo_not_onboarded' });
  });
});

describe('get_environment', () => {
  it('returns the concise environment state', async () => {
    const { call, audits } = harness({
      getEnvironment: { loadEnvironment: async () => loadedEnvironment(environmentBuild()) },
    });
    const { output } = await call('get_environment', { uuid: UUID });
    expect(output!.environment).toMatchObject({
      format: 'concise',
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      lifecycleUiUrl: LIFECYCLE_UI_ENVIRONMENT_URL,
      status: 'deployed',
      phase: 'ready',
      repository: 'goodrx/example',
      trigger: 'api',
      ready: true,
      services: [{ name: 'api', type: 'docker', status: 'ready', active: true, url: 'https://api.example.com' }],
      failingServices: [],
    });
    expect(audits).toEqual([]);
  });

  it('adds namespace and sorted variable keys in detailed format', async () => {
    const { call } = harness({
      getEnvironment: { loadEnvironment: async () => loadedEnvironment(environmentBuild()) },
    });
    const { output } = await call('get_environment', { uuid: UUID, format: 'detailed' });
    expect(output!.environment).toMatchObject({
      format: 'detailed',
      namespace: 'env-candidate-123456',
      envKeys: ['A_KEY', 'B_KEY'],
      initEnvKeys: [],
    });
  });

  it.each(['concise', 'detailed'] as const)('normalizes a Date-backed expiry in %s output', async (format) => {
    const { call } = harness({
      getEnvironment: {
        loadEnvironment: async () => loadedEnvironment(environmentBuild({ expiresAt: new Date(EXPIRES_AT) })),
      },
    });

    const { output } = await call('get_environment', { uuid: UUID, format });

    expect(output!.environment).toMatchObject({ format, expiresAt: EXPIRES_AT });
  });

  it('reports a destroyed environment with its destruction time', async () => {
    const { call } = harness({
      getEnvironment: {
        loadEnvironment: async () => null,
        loadDestroyedEnvironment: async () => ({
          destroyedAt: new Date('2026-07-20T00:00:00.000Z') as never,
        }),
      },
    });
    const { error } = await call('get_environment', { uuid: UUID });
    expect(error).toMatchObject({
      code: 'env_not_found',
      details: { kind: 'destroyed', destroyedAt: '2026-07-20T00:00:00.000Z' },
    });
  });

  it('reports an unknown name without details', async () => {
    const { call } = harness({
      getEnvironment: {
        loadEnvironment: async () => null,
        loadDestroyedEnvironment: async () => null,
      },
    });
    const { error } = await call('get_environment', { uuid: 'unknown-000000' });
    expect(error).toMatchObject({ code: 'env_not_found' });
    expect(error!.details).toBeUndefined();
  });
});

describe('wait_for_environment', () => {
  function clock() {
    let now = 0;
    return {
      nowMilliseconds: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds;
      },
    };
  }

  it('returns immediately when the goal is already reached', async () => {
    const { call } = harness({
      waitForEnvironment: {
        loadTarget: async () => ({
          kind: 'live',
          loaded: loadedEnvironment(environmentBuild({ expiresAt: new Date(EXPIRES_AT) })),
        }),
        getMaxWaitSeconds: () => 15,
        ...clock(),
      },
    });
    const { output } = await call('wait_for_environment', { uuid: UUID, environmentId: ENVIRONMENT_ID });
    expect(output).toMatchObject({
      target: { uuid: UUID, environmentId: ENVIRONMENT_ID },
      result: {
        outcome: 'reached',
        environment: {
          phase: 'ready',
          expiresAt: EXPIRES_AT,
          lifecycleUiUrl: LIFECYCLE_UI_ENVIRONMENT_URL,
        },
      },
    });
  });

  it('returns still-running state without prompting another wait after the default short wait', async () => {
    const building = environmentBuild({
      status: BuildStatus.BUILDING,
      expiresAt: new Date(EXPIRES_AT),
    });
    const testClock = clock();
    const sleep = jest.fn(testClock.sleep);
    const { call } = harness({
      waitForEnvironment: {
        loadTarget: async () => ({ kind: 'live', loaded: loadedEnvironment(building) }),
        getMaxWaitSeconds: () => 15,
        nowMilliseconds: testClock.nowMilliseconds,
        sleep,
      },
    });
    const { output } = await call('wait_for_environment', { uuid: UUID, environmentId: ENVIRONMENT_ID });
    const result = output!.result as McpJsonObject;
    expect(result).toMatchObject({
      outcome: 'still_running',
      environment: { expiresAt: EXPIRES_AT },
    });
    expect(result).not.toHaveProperty('pollAfterSeconds');
    expect(result).not.toHaveProperty('nextWait');
    expect(String(result.note)).toContain('The environment has not reached recorded readiness yet.');
    expect(String(result.note)).toContain('without waiting again unless the user explicitly asks');
    expect(sleep.mock.calls.reduce((total, [milliseconds]) => total + milliseconds, 0)).toBe(10_000);
  });

  it('treats a tombstone as reached for torn_down and destroyed otherwise', async () => {
    const dependencies = {
      loadTarget: async () => ({ kind: 'tombstone' as const }),
      getMaxWaitSeconds: () => 15,
      ...clock(),
    };
    const first = await harness({ waitForEnvironment: dependencies }).call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      goal: 'torn_down',
    });
    expect(first.output!.result).toMatchObject({ outcome: 'reached' });

    const second = await harness({ waitForEnvironment: dependencies }).call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
    });
    expect(second.output!.result).toMatchObject({ outcome: 'destroyed' });
  });

  it('reports teardown as still running until Lifecycle releases the environment name', async () => {
    const { call } = harness({
      waitForEnvironment: {
        loadTarget: async () => ({
          kind: 'live',
          loaded: loadedEnvironment(environmentBuild({ status: BuildStatus.TEARING_DOWN })),
        }),
        getMaxWaitSeconds: () => 15,
        ...clock(),
      },
    });

    const { output } = await call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      goal: 'torn_down',
    });

    expect(output!.result).toMatchObject({
      outcome: 'still_running',
      note: expect.stringContaining('Teardown is still running.'),
    });
  });

  it.each([
    ['failed', { status: BuildStatus.ERROR }],
    ['paused', { status: BuildStatus.PENDING, deployEnabled: false }],
    ['destroyed', { status: BuildStatus.TEARING_DOWN }],
  ] as const)('preserves the terminal %s outcome', async (outcome, overrides) => {
    const { call } = harness({
      waitForEnvironment: {
        loadTarget: async () => ({
          kind: 'live',
          loaded: loadedEnvironment(environmentBuild(overrides)),
        }),
        getMaxWaitSeconds: () => 15,
        ...clock(),
      },
    });

    const { output } = await call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
    });

    expect(output!.result).toMatchObject({ outcome });
  });

  it('returns a terminal neutral outcome when the requested deploy never becomes current', async () => {
    const loadTarget = jest.fn(async () => ({
      kind: 'live' as const,
      loaded: loadedEnvironment(environmentBuild({ status: BuildStatus.BUILDING, runUUID: 'run-other-1234' })),
    }));
    const testClock = clock();
    const sleep = jest.fn(testClock.sleep);
    const { call } = harness({
      waitForEnvironment: {
        loadTarget,
        getMaxWaitSeconds: () => 15,
        nowMilliseconds: testClock.nowMilliseconds,
        sleep,
      },
    });
    const { output } = await call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      deployId: 'run-1234567890',
    });
    const result = output!.result as McpJsonObject;
    expect(result).toMatchObject({
      outcome: 'not_current',
      environment: { currentDeployId: 'run-other-1234' },
    });
    expect(String(result.note)).toContain('could not confirm');
    expect(loadTarget).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.reduce((total, [milliseconds]) => total + milliseconds, 0)).toBe(10_000);
  });

  it('continues waiting when a queued deploy is not current until a worker claims it', async () => {
    const loadTarget = jest
      .fn()
      .mockResolvedValueOnce({
        kind: 'live' as const,
        loaded: loadedEnvironment(environmentBuild({ status: BuildStatus.BUILDING, runUUID: 'run-other-1234' })),
      })
      .mockResolvedValue({
        kind: 'live' as const,
        loaded: loadedEnvironment(environmentBuild({ runUUID: 'run-1234567890' })),
      });
    const { call } = harness({
      waitForEnvironment: {
        loadTarget,
        getMaxWaitSeconds: () => 15,
        ...clock(),
      },
    });

    const { output } = await call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      deployId: 'run-1234567890',
    });

    expect(output!.result).toMatchObject({ outcome: 'reached', environment: { phase: 'ready' } });
    expect(loadTarget).toHaveBeenCalledTimes(2);
  });

  it('refuses to start past wait capacity', async () => {
    const { call } = harness({
      waitForEnvironment: {
        loadTarget: async () => ({ kind: 'live', loaded: loadedEnvironment(environmentBuild()) }),
        getMaxWaitSeconds: () => 15,
        capacity: { acquire: () => ({ acquired: false, reason: 'principal' }) },
        ...clock(),
      },
    });
    const { error } = await call('wait_for_environment', { uuid: UUID, environmentId: ENVIRONMENT_ID });
    expect(error).toMatchObject({ code: 'wait_capacity', retryable: true, retryAfterSeconds: 5 });
  });

  it('rejects a deployId on a torn_down wait at the schema layer', async () => {
    const { call } = harness({});
    const { error } = await call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      goal: 'torn_down',
      deployId: 'run-1234567890',
    });
    expect(error).toMatchObject({ code: 'invalid_body' });
  });

  it('rejects waits longer than the 15-second hard maximum at the schema layer', async () => {
    const { call } = harness({});
    const { error } = await call('wait_for_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      timeoutSeconds: 16,
    });
    expect(error).toMatchObject({ code: 'invalid_body' });
  });
});
