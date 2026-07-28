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

import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { buildLifecycleUiEnvironmentUrl } from '../core/environmentUrl';
import { BUILD_STATUSES, createEnvironmentInputSchema, createEnvironmentOutputSchema } from './schemas';
import {
  annotateEnvironment,
  mapEnvironmentOperationError,
  principalEnvironmentCreateFields,
  requiredEnvironmentExpiry,
  requiredEnvironmentNamespace,
  type ResolvedEnvironmentOperationToolDependencies,
} from './shared';

const DESCRIPTION =
  'Creates a preview environment from a repository and branch, without a pull request. Returns an acceptance receipt immediately. When deploys are enabled, build and deploy work continues in the background; report the receipt and use get_environment later when the user asks for current state. Always pass an `idempotencyKey` for this one intended environment, and reuse the same key if you retry after a lost response. Derive the key from stable facts of the task (for example repo, branch, and your task or ticket id) rather than random characters, so a restarted run reuses it. The key stops protecting you once the environment is destroyed: replaying it after that creates a fresh environment. Do not put secrets in `env` or `initEnv`; values are stored and injected as plain text.';

type ServiceOverride = {
  name: string;
  active?: boolean;
  branchOrExternalUrl?: string;
};

function optional<T>(value: unknown): T | undefined {
  return value === undefined ? undefined : (value as T);
}

export function createCreateEnvironmentToolDefinition(
  dependencies: ResolvedEnvironmentOperationToolDependencies
): McpToolDefinition {
  return {
    name: 'create_environment',
    title: 'Create environment',
    description: DESCRIPTION,
    inputSchema: createEnvironmentInputSchema,
    outputSchema: createEnvironmentOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    capabilityId: 'manage-environments',
    access: 'change',
    async handler(input, context): Promise<McpJsonObject> {
      const repository = input.repository as string;
      try {
        // MCP change access is granted by the MCP settings alone, not the API-key environments toggle.
        const { build, replayed } = await dependencies.service().createApiEnvironment(
          {
            repositoryFullName: repository,
            branch: input.branch as string,
            idempotencyKey: input.idempotencyKey as string,
            ...principalEnvironmentCreateFields(context.principal),
            ...(input.sha === undefined ? {} : { sha: input.sha as string }),
            ...(input.name === undefined ? {} : { name: input.name as string }),
            ...(input.environmentConfigId === undefined ? {} : { environmentId: input.environmentConfigId as number }),
            ...(input.services === undefined
              ? {}
              : {
                  services: input.services as unknown as ServiceOverride[],
                }),
            ...(input.env === undefined
              ? {}
              : {
                  env: input.env as unknown as Record<string, string>,
                }),
            ...(input.initEnv === undefined
              ? {}
              : {
                  initEnv: input.initEnv as unknown as Record<string, string>,
                }),
            ...(input.deployEnabled === undefined
              ? {}
              : {
                  deployEnabled: input.deployEnabled as boolean,
                }),
            ...(input.autoTrack === undefined ? {} : { autoTrack: input.autoTrack as boolean }),
            ...(input.trackDefaultBranches === undefined
              ? {}
              : {
                  trackDefaultBranches: input.trackDefaultBranches as boolean,
                }),
            ...(input.ttlHours === undefined ? {} : { ttlHours: input.ttlHours as number }),
          },
          null,
          { requireApiEnvironmentsEnabled: false }
        );

        const environmentId = Number(build.id);
        if (!Number.isSafeInteger(environmentId) || environmentId < 1) {
          throw new Error('Create returned an invalid environment id');
        }
        const status = optional<string>(build.status);
        if (!status || !BUILD_STATUSES.includes(status as (typeof BUILD_STATUSES)[number])) {
          throw new Error('Create returned an unsupported build status');
        }
        annotateEnvironment(context, build);

        const paused = build.deployEnabled === false;
        const lifecycleUiUrl = buildLifecycleUiEnvironmentUrl(build.uuid);
        const lifecycleUiNext = lifecycleUiUrl
          ? ' Show lifecycleUiUrl to the user so they can open Lifecycle and follow the environment status.'
          : '';
        return {
          uuid: build.uuid,
          environmentId,
          status,
          replayed,
          namespace: requiredEnvironmentNamespace(build),
          expiresAt: requiredEnvironmentExpiry(build),
          ...(lifecycleUiUrl ? { lifecycleUiUrl } : {}),
          next: paused
            ? `The environment was created in a paused state, so no deploy was queued. Enable deploys with configure_environment and call deploy_environment when you want to start it. Use get_environment later when the user asks for current state.${lifecycleUiNext}`
            : `The environment request was accepted; any queued build and deploy work continues in the background. Report this receipt now. Use get_environment with uuid ${build.uuid} later when the user asks for current state.${lifecycleUiNext}`,
        };
      } catch (error) {
        const ambiguousEnvironments =
          (error as { code?: unknown })?.code === 'env_ambiguous'
            ? await dependencies.listEnvironmentChoices(repository).catch(() => [])
            : undefined;
        throw mapEnvironmentOperationError(error, {
          ...(ambiguousEnvironments ? { ambiguousEnvironments } : {}),
        });
      }
    },
  };
}
