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

import { AppError } from 'server/lib/appError';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import Environment from 'server/models/Environment';
import Repository from 'server/models/Repository';
import Service from 'server/models/Service';
import BuildService from 'server/services/build';
import { BuildKind } from 'shared/constants';
import OverrideService, {
  BuildUuidValidationError,
  ServiceOverrideNotEditableError,
  ServiceOverrideNotFoundError,
} from 'server/services/override';
import { McpExecutionError } from '../../../errors';
import {
  annotateEnvironment,
  assertAuthorizedEnvironmentTarget,
  assertEnvironmentDestroyable,
  environmentDestroyConfirmationState,
  invalidEnvironmentConfirmation,
  mapEnvironmentOperationError,
  principalEnvironmentCreateFields,
  requiredEnvironmentExpiry,
  requiredEnvironmentNamespace,
  resolveEnvironmentOperationToolDependencies,
  validEnvironmentServiceNames,
} from '../shared';

describe('environment operation shared helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses every explicitly injected dependency without replacing it', async () => {
    const service = { createApiEnvironment: jest.fn() } as any;
    const override = { applyOverrides: jest.fn() } as any;
    const loaded = { build: { id: 7 } } as any;
    const loadNamedEnvironment = jest.fn().mockResolvedValue(loaded);
    const listEnvironmentChoices = jest.fn().mockResolvedValue([]);
    const snapshot = { build: loaded.build, activeServiceNames: [] } as any;
    const lockDestroyPreview = jest.fn().mockResolvedValue(snapshot);
    const snapshotLockedDestroyState = jest.fn().mockResolvedValue(snapshot);
    const nowSeconds = jest.fn(() => 1234);

    const resolved = resolveEnvironmentOperationToolDependencies({
      service,
      override,
      loadNamedEnvironment,
      listEnvironmentChoices,
      lockDestroyPreview,
      snapshotLockedDestroyState,
      nowSeconds,
    });

    expect(resolved.service()).toBe(service);
    expect(resolved.override()).toBe(override);
    await expect(resolved.loadNamedEnvironment('env-1')).resolves.toBe(loaded);
    await expect(resolved.listEnvironmentChoices('org/repo')).resolves.toEqual([]);
    await expect(resolved.lockDestroyPreview('env-1', 7)).resolves.toBe(snapshot);
    await expect(resolved.snapshotLockedDestroyState(loaded.build, {} as any)).resolves.toBe(snapshot);
    expect(resolved.nowSeconds()).toBe(1234);
  });

  it('memoizes the default services and resolves named reads through the supplied read seams', async () => {
    const loaded = { build: { id: 7, kind: BuildKind.ENVIRONMENT }, repository: { fullName: 'org/repo' } } as any;
    const loadEnvironment = jest.fn().mockResolvedValue(loaded);
    const loadDestroyedEnvironment = jest.fn();
    const resolved = resolveEnvironmentOperationToolDependencies({
      environmentRead: { loadEnvironment, loadDestroyedEnvironment },
    });

    expect(resolved.service()).toBeInstanceOf(BuildService);
    expect(resolved.service()).toBe(resolved.service());
    expect(resolved.override()).toBeInstanceOf(OverrideService);
    expect(resolved.override()).toBe(resolved.override());
    await expect(resolved.loadNamedEnvironment('env-1')).resolves.toBe(loaded);
    expect(loadEnvironment).toHaveBeenCalledWith('env-1');
    expect(loadDestroyedEnvironment).not.toHaveBeenCalled();
  });

  it('lists environment choices only for a live case-insensitive repository match and caps the result', async () => {
    const repository = { githubRepositoryId: 7, fullName: 'Org/Repo', defaultEnvId: 1 } as any;
    const first = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(repository);
    const whereNull = jest.fn(() => ({ first }));
    const whereRaw = jest.fn(() => ({ whereNull }));
    jest.spyOn(Repository, 'query').mockReturnValue({ whereRaw } as any);
    const environmentIds = Array.from({ length: 51 }, (_, index) => index + 1);
    const memberships = environmentIds.map((environmentId) => ({ environmentId }));
    const environments = environmentIds.map((id) => ({ id, name: `environment-${String(id).padStart(3, '0')}` }));
    const whereNotNull = jest.fn().mockResolvedValueOnce(memberships).mockResolvedValueOnce([]);
    const serviceQuery: any = {};
    Object.assign(serviceQuery, {
      alias: jest.fn(() => serviceQuery),
      join: jest.fn(() => serviceQuery),
      distinct: jest.fn(() => serviceQuery),
      where: jest.fn(() => serviceQuery),
      whereNull: jest.fn(() => serviceQuery),
      whereNotNull,
    });
    jest.spyOn(Service, 'query').mockReturnValue(serviceQuery);
    const whereIn = jest.fn().mockResolvedValue(environments);
    jest.spyOn(Environment, 'query').mockReturnValue({ whereIn } as any);
    const resolved = resolveEnvironmentOperationToolDependencies();

    await expect(resolved.listEnvironmentChoices(' Org/Repo ')).resolves.toEqual([]);
    const listed = await resolved.listEnvironmentChoices(' Org/Repo ');
    expect(listed).toHaveLength(50);
    expect(listed[0]).toEqual({ environmentConfigId: 1, name: 'environment-001', isDefault: true });
    expect(listed.at(-1)).toEqual({ environmentConfigId: 50, name: 'environment-050', isDefault: false });
    expect(whereRaw).toHaveBeenCalledTimes(2);
    expect(whereRaw).toHaveBeenCalledWith('lower("fullName") = ?', ['org/repo']);
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(Service.query).toHaveBeenCalledTimes(2);
    expect(whereIn).toHaveBeenCalledWith('id', environmentIds);
  });

  it('snapshots only active named deploys through the locked transaction query', async () => {
    const trx = { transaction: true } as any;
    const deploys = [
      { active: true, deployable: { name: 'zeta' } },
      { active: false, deployable: { name: 'inactive' } },
      { active: true, deployable: { name: 'alpha' } },
      { active: true, deployable: { name: 'alpha' } },
      { active: true, deployable: null },
    ] as any;
    const select = jest.fn();
    const modifyGraph = jest.fn((_relation: string, callback: (builder: { select: jest.Mock }) => void) => {
      callback({ select });
      return Promise.resolve(deploys);
    });
    const withGraphFetched = jest.fn(() => ({ modifyGraph }));
    const where = jest.fn(() => ({ withGraphFetched }));
    const query = jest.spyOn(Deploy, 'query').mockReturnValue({ where } as any);
    const build = { id: 17 } as any;
    const resolved = resolveEnvironmentOperationToolDependencies();

    await expect(resolved.snapshotLockedDestroyState(build, trx)).resolves.toEqual({
      build,
      activeServiceNames: ['alpha', 'zeta'],
    });
    expect(query).toHaveBeenCalledWith(trx);
    expect(where).toHaveBeenCalledWith({ buildId: 17, active: true });
    expect(withGraphFetched).toHaveBeenCalledWith('deployable');
    expect(modifyGraph).toHaveBeenCalledWith('deployable', expect.any(Function));
    expect(select).toHaveBeenCalledWith('name');
    expect(build.deploys).toBe(deploys);
  });

  it('locks the exact live environment row before producing a destruction preview', async () => {
    const trx = { transaction: true } as any;
    const build = { id: 17, uuid: 'env-1', kind: BuildKind.ENVIRONMENT } as any;
    const forUpdate = jest.fn().mockResolvedValue(build);
    const whereNull = jest.fn(() => ({ forUpdate }));
    const findOne = jest.fn(() => ({ whereNull }));
    const query = jest.spyOn(Build, 'query').mockReturnValue({ findOne } as any);
    jest.spyOn(Build, 'transact').mockImplementation(async (callback: any) => callback(trx));
    const snapshot = { build, activeServiceNames: ['api'] };
    const snapshotLockedDestroyState = jest.fn().mockResolvedValue(snapshot);
    const resolved = resolveEnvironmentOperationToolDependencies({ snapshotLockedDestroyState });

    await expect(resolved.lockDestroyPreview('env-1', 17)).resolves.toBe(snapshot);
    expect(query).toHaveBeenCalledWith(trx);
    expect(findOne).toHaveBeenCalledWith({ id: 17, uuid: 'env-1', kind: BuildKind.ENVIRONMENT });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(forUpdate).toHaveBeenCalledTimes(1);
    expect(snapshotLockedDestroyState).toHaveBeenCalledWith(build, trx);
  });

  it('fails a destruction preview when the locked environment row no longer exists', async () => {
    const trx = { transaction: true } as any;
    const forUpdate = jest.fn().mockResolvedValue(undefined);
    const whereNull = jest.fn(() => ({ forUpdate }));
    const findOne = jest.fn(() => ({ whereNull }));
    jest.spyOn(Build, 'query').mockReturnValue({ findOne } as any);
    jest.spyOn(Build, 'transact').mockImplementation(async (callback: any) => callback(trx));
    const snapshotLockedDestroyState = jest.fn();
    const resolved = resolveEnvironmentOperationToolDependencies({ snapshotLockedDestroyState });

    await expect(resolved.lockDestroyPreview('missing', 17)).rejects.toMatchObject({ code: 'env_not_found' });
    expect(snapshotLockedDestroyState).not.toHaveBeenCalled();
  });

  it('uses whole elapsed seconds for the default operation clock', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_234_999);
    expect(resolveEnvironmentOperationToolDependencies().nowSeconds()).toBe(1234);
  });

  it('maps principal attribution with and without a GitHub identity', () => {
    expect(
      principalEnvironmentCreateFields({
        actor: 'user-1',
        userId: 'user-1',
        identity: { githubUsername: 'octocat' },
      } as any)
    ).toEqual({ createdBy: 'user-1', createdByUserId: 'user-1', createdByGithubLogin: 'octocat' });
    expect(
      principalEnvironmentCreateFields({ actor: 'token:automation', userId: null, identity: null } as any)
    ).toEqual({ createdBy: 'token:automation', createdByUserId: null, createdByGithubLogin: null });
  });

  it('binds an authorized name read to the exact environment row', () => {
    expect(() =>
      assertAuthorizedEnvironmentTarget({ build: { kind: BuildKind.ENVIRONMENT, id: 7 } } as any, 7)
    ).not.toThrow();
    expect(() => assertAuthorizedEnvironmentTarget({ build: { kind: BuildKind.SANDBOX, id: 7 } } as any, 7)).toThrow(
      expect.objectContaining({ code: 'env_not_found' })
    );
    expect(() =>
      assertAuthorizedEnvironmentTarget({ build: { kind: BuildKind.ENVIRONMENT, id: 8 } } as any, 7)
    ).toThrow(expect.objectContaining({ code: 'environment_replaced', details: { replacementExists: true } }));
  });

  it('requires a safe namespace and normalized expiry', () => {
    expect(requiredEnvironmentNamespace({ namespace: ' sample-namespace ' } as any)).toBe(' sample-namespace ');
    expect(() => requiredEnvironmentNamespace({ namespace: '' } as any)).toThrow(
      expect.objectContaining({ code: 'internal_error' })
    );
    expect(requiredEnvironmentExpiry({ expiresAt: '2026-04-24T12:00:00.000Z' } as any)).toBe(
      '2026-04-24T12:00:00.000Z'
    );
    expect(() => requiredEnvironmentExpiry({ expiresAt: 'not-a-date' } as any)).toThrow(
      expect.objectContaining({ code: 'internal_error' })
    );
  });

  it('returns unique sorted service names and annotates optional operation fields', () => {
    const build = {
      id: 7,
      uuid: 'env-1',
      deploys: [
        { deployable: { name: 'zeta' } },
        { deployable: { name: 'alpha' } },
        { deployable: { name: 'alpha' } },
        { deployable: { name: '' } },
      ],
    } as any;
    expect(validEnvironmentServiceNames(build)).toEqual(['alpha', 'zeta']);

    const annotate = jest.fn();
    annotateEnvironment({ audit: { annotate } } as any, build, { deployId: 'deploy-1', operation: 'execute' });
    expect(annotate).toHaveBeenCalledWith({
      uuid: 'env-1',
      environmentId: 7,
      deployId: 'deploy-1',
      operation: 'execute',
    });
    annotateEnvironment({ audit: { annotate } } as any, build);
    expect(annotate).toHaveBeenLastCalledWith({ uuid: 'env-1', environmentId: 7 });
  });

  it('protects static and pull-request environments but permits API environments', () => {
    expect(() => assertEnvironmentDestroyable({ isStatic: true, triggerType: 'api' } as any)).toThrow(
      expect.objectContaining({ code: 'env_static_protected' })
    );
    expect(() => assertEnvironmentDestroyable({ isStatic: false, triggerType: 'pull_request' } as any)).toThrow(
      expect.objectContaining({ code: 'env_pr_protected' })
    );
    expect(() => assertEnvironmentDestroyable({ isStatic: false, triggerType: 'api' } as any)).not.toThrow();
  });

  it('builds a stable sorted destroy confirmation snapshot', () => {
    expect(
      environmentDestroyConfirmationState({
        build: { status: 'ready', expiresAt: '2026-04-24T12:00:00.000Z' } as any,
        activeServiceNames: ['zeta', 'alpha', '', 'alpha'],
      })
    ).toEqual({
      status: 'ready',
      activeServiceNames: ['alpha', 'alpha', 'zeta'],
      expiresAt: '2026-04-24T12:00:00.000Z',
    });
    expect(
      environmentDestroyConfirmationState({
        build: { status: 'ready', expiresAt: null } as any,
        activeServiceNames: [],
      })
    ).toEqual({ status: 'ready', activeServiceNames: [], expiresAt: null });
    expect(invalidEnvironmentConfirmation()).toMatchObject({ code: 'confirm_token_invalid' });
  });
});

describe('mapEnvironmentOperationError', () => {
  const appError = (code: string, message = `${code} message`, details?: Record<string, unknown>) =>
    new AppError({ httpStatus: 400, code, message, details });

  it('preserves an existing MCP error', () => {
    const error = new McpExecutionError('env_not_found', 'missing');
    expect(mapEnvironmentOperationError(error)).toBe(error);
  });

  it('maps override domain errors with sanitized service choices', () => {
    expect(
      mapEnvironmentOperationError(new ServiceOverrideNotFoundError('api'), {
        validServices: ['zeta', 'alpha', 'alpha', ''],
      })
    ).toMatchObject({
      code: 'service_not_found',
      details: { validServices: ['alpha', 'zeta'] },
    });
    expect(mapEnvironmentOperationError(new ServiceOverrideNotEditableError('api'))).toMatchObject({
      code: 'override_not_allowed',
    });
    expect(mapEnvironmentOperationError(new BuildUuidValidationError('bad UUID'))).toMatchObject({
      code: 'invalid_body',
      details: { issues: [{ path: '/', message: 'bad UUID' }] },
    });
  });

  it('maps unknown errors to the fail-closed internal error', () => {
    expect(mapEnvironmentOperationError(new Error('database detail'))).toMatchObject({
      code: 'internal_error',
      message: 'Lifecycle could not complete this environment request. Ask an administrator for help.',
    });
  });

  it.each(['invalid_body', 'invalid_repository', 'invalid_branch', 'invalid_name', 'bad_request'])(
    'maps %s to structured invalid_body issues',
    (code) => {
      expect(mapEnvironmentOperationError(appError(code, 'check this value'))).toMatchObject({
        code: 'invalid_body',
        details: { issues: [{ path: '/', message: 'check this value' }] },
      });
    }
  );

  it('sanitizes ambiguous environment choices and fails closed when none are valid', () => {
    expect(
      mapEnvironmentOperationError(appError('env_ambiguous'), {
        ambiguousEnvironments: [
          { environmentConfigId: 2, name: ' staging ', isDefault: true },
          { environmentConfigId: 1, name: 'preview', isDefault: false },
          { environmentConfigId: 0, name: 'invalid', isDefault: false },
          { environmentConfigId: 3, name: '', isDefault: false },
        ],
      })
    ).toMatchObject({
      code: 'env_ambiguous',
      details: {
        environments: [
          { environmentConfigId: 2, name: ' staging ', isDefault: true },
          { environmentConfigId: 1, name: 'preview', isDefault: false },
        ],
      },
    });
    expect(mapEnvironmentOperationError(appError('env_ambiguous'))).toMatchObject({ code: 'internal_error' });
  });

  it('maps service-not-found AppErrors with safe unique services', () => {
    expect(
      mapEnvironmentOperationError(appError('service_not_found'), {
        validServices: ['zeta', 'alpha', 'alpha', ''],
      })
    ).toMatchObject({ code: 'service_not_found', details: { validServices: ['alpha', 'zeta'] } });
  });

  it('reports only valid expiry and replacement concurrency details', () => {
    expect(
      mapEnvironmentOperationError(
        appError('expiry_conflict', 'changed', { currentExpiresAt: '2026-04-24T12:00:00.000Z' })
      )
    ).toMatchObject({
      code: 'expiry_conflict',
      details: { currentExpiresAt: '2026-04-24T12:00:00.000Z' },
    });
    expect(mapEnvironmentOperationError(appError('expiry_conflict', 'changed', {}))).toMatchObject({
      code: 'internal_error',
    });
    expect(
      mapEnvironmentOperationError(appError('environment_replaced', 'changed', { replacementExists: false }))
    ).toMatchObject({ code: 'environment_replaced', details: { replacementExists: false } });
    expect(mapEnvironmentOperationError(appError('environment_replaced', 'changed', {}))).toMatchObject({
      code: 'internal_error',
    });
  });

  it('maps detail-free operation codes and rejects unknown AppError codes', () => {
    expect(mapEnvironmentOperationError(appError('env_not_found'))).toMatchObject({ code: 'env_not_found' });
    expect(mapEnvironmentOperationError(appError('deploy_disabled'))).toMatchObject({ code: 'deploy_disabled' });
    expect(mapEnvironmentOperationError(appError('unknown_operation_code'))).toMatchObject({ code: 'internal_error' });
  });
});
