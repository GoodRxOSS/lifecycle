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

import type { Transaction } from 'objection';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { AppError } from 'server/lib/appError';
import type Build from 'server/models/Build';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import type { McpJsonObject, McpRuntimePolicy, McpToolInvocationContext } from '../contracts';
import type { McpExecutionErrorEnvelope } from '../errors';
import { McpToolRegistry, type McpToolCallAuditRecord } from '../registry';
import { verifyDestroyConfirmation } from '../security/destroyConfirmation';
import {
  createEnvironmentOperationToolDefinitions,
  type EnvironmentOperationService,
  type EnvironmentOperationToolDependencies,
} from '../tools/operations';
import { EXTEND_MAX_NEXT } from '../tools/operations/schemas';

const UUID = 'candidate-123456';
const ENVIRONMENT_ID = 41;
const EXPIRES_AT = '2026-08-01T00:00:00.000Z';
const LIFECYCLE_UI_URL = 'https://lifecycle.example.com';
const ENVIRONMENT_UI_URL = `${LIFECYCLE_UI_URL}/environments/${UUID}`;

const originalKey = process.env.ENCRYPTION_KEY;
const originalLifecycleUiUrl = process.env.LIFECYCLE_UI_URL;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '7'.repeat(64);
  process.env.LIFECYCLE_UI_URL = LIFECYCLE_UI_URL;
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
  if (originalLifecycleUiUrl === undefined) delete process.env.LIFECYCLE_UI_URL;
  else process.env.LIFECYCLE_UI_URL = originalLifecycleUiUrl;
});

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
    commentRuntimeEnv: {},
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

interface Harness {
  registry: McpToolRegistry;
  audits: McpToolCallAuditRecord[];
  call: (name: string, input: McpJsonObject) => Promise<{ output?: McpJsonObject; error?: McpJsonObject }>;
}

function harness(dependencies: EnvironmentOperationToolDependencies): Harness {
  const audits: McpToolCallAuditRecord[] = [];
  const registry = new McpToolRegistry(
    createEnvironmentOperationToolDefinitions({
      loadNamedEnvironment: () => Promise.reject(new Error('loadNamedEnvironment not stubbed')),
      listEnvironmentChoices: () => Promise.reject(new Error('listEnvironmentChoices not stubbed')),
      lockDestroyPreview: () => Promise.reject(new Error('lockDestroyPreview not stubbed')),
      snapshotLockedDestroyState: () => Promise.reject(new Error('snapshotLockedDestroyState not stubbed')),
      ...dependencies,
    }),
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    { record: (record) => void audits.push(record) }
  );
  const context: McpToolInvocationContext = {
    principal: {
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
    },
    requestId: 'request-1',
    signal: new AbortController().signal,
  };
  const policy: McpRuntimePolicy = { enabled: true, allowChanges: true, sitesAvailable: true };
  return {
    registry,
    audits,
    call: async (name, input) => {
      const result = await registry.callTool(name, input, context, policy);
      if (result.isError) {
        const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text) as McpExecutionErrorEnvelope;
        return { error: envelope.error as unknown as McpJsonObject };
      }
      return { output: result.structuredContent as McpJsonObject };
    },
  };
}

function operationService(overrides: Partial<Record<keyof EnvironmentOperationService, unknown>>) {
  return {
    createApiEnvironment: jest.fn().mockRejectedValue(new Error('createApiEnvironment not stubbed')),
    applyApiEnvironmentPatch: jest.fn().mockRejectedValue(new Error('applyApiEnvironmentPatch not stubbed')),
    redeployBuild: jest.fn().mockRejectedValue(new Error('redeployBuild not stubbed')),
    extendApiEnvironment: jest.fn().mockRejectedValue(new Error('extendApiEnvironment not stubbed')),
    requestApiEnvironmentDeletion: jest.fn().mockRejectedValue(new Error('requestApiEnvironmentDeletion not stubbed')),
    ...overrides,
  } as unknown as EnvironmentOperationService;
}

describe('create_environment', () => {
  const input = {
    repository: 'goodrx/example',
    branch: 'main',
    idempotencyKey: 'task-1234.main',
  };

  it('returns an acceptance receipt without prompting automatic monitoring', async () => {
    const service = operationService({
      createApiEnvironment: jest
        .fn()
        .mockResolvedValue({ build: environmentBuild({ expiresAt: new Date(EXPIRES_AT) }), replayed: false }),
    });
    const { call } = harness({ service });
    const { output } = await call('create_environment', input);
    expect(output).toMatchObject({
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      status: 'deployed',
      replayed: false,
      namespace: 'env-candidate-123456',
      expiresAt: EXPIRES_AT,
      lifecycleUiUrl: ENVIRONMENT_UI_URL,
    });
    expect(output).not.toHaveProperty('wait');
    expect(String(output!.next)).toContain('continues in the background');
    expect(String(output!.next)).toContain('get_environment');
    expect(String(output!.next)).toContain('when the user asks');
    expect(String(output!.next)).toContain('Show lifecycleUiUrl to the user');
    expect(String(output!.next)).not.toContain('wait_for_environment');
  });

  it('passes every optional field to the service, renaming environmentConfigId to environmentId', async () => {
    const createApiEnvironment = jest
      .fn()
      .mockResolvedValue({ build: environmentBuild({ expiresAt: new Date(EXPIRES_AT) }), replayed: false });
    const service = operationService({ createApiEnvironment });
    const { call } = harness({ service });

    const { output } = await call('create_environment', {
      ...input,
      sha: 'a'.repeat(40),
      name: 'my-env',
      environmentConfigId: 42,
      services: [{ name: 'api', active: true, branchOrExternalUrl: 'feature/x' }],
      env: { LOG_LEVEL: 'debug' },
      initEnv: { SEED: 'true' },
      deployEnabled: true,
      autoTrack: true,
      trackDefaultBranches: false,
      ttlHours: 72,
    });

    expect(output).toMatchObject({ uuid: UUID, environmentId: ENVIRONMENT_ID });
    expect(createApiEnvironment).toHaveBeenCalledWith(
      {
        repositoryFullName: 'goodrx/example',
        branch: 'main',
        idempotencyKey: 'task-1234.main',
        createdBy: 'user-1',
        createdByUserId: 'user-1',
        createdByGithubLogin: null,
        sha: 'a'.repeat(40),
        name: 'my-env',
        environmentId: 42,
        services: [{ name: 'api', active: true, branchOrExternalUrl: 'feature/x' }],
        env: { LOG_LEVEL: 'debug' },
        initEnv: { SEED: 'true' },
        deployEnabled: true,
        autoTrack: true,
        trackDefaultBranches: false,
        ttlHours: 72,
      },
      null,
      { requireApiEnvironmentsEnabled: false }
    );
  });

  it('directs a paused environment to configure_environment instead of waiting', async () => {
    const service = operationService({
      createApiEnvironment: jest
        .fn()
        .mockResolvedValue({ build: environmentBuild({ deployEnabled: false }), replayed: true }),
    });
    const { call } = harness({ service });
    const { output } = await call('create_environment', input);
    expect(output).toMatchObject({ replayed: true });
    expect(output!.lifecycleUiUrl).toBe(ENVIRONMENT_UI_URL);
    expect(String(output!.next)).toContain('configure_environment');
    expect(String(output!.next)).toContain('get_environment');
    expect(String(output!.next)).toContain('Show lifecycleUiUrl to the user');
    expect(String(output!.next)).not.toContain('wait_for_environment');
  });

  it('omits an invalid Lifecycle UI URL from the receipt and guidance', async () => {
    process.env.LIFECYCLE_UI_URL = 'not-a-url';
    const service = operationService({
      createApiEnvironment: jest.fn().mockResolvedValue({ build: environmentBuild(), replayed: false }),
    });
    const { call } = harness({ service });
    const { output } = await call('create_environment', input);
    expect(output).not.toHaveProperty('lifecycleUiUrl');
    expect(String(output!.next)).not.toContain('lifecycleUiUrl');
  });

  it('lists the configured environments when the repository default is ambiguous', async () => {
    const service = operationService({
      createApiEnvironment: jest
        .fn()
        .mockRejectedValue(new AppError({ httpStatus: 400, code: 'env_ambiguous', message: 'Pick an environment.' })),
    });
    const { call } = harness({
      service,
      listEnvironmentChoices: async () => [
        { environmentConfigId: 3, name: 'full-stack', isDefault: true },
        { environmentConfigId: 5, name: 'minimal', isDefault: false },
      ],
    });
    const { error } = await call('create_environment', input);
    expect(error).toMatchObject({
      code: 'env_ambiguous',
      nextAction: 'fix_input',
      details: {
        environments: [
          { environmentConfigId: 3, name: 'full-stack', isDefault: true },
          { environmentConfigId: 5, name: 'minimal', isDefault: false },
        ],
      },
    });
  });

  it('maps domain validation failures onto invalid_body issues', async () => {
    const service = operationService({
      createApiEnvironment: jest
        .fn()
        .mockRejectedValue(
          new AppError({ httpStatus: 400, code: 'invalid_branch', message: 'Branch does not exist.' })
        ),
    });
    const { call } = harness({ service });
    const { error } = await call('create_environment', input);
    expect(error).toMatchObject({
      code: 'invalid_body',
      details: { issues: [{ path: '/', message: 'Branch does not exist.' }] },
    });
  });

  it('rejects an idempotency key the schema does not allow before any service call', async () => {
    const service = operationService({});
    const { call } = harness({ service });
    const { error } = await call('create_environment', { ...input, idempotencyKey: 'no spaces allowed' });
    expect(error).toMatchObject({ code: 'invalid_body' });
    expect((service.createApiEnvironment as jest.Mock).mock.calls).toHaveLength(0);
  });
});

describe('configure_environment', () => {
  it('returns the saved state when no deploy is queued', async () => {
    const build = environmentBuild();
    const service = operationService({
      applyApiEnvironmentPatch: jest.fn().mockResolvedValue({ mode: 'applied', changed: true, build }),
    });
    const { call } = harness({ service, loadNamedEnvironment: async () => loadedEnvironment(build) });
    const { output } = await call('configure_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      patch: { env: { LOG_LEVEL: 'debug', UNUSED: null } },
    });
    expect(output).toMatchObject({
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      applied: true,
      result: { mode: 'applied' },
    });
    expect(output!.environment).toMatchObject({ uuid: UUID, phase: 'ready', repository: 'goodrx/example' });
    expect(String((output!.result as McpJsonObject).next)).toContain('running workload may predate');
    expect(String((output!.result as McpJsonObject).next)).toContain('deploy_environment');
    expect((service.applyApiEnvironmentPatch as jest.Mock).mock.calls[0][3]).toEqual({ envMode: 'merge' });
  });

  it('returns the queued deploy without prompting automatic monitoring', async () => {
    const build = environmentBuild();
    const service = operationService({
      applyApiEnvironmentPatch: jest
        .fn()
        .mockResolvedValue({ mode: 'redeploy_queued', changed: true, deployId: 'run-1234567890', build }),
    });
    const { call } = harness({ service, loadNamedEnvironment: async () => loadedEnvironment(build) });
    const { output } = await call('configure_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      patch: { deployEnabled: true },
    });
    expect(output!.result).toMatchObject({
      mode: 'redeploy_queued',
      deployId: 'run-1234567890',
      next: expect.stringContaining('continues in the background'),
    });
    const result = output!.result as McpJsonObject;
    expect(result).not.toHaveProperty('wait');
    expect(String(result.next)).toContain('get_environment');
    expect(String(result.next)).toContain('when the user asks');
    expect(String(result.next)).not.toContain('wait_for_environment');
  });

  it('rejects a service override that changes nothing', async () => {
    const build = environmentBuild();
    const { call } = harness({
      service: operationService({}),
      loadNamedEnvironment: async () => loadedEnvironment(build),
    });
    const { error } = await call('configure_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      patch: { services: [{ name: 'api' }] },
    });
    expect(error).toMatchObject({
      code: 'invalid_body',
      details: { issues: [{ path: '/patch/services/0' }] },
    });
  });

  it('rejects an empty patch at the schema layer', async () => {
    const { call } = harness({ service: operationService({}) });
    const { error } = await call('configure_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      patch: {},
    });
    expect(error).toMatchObject({ code: 'invalid_body' });
  });

  it('reports a stale environmentId as a replaced environment', async () => {
    const { call } = harness({
      service: operationService({}),
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
    });
    const { error } = await call('configure_environment', {
      uuid: UUID,
      environmentId: 99,
      patch: { deployEnabled: true },
    });
    expect(error).toMatchObject({
      code: 'environment_replaced',
      details: { replacementExists: true },
    });
  });
});

describe('deploy_environment', () => {
  const input = { uuid: UUID, environmentId: ENVIRONMENT_ID };

  it('queues a deploy and returns its identity without prompting automatic monitoring', async () => {
    const service = operationService({
      redeployBuild: jest.fn().mockResolvedValue({ status: 'success', message: 'ok', deployId: 'run-1234567890' }),
    });
    const { call, audits } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
    });
    const { output } = await call('deploy_environment', input);
    expect(output).toMatchObject({
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      queued: true,
      deployId: 'run-1234567890',
      lifecycleUiUrl: ENVIRONMENT_UI_URL,
      next: expect.stringContaining('continues in the background'),
    });
    expect(output).not.toHaveProperty('wait');
    expect(String(output!.next)).toContain('get_environment');
    expect(String(output!.next)).toContain('when the user asks');
    expect(String(output!.next)).toContain('Show lifecycleUiUrl to the user');
    expect(String(output!.next)).not.toContain('wait_for_environment');
    expect(audits).toEqual([
      expect.objectContaining({
        tool: 'deploy_environment',
        outcome: 'succeeded',
        stage: 'success',
        fields: expect.objectContaining({ uuid: UUID, environmentId: ENVIRONMENT_ID, deployId: 'run-1234567890' }),
      }),
    ]);
  });

  it.each([
    ['not_found', 'env_not_found'],
    ['tearing_down', 'env_tearing_down'],
    ['deploy_disabled', 'deploy_disabled'],
  ])('maps a %s result onto %s', async (status, code) => {
    const service = operationService({
      redeployBuild: jest.fn().mockResolvedValue({ status, message: 'no' }),
    });
    const { call } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
    });
    const { error } = await call('deploy_environment', input);
    expect(error).toMatchObject({ code });
  });

  it('fails closed when the service returns a malformed deploy id', async () => {
    const service = operationService({
      redeployBuild: jest.fn().mockResolvedValue({ status: 'success', message: 'ok', deployId: 'short' }),
    });
    const { call } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
    });
    const { error } = await call('deploy_environment', input);
    expect(error).toMatchObject({ code: 'internal_error' });
  });
});

describe('extend_environment', () => {
  const input = { uuid: UUID, environmentId: ENVIRONMENT_ID };

  it('returns the new expiry', async () => {
    const service = operationService({
      extendApiEnvironment: jest.fn().mockResolvedValue({
        build: environmentBuild({ expiresAt: new Date(EXPIRES_AT) }),
        addedHours: 12,
        maxReached: false,
      }),
    });
    const { call } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
    });
    const { output } = await call('extend_environment', { ...input, hours: 12, ifExpiresAt: EXPIRES_AT });
    expect(output).toMatchObject({ uuid: UUID, expiresAt: EXPIRES_AT, addedHours: 12, maxReached: false });
    expect(output!.next).toBeUndefined();
    const serviceCall = (service.extendApiEnvironment as jest.Mock).mock.calls[0];
    expect(serviceCall).toEqual([UUID, 12, ENVIRONMENT_ID, { ifExpiresAt: EXPIRES_AT, rejectPullRequest: true }]);
  });

  it('explains when the maximum lifetime is reached', async () => {
    const service = operationService({
      extendApiEnvironment: jest.fn().mockResolvedValue({ build: environmentBuild(), addedHours: 2, maxReached: true }),
    });
    const { call } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
    });
    const { output } = await call('extend_environment', input);
    expect(output).toMatchObject({ maxReached: true, next: EXTEND_MAX_NEXT });
  });

  it('reports a concurrent extension with the current expiry', async () => {
    const service = operationService({
      extendApiEnvironment: jest.fn().mockRejectedValue(
        new AppError({
          httpStatus: 409,
          code: 'expiry_conflict',
          message: 'The environment expiry changed.',
          details: { currentExpiresAt: new Date(EXPIRES_AT) },
        })
      ),
    });
    const { call } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
    });
    const { error } = await call('extend_environment', { ...input, ifExpiresAt: '2026-07-01T00:00:00.000Z' });
    expect(error).toMatchObject({
      code: 'expiry_conflict',
      details: { currentExpiresAt: EXPIRES_AT },
    });
  });
});

describe('destroy_environment', () => {
  const snapshot = () => ({
    build: environmentBuild({ expiresAt: new Date(EXPIRES_AT) }),
    activeServiceNames: ['api', 'web'],
  });

  async function previewToken(overrides: EnvironmentOperationToolDependencies = {}): Promise<string> {
    const { call } = harness({
      service: operationService({}),
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
      lockDestroyPreview: async () => snapshot(),
      nowSeconds: () => 1_000,
      ...overrides,
    });
    const { output } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'preview' },
    });
    const result = output!.result as McpJsonObject;
    return result.confirmToken as string;
  }

  it('previews with a confirmation token sealed to the environment and user', async () => {
    const { call, registry } = harness({
      service: operationService({}),
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
      lockDestroyPreview: async () => snapshot(),
      nowSeconds: () => 1_000,
    });
    const { output } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'preview' },
    });
    const result = output!.result as McpJsonObject;
    expect(result).toMatchObject({
      phase: 'preview',
      confirmationRequired: true,
      environment: {
        uuid: UUID,
        environmentId: ENVIRONMENT_ID,
        repository: 'goodrx/example',
        branch: 'main',
        services: ['api', 'web'],
        isStatic: false,
        author: 'octocat',
        expiresAt: EXPIRES_AT,
      },
      expiresInSeconds: 300,
    });
    expect(result.confirmToken).toMatch(/^lfcmcp_destroy_v1\./);
    const outputSchema = registry.definitions().find(({ name }) => name === 'destroy_environment')!.outputSchema;
    expect(new AjvJsonSchemaValidator().getValidator(outputSchema)(output)).toEqual(
      expect.objectContaining({ valid: true })
    );
    const claims = verifyDestroyConfirmation(
      result.confirmToken as string,
      { environmentId: ENVIRONMENT_ID, userId: 'user-1' },
      1_001
    );
    expect(claims).toMatchObject({ environmentId: ENVIRONMENT_ID, userId: 'user-1', iat: 1_000, exp: 1_300 });
  });

  it('executes only after revalidating the locked state and audits the execute phase', async () => {
    const confirmToken = await previewToken();
    const destroyed = environmentBuild();
    let validated = false;
    const service = operationService({
      requestApiEnvironmentDeletion: jest.fn(async (_uuid, _environmentId, options) => {
        await options.validateLockedState(destroyed, {} as Transaction);
        validated = true;
        return destroyed;
      }),
    });
    const { call, audits } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
      snapshotLockedDestroyState: async () => snapshot(),
      nowSeconds: () => 1_100,
    });
    const { output } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'execute', confirmToken },
    });
    expect(validated).toBe(true);
    expect(output!.result).toMatchObject({
      phase: 'execute',
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      status: 'tearing_down_queued',
      alreadyDestroying: false,
      next: expect.stringContaining('continues in the background'),
    });
    const receipt = output!.result as McpJsonObject;
    expect(receipt).not.toHaveProperty('wait');
    expect(String(receipt.next)).toContain('get_environment');
    expect(String(receipt.next)).toContain('when the user asks');
    expect(String(receipt.next)).not.toContain('wait_for_environment');
    expect(audits).toEqual([
      expect.objectContaining({
        tool: 'destroy_environment',
        outcome: 'succeeded',
        fields: expect.objectContaining({ uuid: UUID, environmentId: ENVIRONMENT_ID, operation: 'execute' }),
      }),
    ]);
  });

  it('rejects execution when the environment changed since the preview', async () => {
    const confirmToken = await previewToken();
    const service = operationService({
      requestApiEnvironmentDeletion: jest.fn(async (_uuid, _environmentId, options) => {
        await options.validateLockedState(environmentBuild(), {} as Transaction);
        return environmentBuild();
      }),
    });
    const { call } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
      snapshotLockedDestroyState: async () => ({
        build: environmentBuild(),
        activeServiceNames: ['api', 'web', 'worker'],
      }),
      nowSeconds: () => 1_100,
    });
    const { error } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'execute', confirmToken },
    });
    expect(error).toMatchObject({ code: 'confirm_token_invalid', nextAction: 'confirm' });
    expect(String(error!.message)).toContain('changed');
  });

  it('reports an already-tearing-down environment idempotently', async () => {
    const confirmToken = await previewToken();
    const service = operationService({
      requestApiEnvironmentDeletion: jest.fn().mockResolvedValue(environmentBuild()),
    });
    const { call } = harness({
      service,
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
      nowSeconds: () => 1_100,
    });
    const { output } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'execute', confirmToken },
    });
    expect(output!.result).toMatchObject({
      phase: 'execute',
      alreadyDestroying: true,
      next: expect.stringContaining('queue entry was reasserted'),
    });
  });

  it('rejects an expired confirmation distinctly', async () => {
    const confirmToken = await previewToken();
    const { call } = harness({
      service: operationService({}),
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild()),
      nowSeconds: () => 1_301,
    });
    const { error } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'execute', confirmToken },
    });
    expect(error).toMatchObject({ code: 'confirm_token_expired', nextAction: 'confirm' });
  });

  it('protects static environments', async () => {
    const { call } = harness({
      service: operationService({}),
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild({ isStatic: true })),
    });
    const { error } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'preview' },
    });
    expect(error).toMatchObject({ code: 'env_static_protected' });
  });

  it('protects pull-request environments', async () => {
    const { call } = harness({
      service: operationService({}),
      loadNamedEnvironment: async () => loadedEnvironment(environmentBuild({ triggerType: 'github_pr' })),
    });
    const { error } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'execute', confirmToken: 'x'.repeat(24) },
    });
    expect(error).toMatchObject({ code: 'env_pr_protected' });
  });

  it('rejects an execute request without a token at the schema layer', async () => {
    const { call } = harness({ service: operationService({}) });
    const { error } = await call('destroy_environment', {
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      confirmation: { phase: 'execute' },
    });
    expect(error).toMatchObject({ code: 'invalid_body' });
  });
});
