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
import { getSiteInputSchema, getSiteOutputSchema } from './schemas';
import { mapSiteServiceError, siteSummary, type ResolvedSiteToolDependencies } from './shared';

const DESCRIPTION =
  'Gets one hosted site, including its public URL, status, size, and expiry. Use a `siteId` returned by list_sites.';

export function createGetSiteToolDefinition(dependencies: ResolvedSiteToolDependencies): McpToolDefinition {
  return {
    name: 'get_site',
    title: 'Get site',
    description: DESCRIPTION,
    inputSchema: getSiteInputSchema,
    outputSchema: getSiteOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'view-hosted-sites',
    access: 'read',
    async handler(input): Promise<McpJsonObject> {
      try {
        const site = await dependencies.service().getSite(input.siteId as string);
        return {
          site: siteSummary(site),
        };
      } catch (error) {
        throw mapSiteServiceError(error);
      }
    },
  };
}
