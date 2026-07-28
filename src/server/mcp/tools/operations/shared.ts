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
import { isAppError } from 'server/lib/appError';
import type { Principal } from 'server/lib/principal';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import Repository from 'server/models/Repository';
import BuildService from 'server/services/build';
import { BuildKind } from 'shared/constants';
import OverrideService, {
  BuildUuidValidationError,
  ServiceOverrideNotEditableError,
  ServiceOverrideNotFoundError,
} from 'server/services/override';
import type { McpJsonObject, McpToolContext } from '../../contracts';
import { normalizeMcpDateTime } from '../../dateTime';
import { McpExecutionError, type McpExecutionErrorCode } from '../../errors';
import {
  resolveNamedEnvironmentRead,
  resolveNamedEnvironmentReadDependencies,
  type GetEnvironmentToolDependencies,
  type LoadedEnvironment,
  type NamedEnvironmentReadDependencies,
} from '../core/getEnvironment';
import { defaultListRepositoryEnvironments, safeCoreText } from '../core/listRepositories';

export type EnvironmentOperationService = Pick<
  BuildService,
  | 'createApiEnvironment'
  | 'applyApiEnvironmentPatch'
  | 'redeployBuild'
  | 'extendApiEnvironment'
  | 'requestApiEnvironmentDeletion'
>;

export interface EnvironmentChoice {
  environmentConfigId: number;
  name: string;
  isDefault: boolean;
}

export interface EnvironmentDestroySnapshot {
  build: Build;
  activeServiceNames: string[];
}

export interface EnvironmentOperationToolDependencies {
  service?: EnvironmentOperationService;
  override?: OverrideService;
  environmentRead?: GetEnvironmentToolDependencies;
  loadNamedEnvironment?: (uuid: string) => Promise<LoadedEnvironment>;
  listEnvironmentChoices?: (repository: string) => Promise<EnvironmentChoice[]>;
  lockDestroyPreview?: (uuid: string, environmentId: number) => Promise<EnvironmentDestroySnapshot>;
  snapshotLockedDestroyState?: (build: Build, trx: Transaction) => Promise<EnvironmentDestroySnapshot>;
  nowSeconds?: () => number;
}

export interface ResolvedEnvironmentOperationToolDependencies {
  service: () => EnvironmentOperationService;
  override: () => OverrideService;
  loadNamedEnvironment: (uuid: string) => Promise<LoadedEnvironment>;
  listEnvironmentChoices: (repository: string) => Promise<EnvironmentChoice[]>;
  lockDestroyPreview: (uuid: string, environmentId: number) => Promise<EnvironmentDestroySnapshot>;
  snapshotLockedDestroyState: (build: Build, trx: Transaction) => Promise<EnvironmentDestroySnapshot>;
  nowSeconds: () => number;
}

function uniqueServiceNames(build: Build): string[] {
  return [
    ...new Set(
      (build.deploys ?? [])
        .filter((deploy) => deploy.active === true)
        .map((deploy) => safeCoreText(deploy.deployable?.name, 100))
        .filter(Boolean)
    ),
  ]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 100);
}

async function defaultSnapshotLockedDestroyState(build: Build, trx: Transaction): Promise<EnvironmentDestroySnapshot> {
  const deploys = await Deploy.query(trx)
    .where({ buildId: build.id, active: true })
    .withGraphFetched('deployable')
    .modifyGraph('deployable', (builder) => {
      builder.select('name');
    });
  build.deploys = deploys;
  return { build, activeServiceNames: uniqueServiceNames(build) };
}

async function defaultListEnvironmentChoices(repositoryName: string): Promise<EnvironmentChoice[]> {
  const repository = await Repository.query()
    .whereRaw('lower("fullName") = ?', [repositoryName.trim().toLowerCase()])
    .whereNull('deletedAt')
    .first();
  if (!repository) return [];

  return (await defaultListRepositoryEnvironments(repository)).slice(0, 50);
}

export function resolveEnvironmentOperationToolDependencies(
  dependencies: EnvironmentOperationToolDependencies = {}
): ResolvedEnvironmentOperationToolDependencies {
  let defaultService: BuildService | undefined;
  let defaultOverride: OverrideService | undefined;
  const service = () => dependencies.service ?? (defaultService ??= new BuildService());
  const override = () => dependencies.override ?? (defaultOverride ??= new OverrideService());
  const readDependencies: NamedEnvironmentReadDependencies = resolveNamedEnvironmentReadDependencies(
    dependencies.environmentRead
  );
  const snapshotLockedDestroyState = dependencies.snapshotLockedDestroyState ?? defaultSnapshotLockedDestroyState;

  return {
    service,
    override,
    loadNamedEnvironment:
      dependencies.loadNamedEnvironment ?? ((uuid) => resolveNamedEnvironmentRead(uuid, readDependencies)),
    listEnvironmentChoices: dependencies.listEnvironmentChoices ?? defaultListEnvironmentChoices,
    lockDestroyPreview:
      dependencies.lockDestroyPreview ??
      ((uuid, environmentId) =>
        Build.transact(async (trx) => {
          const build = await Build.query(trx)
            .findOne({ id: environmentId, uuid, kind: BuildKind.ENVIRONMENT })
            .whereNull('deletedAt')
            .forUpdate();
          if (!build) {
            throw new McpExecutionError('env_not_found', 'That environment was not found.');
          }
          return snapshotLockedDestroyState(build, trx);
        })),
    snapshotLockedDestroyState,
    nowSeconds: dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
  };
}

export function principalEnvironmentCreateFields(
  principal: Principal
): Pick<Parameters<BuildService['createApiEnvironment']>[0], 'createdBy' | 'createdByUserId' | 'createdByGithubLogin'> {
  return {
    createdBy: principal.actor,
    createdByUserId: principal.userId,
    createdByGithubLogin: principal.identity?.githubUsername ?? null,
  };
}

/** Binds the name read to the exact immutable Build row; target binding, not authorization. */
export function assertAuthorizedEnvironmentTarget(loaded: LoadedEnvironment, environmentId: number): void {
  if (loaded.build.kind !== BuildKind.ENVIRONMENT) {
    throw new McpExecutionError('env_not_found', 'That environment was not found.');
  }
  if (Number(loaded.build.id) !== Number(environmentId)) {
    throw new McpExecutionError(
      'environment_replaced',
      'The environment you knew was destroyed or replaced. Re-read the environment and review it before acting.',
      { details: { replacementExists: true } }
    );
  }
}

export function requiredEnvironmentNamespace(build: Build): string {
  const namespace = safeCoreText(build.namespace, 253);
  if (!namespace) {
    throw new McpExecutionError(
      'internal_error',
      'Lifecycle could not verify this environment namespace. Ask an administrator for help.'
    );
  }
  return namespace;
}

export function requiredEnvironmentExpiry(build: Build): string {
  const expiresAt = normalizeMcpDateTime(build.expiresAt);
  if (!expiresAt) {
    throw new McpExecutionError(
      'internal_error',
      'Lifecycle could not verify this environment expiry. Ask an administrator for help.'
    );
  }
  return expiresAt;
}

export function validEnvironmentServiceNames(build: Build): string[] {
  return [...new Set((build.deploys ?? []).map((deploy) => safeCoreText(deploy.deployable?.name, 100)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 100);
}

export function annotateEnvironment(
  context: McpToolContext,
  build: Build,
  fields: {
    deployId?: string;
    operation?: 'preview' | 'execute';
  } = {}
): void {
  context.audit.annotate({
    uuid: build.uuid,
    environmentId: Number(build.id),
    ...(fields.deployId ? { deployId: fields.deployId } : {}),
    ...(fields.operation ? { operation: fields.operation } : {}),
  });
}

export function assertEnvironmentDestroyable(build: Build): void {
  if (build.isStatic) {
    throw new McpExecutionError('env_static_protected', 'Static environments cannot be destroyed.');
  }
  if (build.triggerType !== 'api') {
    throw new McpExecutionError(
      'env_pr_protected',
      'This environment is managed by its pull request. Close the pull request or remove its deploy label to tear it down.'
    );
  }
}

export function environmentDestroyConfirmationState(snapshot: EnvironmentDestroySnapshot): McpJsonObject {
  return {
    status: safeCoreText(snapshot.build.status, 100),
    activeServiceNames: [...snapshot.activeServiceNames]
      .map((name) => safeCoreText(name, 100))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 100),
    expiresAt: snapshot.build.expiresAt ? requiredEnvironmentExpiry(snapshot.build) : null,
  };
}

export function invalidEnvironmentConfirmation(): McpExecutionError {
  return new McpExecutionError(
    'confirm_token_invalid',
    'The environment changed since this destruction preview. Start over and review the current environment before continuing.'
  );
}

const DETAIL_FREE_OPERATION_CODES = new Set<McpExecutionErrorCode>([
  'forbidden_repository',
  'api_environments_disabled',
  'repo_not_onboarded',
  'env_not_found',
  'name_conflict',
  'idempotency_conflict',
  'env_tearing_down',
  'deploy_disabled',
  'env_static_protected',
  'env_pr_protected',
  'pr_environment_not_extendable',
  'config_invalid',
  'auto_track_pinned_source',
  'invalid_field_for_trigger',
  'override_not_allowed',
]);

function operationMessage(error: unknown): string {
  return safeCoreText(
    error instanceof Error && error.message ? error.message : 'Lifecycle could not complete this environment request.',
    500
  );
}

function invalidBodyFromError(error: unknown): McpExecutionError {
  return new McpExecutionError('invalid_body', 'Check the tool arguments and try again.', {
    details: {
      issues: [
        {
          path: '/',
          message: operationMessage(error) || 'The environment request is invalid.',
        },
      ],
    },
  });
}

function validEnvironmentReplacementDetails(details: Record<string, unknown> | undefined): McpJsonObject | null {
  if (typeof details?.replacementExists !== 'boolean') return null;
  return { replacementExists: details.replacementExists };
}

export function mapEnvironmentOperationError(
  error: unknown,
  options: {
    validServices?: string[];
    ambiguousEnvironments?: EnvironmentChoice[];
  } = {}
): McpExecutionError {
  if (error instanceof McpExecutionError) return error;

  if (error instanceof ServiceOverrideNotFoundError) {
    return new McpExecutionError('service_not_found', operationMessage(error), {
      details: {
        validServices: [
          ...new Set((options.validServices ?? []).map((name) => safeCoreText(name, 100)).filter(Boolean)),
        ]
          .sort((left, right) => left.localeCompare(right))
          .slice(0, 100),
      },
    });
  }
  if (error instanceof ServiceOverrideNotEditableError) {
    return new McpExecutionError('override_not_allowed', operationMessage(error));
  }
  if (error instanceof BuildUuidValidationError) {
    return invalidBodyFromError(error);
  }
  if (!isAppError(error)) {
    return new McpExecutionError(
      'internal_error',
      'Lifecycle could not complete this environment request. Ask an administrator for help.'
    );
  }

  if (
    error.code === 'invalid_body' ||
    error.code === 'invalid_repository' ||
    error.code === 'invalid_branch' ||
    error.code === 'invalid_name' ||
    error.code === 'bad_request'
  ) {
    return invalidBodyFromError(error);
  }

  if (error.code === 'env_ambiguous') {
    const environments = (options.ambiguousEnvironments ?? [])
      .map((environment) => ({
        environmentConfigId: Number(environment.environmentConfigId),
        name: safeCoreText(environment.name, 100),
        isDefault: environment.isDefault === true,
      }))
      .filter(
        (environment) =>
          Number.isSafeInteger(environment.environmentConfigId) &&
          environment.environmentConfigId > 0 &&
          environment.name.length > 0
      )
      .slice(0, 50);
    if (environments.length === 0) {
      return new McpExecutionError(
        'internal_error',
        'Lifecycle could not list the configured environments for this repository. Ask an administrator for help.'
      );
    }
    return new McpExecutionError('env_ambiguous', operationMessage(error), {
      details: { environments },
    });
  }

  if (error.code === 'service_not_found') {
    return new McpExecutionError('service_not_found', operationMessage(error), {
      details: {
        validServices: [...new Set(options.validServices ?? [])]
          .map((name) => safeCoreText(name, 100))
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right))
          .slice(0, 100),
      },
    });
  }

  if (error.code === 'expiry_conflict') {
    const currentExpiresAt = normalizeMcpDateTime(error.details?.currentExpiresAt);
    if (!currentExpiresAt) {
      return new McpExecutionError(
        'internal_error',
        'Lifecycle could not report the current environment expiry. Ask an administrator for help.'
      );
    }
    return new McpExecutionError('expiry_conflict', operationMessage(error), {
      details: {
        currentExpiresAt,
      },
    });
  }

  if (error.code === 'environment_replaced') {
    const details = validEnvironmentReplacementDetails(error.details);
    if (!details) {
      return new McpExecutionError(
        'internal_error',
        'Lifecycle could not verify the current environment. Ask an administrator for help.'
      );
    }
    return new McpExecutionError('environment_replaced', operationMessage(error), { details });
  }

  if (error.code === 'env_not_found') {
    return new McpExecutionError('env_not_found', operationMessage(error));
  }

  if (DETAIL_FREE_OPERATION_CODES.has(error.code as McpExecutionErrorCode)) {
    return new McpExecutionError(error.code as McpExecutionErrorCode, operationMessage(error));
  }

  return new McpExecutionError(
    'internal_error',
    'Lifecycle could not complete this environment request. Ask an administrator for help.'
  );
}
