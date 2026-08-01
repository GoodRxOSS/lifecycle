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
import { EXTEND_MAX_NEXT, extendEnvironmentInputSchema, extendEnvironmentOutputSchema } from './schemas';
import {
  annotateEnvironment,
  assertAuthorizedEnvironmentTarget,
  mapEnvironmentOperationError,
  requiredEnvironmentExpiry,
  type ResolvedEnvironmentOperationToolDependencies,
} from './shared';

const DESCRIPTION =
  "Adds time to an environment's lifetime. Each call adds `hours` (default: the configured extension) on top of the current expiry, up to the configured maximum from now. If an existing expiry is already above a newly lowered maximum, it is preserved and no time is added or removed. Calling twice adds time twice, up to the cap. If you want to be safe against double calls, pass `ifExpiresAt` with the expiry you last saw; the call is then rejected if someone extended in between. Environments created from pull requests cannot be extended.";

export function createExtendEnvironmentToolDefinition(
  dependencies: ResolvedEnvironmentOperationToolDependencies
): McpToolDefinition {
  return {
    name: 'extend_environment',
    title: 'Extend environment',
    description: DESCRIPTION,
    inputSchema: extendEnvironmentInputSchema,
    outputSchema: extendEnvironmentOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
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

        const extension = await dependencies
          .service()
          .extendApiEnvironment(uuid, input.hours === undefined ? undefined : (input.hours as number), environmentId, {
            ...(typeof input.ifExpiresAt === 'string' ? { ifExpiresAt: input.ifExpiresAt } : {}),
            rejectPullRequest: true,
          });
        assertAuthorizedEnvironmentTarget({ ...loaded, build: extension.build }, environmentId);
        const expiresAt = requiredEnvironmentExpiry(extension.build);

        annotateEnvironment(context, extension.build);
        return {
          uuid,
          expiresAt,
          addedHours: extension.addedHours,
          maxReached: extension.maxReached,
          ...(extension.maxReached ? { next: EXTEND_MAX_NEXT } : {}),
        };
      } catch (error) {
        throw mapEnvironmentOperationError(error);
      }
    },
  };
}
