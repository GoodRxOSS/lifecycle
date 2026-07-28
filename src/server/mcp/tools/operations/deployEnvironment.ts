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
import { buildLifecycleUiEnvironmentUrl } from '../core/environmentUrl';
import { deployEnvironmentInputSchema, deployEnvironmentOutputSchema } from './schemas';
import { BuildKind } from 'shared/constants';
import {
  annotateEnvironment,
  assertAuthorizedEnvironmentTarget,
  mapEnvironmentOperationError,
  type ResolvedEnvironmentOperationToolDependencies,
} from './shared';

const DESCRIPTION =
  "Queues a deploy of all active services. The run re-resolves sources when it starts, so it uses each branch's latest commit or its pinned sha. The receipt includes the deployId while rollout continues in the background; report the receipt and use get_environment later when the user asks for current state. Each call starts another deploy run, so check the environment after a lost response and do not duplicate a redeploy already queued by configure_environment.";

export function createDeployEnvironmentToolDefinition(
  dependencies: ResolvedEnvironmentOperationToolDependencies
): McpToolDefinition {
  return {
    name: 'deploy_environment',
    title: 'Deploy environment',
    description: DESCRIPTION,
    inputSchema: deployEnvironmentInputSchema,
    outputSchema: deployEnvironmentOutputSchema,
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
      try {
        const loaded = await dependencies.loadNamedEnvironment(uuid);
        assertAuthorizedEnvironmentTarget(loaded, environmentId);
        annotateEnvironment(context, loaded.build);
        const result = await dependencies.service().redeployBuild(uuid, environmentId, BuildKind.ENVIRONMENT);
        if (result.status !== 'success') {
          if (result.status === 'not_found') {
            throw new McpExecutionError('env_not_found', 'That environment was not found.');
          }
          if (result.status === 'tearing_down') {
            throw new McpExecutionError('env_tearing_down', 'This environment is tearing down and cannot be deployed.');
          }
          throw new McpExecutionError(
            'deploy_disabled',
            'Deploys are disabled. Call configure_environment with patch.deployEnabled set to true, then call deploy_environment again.'
          );
        }
        if (!/^[A-Za-z0-9_-]{10,30}$/.test(result.deployId)) {
          throw new Error('Deploy service returned an invalid deploy identity');
        }

        annotateEnvironment(context, loaded.build, {
          deployId: result.deployId,
        });
        const lifecycleUiUrl = buildLifecycleUiEnvironmentUrl(uuid);
        const lifecycleUiNext = lifecycleUiUrl
          ? ' Show lifecycleUiUrl to the user so they can open Lifecycle and follow the environment status.'
          : '';
        return {
          uuid,
          environmentId,
          queued: true,
          deployId: result.deployId,
          ...(lifecycleUiUrl ? { lifecycleUiUrl } : {}),
          next: `Deploy ${result.deployId} was queued and continues in the background. Report this receipt now. Use get_environment with uuid ${uuid} later when the user asks for current state. Do not call deploy_environment again for this run.${lifecycleUiNext}`,
        };
      } catch (error) {
        throw mapEnvironmentOperationError(error);
      }
    },
  };
}
