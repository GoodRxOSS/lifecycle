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
import {
  confirmationStateMatches,
  confirmationStateHash,
  createDestroyConfirmation,
  DESTROY_CONFIRMATION_TTL_SECONDS,
  verifyDestroyConfirmation,
} from '../../security/destroyConfirmation';
import {
  DESTROY_CONSEQUENCES_PREFIX,
  DESTROY_IRREVERSIBLE_CONSEQUENCE,
  DESTROY_PREVIEW_NEXT,
  destroyEnvironmentInputSchema,
  destroyEnvironmentOutputSchema,
} from './schemas';
import {
  annotateEnvironment,
  assertAuthorizedEnvironmentTarget,
  assertEnvironmentDestroyable,
  environmentDestroyConfirmationState,
  invalidEnvironmentConfirmation,
  mapEnvironmentOperationError,
  requiredEnvironmentExpiry,
  type ResolvedEnvironmentOperationToolDependencies,
} from './shared';

const DESCRIPTION =
  'Destroys an API-created environment in two steps. First call with confirmation phase preview, review the returned summary, and get explicit approval if you are acting for someone. Then call with phase execute and the returned confirmation token. Execute returns a receipt while teardown continues in the background; report the receipt and use get_environment later when the user asks for current state. Destruction cannot be undone. Static and pull-request environments cannot be destroyed with this tool.';

type DestroyConfirmation = { phase: 'preview' } | { phase: 'execute'; confirmToken: string };

function executeNext(uuid: string, alreadyDestroying: boolean): string {
  const state = alreadyDestroying
    ? 'Teardown was already claimed and its queue entry was reasserted'
    : 'Teardown was queued';
  return `${state} and continues in the background. Report this receipt now. Use get_environment with uuid ${uuid} later when the user asks for current state.`;
}

function requiredBranch(value: string | null | undefined): string {
  if (!value) {
    throw new Error('Environment destruction preview is missing its branch');
  }
  return value;
}

export function createDestroyEnvironmentToolDefinition(
  dependencies: ResolvedEnvironmentOperationToolDependencies
): McpToolDefinition {
  return {
    name: 'destroy_environment',
    title: 'Destroy environment',
    description: DESCRIPTION,
    inputSchema: destroyEnvironmentInputSchema,
    outputSchema: destroyEnvironmentOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    capabilityId: 'manage-environments',
    access: 'change',
    async handler(input, context): Promise<McpJsonObject> {
      const uuid = input.uuid as string;
      const environmentId = input.environmentId as number;
      const confirmation = input.confirmation as unknown as DestroyConfirmation;
      try {
        const loaded = await dependencies.loadNamedEnvironment(uuid);
        assertAuthorizedEnvironmentTarget(loaded, environmentId);
        annotateEnvironment(context, loaded.build, {
          operation: confirmation.phase,
        });
        assertEnvironmentDestroyable(loaded.build);
        const userId = context.principal.userId;
        if (!userId) {
          throw new Error('OAuth principal is missing a Lifecycle user id');
        }

        if (confirmation.phase === 'preview') {
          const snapshot = await dependencies.lockDestroyPreview(uuid, environmentId);
          assertEnvironmentDestroyable(snapshot.build);
          const nowSeconds = dependencies.nowSeconds();
          const confirmToken = createDestroyConfirmation(
            {
              environmentId,
              userId,
              stateHash: confirmationStateHash(environmentDestroyConfirmationState(snapshot)),
            },
            nowSeconds
          );
          annotateEnvironment(context, snapshot.build, {
            operation: 'preview',
          });

          return {
            result: {
              phase: 'preview',
              confirmationRequired: true,
              environment: {
                uuid,
                environmentId,
                repository: loaded.repository.fullName,
                branch: requiredBranch(snapshot.build.branchName),
                status: snapshot.build.status,
                services: [...snapshot.activeServiceNames],
                isStatic: false,
                ...(snapshot.build.createdByGithubLogin ? { author: snapshot.build.createdByGithubLogin } : {}),
                ...(snapshot.build.expiresAt
                  ? {
                      expiresAt: requiredEnvironmentExpiry(snapshot.build),
                    }
                  : {}),
              },
              consequences: [
                DESTROY_CONSEQUENCES_PREFIX,
                `The name ${uuid} becomes available for reuse.`,
                DESTROY_IRREVERSIBLE_CONSEQUENCE,
              ],
              confirmToken,
              expiresInSeconds: DESTROY_CONFIRMATION_TTL_SECONDS,
              next: DESTROY_PREVIEW_NEXT,
            },
          };
        }

        const nowSeconds = dependencies.nowSeconds();
        const payload = verifyDestroyConfirmation(confirmation.confirmToken, { environmentId, userId }, nowSeconds);
        annotateEnvironment(context, loaded.build, {
          operation: 'execute',
        });

        let validatedForClaim = false;
        const destroyed = await dependencies.service().requestApiEnvironmentDeletion(uuid, environmentId, {
          rejectPullRequest: true,
          validateLockedState: async (locked, trx) => {
            const snapshot = await dependencies.snapshotLockedDestroyState(locked, trx);
            if (
              !confirmationStateMatches(
                payload.stateHash,
                confirmationStateHash(environmentDestroyConfirmationState(snapshot))
              )
            ) {
              throw invalidEnvironmentConfirmation();
            }
            validatedForClaim = true;
          },
        });
        const alreadyDestroying = !validatedForClaim;
        annotateEnvironment(context, destroyed, {
          operation: 'execute',
        });

        return {
          result: {
            phase: 'execute',
            uuid,
            environmentId,
            status: 'tearing_down_queued',
            alreadyDestroying,
            next: executeNext(uuid, alreadyDestroying),
          },
        };
      } catch (error) {
        throw mapEnvironmentOperationError(error);
      }
    },
  };
}
