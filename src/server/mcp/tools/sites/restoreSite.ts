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
import { restoreSiteInputSchema, restoreSiteOutputSchema } from './schemas';
import { mapSiteServiceError, siteChangeSummary, type ResolvedSiteToolDependencies } from './shared';

const DESCRIPTION =
  'Restores a site you deleted, at the same id and URL, until its restorableUntil. Find it with list_sites deleted and pass its accessRevision as expectedAccessRevision.';

export function createRestoreSiteToolDefinition(dependencies: ResolvedSiteToolDependencies): McpToolDefinition {
  return {
    name: 'restore_site',
    title: 'Restore site',
    description: DESCRIPTION,
    inputSchema: restoreSiteInputSchema,
    outputSchema: restoreSiteOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'manage-hosted-sites',
    access: 'change',
    async handler(input, context): Promise<McpJsonObject> {
      try {
        const site = await dependencies
          .service()
          .restoreSite(
            input.siteId as string,
            context.principal,
            typeof input.expectedAccessRevision === 'number' ? input.expectedAccessRevision : undefined
          );
        return { site: siteChangeSummary(site) };
      } catch (error) {
        throw mapSiteServiceError(error);
      }
    },
  };
}
