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

import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import { DESTROY_CONFIRMATION_TOKEN_PREFIX } from '../../security/destroyConfirmation';
import { lifecycleUiUrlSchema } from '../core/environmentUrl';
import { conciseEnvironmentSchema } from '../core/getEnvironment';

export const ENVIRONMENT_UUID_DESCRIPTION =
  'Environment uuid, like cute-mouse-123456. Returned by create_environment, list_environments, and get_environment.';

export const ENVIRONMENT_ID_DESCRIPTION =
  'Immutable Lifecycle environment id returned by create_environment, list_environments, or get_environment.';

export const DESTROY_PREVIEW_NEXT =
  'Call destroy_environment again with the same uuid and environmentId, confirmation phase execute, and this confirmToken. If you are acting for a person, get their explicit confirmation first.';

export const DESTROY_CONSEQUENCES_PREFIX = 'All services stop and their resources are deleted.';
export const DESTROY_IRREVERSIBLE_CONSEQUENCE = 'This cannot be undone.';
export const EXTEND_MAX_NEXT =
  'No time was removed. The current lifetime is at or above the configured cap, so it cannot be extended further right now.';
export const CONFIGURE_APPLIED_NEXT =
  'The requested state is saved, but this call did not queue a deploy. If the running workload may predate these settings, including after retrying a failed configure call, call deploy_environment.';

import { BUILD_STATUSES } from '../statusValues';
export { BUILD_STATUSES };

export const environmentUuidSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 63,
  description: ENVIRONMENT_UUID_DESCRIPTION,
} as const;

export const environmentIdSchema = {
  type: 'integer',
  minimum: 1,
  description: ENVIRONMENT_ID_DESCRIPTION,
} as const;

export const deployIdSchema = {
  type: 'string',
  minLength: 10,
  maxLength: 30,
} as const;

export const serviceOverrideSchema = closedObjectSchema(
  {
    name: { type: 'string', maxLength: 100 },
    active: { type: 'boolean' },
    branchOrExternalUrl: { type: 'string', maxLength: 500 },
  },
  ['name']
);

const createVariableMapSchema = {
  type: 'object',
  maxProperties: 100,
  additionalProperties: { type: 'string', maxLength: 4096 },
} as const;

const patchVariableMapSchema = {
  type: 'object',
  maxProperties: 100,
  additionalProperties: { type: ['string', 'null'], maxLength: 4096 },
} as const;

const createServicesSchema = {
  type: 'array',
  maxItems: 20,
  items: serviceOverrideSchema,
} as const;

export const createEnvironmentInputSchema = closedObjectSchema(
  {
    repository: {
      type: 'string',
      maxLength: 140,
      pattern: '^[^/]+/[^/]+$',
    },
    branch: { type: 'string', minLength: 1, maxLength: 255 },
    idempotencyKey: {
      type: 'string',
      minLength: 8,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._-]+$',
      description:
        'Stable key for this one intended environment. Reuse it after a lost response; use a new key for a genuinely new environment.',
    },
    sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 63,
      pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$',
    },
    environmentConfigId: {
      type: 'integer',
      minimum: 1,
      description: 'Reusable Lifecycle environment configuration to use instead of the repository default.',
    },
    services: createServicesSchema,
    env: createVariableMapSchema,
    initEnv: createVariableMapSchema,
    deployEnabled: { type: 'boolean' },
    autoTrack: { type: 'boolean' },
    trackDefaultBranches: { type: 'boolean' },
    ttlHours: { type: 'integer', minimum: 1, maximum: 8760 },
  },
  ['repository', 'branch', 'idempotencyKey']
);

export const createEnvironmentOutputSchema = successObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    status: { type: 'string', enum: BUILD_STATUSES },
    replayed: { type: 'boolean' },
    namespace: { type: 'string', minLength: 1, maxLength: 253 },
    expiresAt: { type: 'string', format: 'date-time' },
    lifecycleUiUrl: lifecycleUiUrlSchema,
    next: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  ['uuid', 'environmentId', 'status', 'replayed', 'namespace', 'expiresAt', 'next']
);

const environmentPatchSchema = closedObjectSchema({
  services: createServicesSchema,
  env: patchVariableMapSchema,
  initEnv: patchVariableMapSchema,
  deployEnabled: { type: 'boolean' },
  autoTrack: { type: 'boolean' },
  trackDefaultBranches: { type: 'boolean' },
});
(environmentPatchSchema as { minProperties?: number }).minProperties = 1;

export const configureEnvironmentInputSchema = closedObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    patch: environmentPatchSchema,
  },
  ['uuid', 'environmentId', 'patch']
);

const configureQueuedResultSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'redeploy_queued' },
    deployId: deployIdSchema,
    next: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  ['mode', 'deployId', 'next']
);

const configureAppliedResultSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'applied' },
    next: {
      type: 'string',
      const: CONFIGURE_APPLIED_NEXT,
    },
  },
  ['mode', 'next']
);

export const configureEnvironmentOutputSchema = successObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    applied: { type: 'boolean', const: true },
    environment: conciseEnvironmentSchema,
    result: { oneOf: [configureQueuedResultSchema, configureAppliedResultSchema] },
  },
  ['uuid', 'environmentId', 'applied', 'environment', 'result']
);

export const deployEnvironmentInputSchema = closedObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
  },
  ['uuid', 'environmentId']
);

export const deployEnvironmentOutputSchema = successObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    queued: { type: 'boolean', const: true },
    deployId: deployIdSchema,
    lifecycleUiUrl: lifecycleUiUrlSchema,
    next: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  ['uuid', 'environmentId', 'queued', 'deployId', 'next']
);

export const extendEnvironmentInputSchema = closedObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    hours: { type: 'integer', minimum: 1, maximum: 8760 },
    ifExpiresAt: {
      type: 'string',
      format: 'date-time',
      description: 'Expiry value from the environment state you last read.',
    },
  },
  ['uuid', 'environmentId']
);

export const extendEnvironmentOutputSchema = successObjectSchema(
  {
    uuid: environmentUuidSchema,
    expiresAt: { type: 'string', format: 'date-time' },
    addedHours: {
      type: 'integer',
      minimum: 0,
      description: 'Whole hours actually added.',
    },
    maxReached: { type: 'boolean' },
    next: { type: 'string', const: EXTEND_MAX_NEXT },
  },
  ['uuid', 'expiresAt', 'addedHours', 'maxReached']
);

const destroyPreviewInputSchema = closedObjectSchema(
  {
    phase: { type: 'string', const: 'preview' },
  },
  ['phase']
);

const destroyExecuteInputSchema = closedObjectSchema(
  {
    phase: { type: 'string', const: 'execute' },
    confirmToken: {
      type: 'string',
      minLength: 20,
      maxLength: 1024,
    },
  },
  ['phase', 'confirmToken']
);

export const destroyEnvironmentInputSchema = closedObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    confirmation: {
      oneOf: [destroyPreviewInputSchema, destroyExecuteInputSchema],
    },
  },
  ['uuid', 'environmentId', 'confirmation']
);

const destroyPreviewEnvironmentSchema = closedObjectSchema(
  {
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    repository: {
      type: 'string',
      maxLength: 140,
      pattern: '^[^/]+/[^/]+$',
    },
    branch: { type: 'string', minLength: 1, maxLength: 255 },
    status: { type: 'string', enum: BUILD_STATUSES },
    services: {
      type: 'array',
      minItems: 0,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
    isStatic: { type: 'boolean', const: false },
    author: { type: 'string', minLength: 1, maxLength: 255 },
    expiresAt: { type: 'string', format: 'date-time' },
  },
  ['uuid', 'environmentId', 'repository', 'branch', 'status', 'services', 'isStatic']
);

const destroyPreviewResultSchema = closedObjectSchema(
  {
    phase: { type: 'string', const: 'preview' },
    confirmationRequired: { type: 'boolean', const: true },
    environment: destroyPreviewEnvironmentSchema,
    consequences: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    confirmToken: {
      type: 'string',
      minLength: 20,
      maxLength: 1024,
      pattern: `^${DESTROY_CONFIRMATION_TOKEN_PREFIX}\\.`,
    },
    expiresInSeconds: { type: 'integer', const: 300 },
    next: { type: 'string', const: DESTROY_PREVIEW_NEXT },
  },
  ['phase', 'confirmationRequired', 'environment', 'consequences', 'confirmToken', 'expiresInSeconds', 'next']
);

const destroyExecuteResultSchema = closedObjectSchema(
  {
    phase: { type: 'string', const: 'execute' },
    uuid: environmentUuidSchema,
    environmentId: environmentIdSchema,
    status: { type: 'string', const: 'tearing_down_queued' },
    alreadyDestroying: { type: 'boolean' },
    next: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  ['phase', 'uuid', 'environmentId', 'status', 'alreadyDestroying', 'next']
);

export const destroyEnvironmentOutputSchema = successObjectSchema(
  {
    result: {
      oneOf: [destroyPreviewResultSchema, destroyExecuteResultSchema],
    },
  },
  ['result']
);
