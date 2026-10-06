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
import { deleteSiteInputSchema, deleteSiteOutputSchema } from './schemas';
import { mapSiteServiceError, siteChangeSummary, type ResolvedSiteToolDependencies } from './shared';

const DESCRIPTION =
  'Permanently deletes a hosted site you own; the link stops working and cannot be restored. Call get_site first, confirm with the user if acting for someone, and pass its accessRevision as expectedAccessRevision.';

export function createDeleteSiteToolDefinition(dependencies: ResolvedSiteToolDependencies): McpToolDefinition {
  return {
    name: 'delete_site',
    title: 'Delete site',
    description: DESCRIPTION,
    inputSchema: deleteSiteInputSchema,
    outputSchema: deleteSiteOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    capabilityId: 'manage-hosted-sites',
    access: 'change',
    async handler(input, context): Promise<McpJsonObject> {
      try {
        const site = await dependencies
          .service()
          .deleteSite(input.siteId as string, context.principal, input.expectedAccessRevision as number);
        return { site: siteChangeSummary(site) };
      } catch (error) {
        throw mapSiteServiceError(error);
      }
    },
  };
}
