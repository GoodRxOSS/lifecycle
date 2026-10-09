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
import { setSiteVisibilityInputSchema, setSiteVisibilityOutputSchema } from './schemas';
import { mapSiteServiceError, siteChangeSummary, type ResolvedSiteToolDependencies } from './shared';

const DESCRIPTION =
  'Makes a site you own private (only you can open it) or public (anyone with the link). Pass accessRevision from get_site as expectedAccessRevision. If acting for someone, get approval before making it public.';

export function createSetSiteVisibilityToolDefinition(dependencies: ResolvedSiteToolDependencies): McpToolDefinition {
  return {
    name: 'set_site_visibility',
    title: 'Set site visibility',
    description: DESCRIPTION,
    inputSchema: setSiteVisibilityInputSchema,
    outputSchema: setSiteVisibilityOutputSchema,
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
          .setVisibility(
            input.siteId as string,
            input.visibility as 'private' | 'public',
            context.principal,
            input.expectedAccessRevision as number
          );
        return { site: siteChangeSummary(site) };
      } catch (error) {
        throw mapSiteServiceError(error);
      }
    },
  };
}
