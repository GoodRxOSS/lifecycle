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
import { McpExecutionError } from '../../errors';
import { serializeEnvironmentState } from '../core/getEnvironment';
import { CONFIGURE_APPLIED_NEXT, configureEnvironmentInputSchema, configureEnvironmentOutputSchema } from './schemas';
import {
  annotateEnvironment,
  assertAuthorizedEnvironmentTarget,
  mapEnvironmentOperationError,
  validEnvironmentServiceNames,
  type ResolvedEnvironmentOperationToolDependencies,
} from './shared';

const DESCRIPTION =
  "Changes an environment's services, variables, or toggles. Variables update by key: a string value sets that key, null removes it, and keys you do not mention are left alone. Variable values are never returned by any tool; use get_environment with format detailed to see which keys exist. Do not put secrets in variable values; they are stored as plain text. If deploys were already enabled and the configuration changed, the receipt identifies the automatically queued redeploy while it continues in the background; report the receipt and use get_environment later when the user asks for current state. Re-enabling a paused environment only saves the changes: call deploy_environment when you want to deploy. Calling this twice with the same deploy-triggering changes can queue two redeploys, so check the receipt before retrying. If another person or job might be editing the same environment, read it first; the last write wins.";

type EnvironmentPatch = {
  services?: {
    name: string;
    active?: boolean;
    branchOrExternalUrl?: string;
  }[];
  env?: Record<string, string | null>;
  initEnv?: Record<string, string | null>;
  deployEnabled?: boolean;
  autoTrack?: boolean;
  trackDefaultBranches?: boolean;
};

function assertServiceOverridesHaveAChange(patch: EnvironmentPatch): void {
  const invalidIndex = patch.services?.findIndex(
    (service) => service.active === undefined && service.branchOrExternalUrl === undefined
  );
  if (invalidIndex === undefined || invalidIndex < 0) return;
  throw new McpExecutionError('invalid_body', 'Check the tool arguments and try again.', {
    details: {
      issues: [
        {
          path: `/patch/services/${invalidIndex}`,
          message: 'Set active or branchOrExternalUrl for each service override.',
        },
      ],
    },
  });
}

export function createConfigureEnvironmentToolDefinition(
  dependencies: ResolvedEnvironmentOperationToolDependencies
): McpToolDefinition {
  return {
    name: 'configure_environment',
    title: 'Configure environment',
    description: DESCRIPTION,
    inputSchema: configureEnvironmentInputSchema,
    outputSchema: configureEnvironmentOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    capabilityId: 'manage-environments',
    access: 'change',
    async handler(input, context): Promise<McpJsonObject> {
      const uuid = input.uuid as string;
      const environmentId = input.environmentId as number;
      let validServices: string[] = [];
      try {
        const patch = input.patch as unknown as EnvironmentPatch;
        assertServiceOverridesHaveAChange(patch);
        const loaded = await dependencies.loadNamedEnvironment(uuid);
        assertAuthorizedEnvironmentTarget(loaded, environmentId);
        validServices = validEnvironmentServiceNames(loaded.build);
        annotateEnvironment(context, loaded.build);

        const result = await dependencies
          .service()
          .applyApiEnvironmentPatch(loaded.build, dependencies.override(), patch, {
            envMode: 'merge',
          });

        assertAuthorizedEnvironmentTarget({ ...loaded, build: result.build }, environmentId);
        annotateEnvironment(context, result.build, {
          ...(result.mode === 'redeploy_queued' ? { deployId: result.deployId } : {}),
        });
        const environment = serializeEnvironmentState({ ...loaded, build: result.build }, { format: 'concise' });

        return {
          uuid,
          environmentId,
          applied: true,
          environment,
          result:
            result.mode === 'redeploy_queued'
              ? {
                  mode: 'redeploy_queued',
                  deployId: result.deployId,
                  next: `Redeploy ${result.deployId} was queued and continues in the background. Report this receipt now. Use get_environment with uuid ${uuid} later when the user asks for current state. Do not also call deploy_environment for this change.`,
                }
              : {
                  mode: 'applied',
                  next: CONFIGURE_APPLIED_NEXT,
                },
        };
      } catch (error) {
        throw mapEnvironmentOperationError(error, { validServices });
      }
    },
  };
}
