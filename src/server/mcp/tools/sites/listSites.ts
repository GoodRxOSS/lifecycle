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
import { decodeListCursor, encodeListCursor } from '../../state/listCursor';
import { listSitesInputSchema, listSitesOutputSchema } from './schemas';
import { mapSiteServiceError, siteSummary, type ResolvedSiteToolDependencies } from './shared';

const DESCRIPTION =
  'Lists hosted sites in Lifecycle. Use `mineOnly` to return only sites created or updated by the authenticated user.';

export function createListSitesToolDefinition(dependencies: ResolvedSiteToolDependencies): McpToolDefinition {
  return {
    name: 'list_sites',
    title: 'List sites',
    description: DESCRIPTION,
    inputSchema: listSitesInputSchema,
    outputSchema: listSitesOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'view-hosted-sites',
    access: 'read',
    async handler(input, context): Promise<McpJsonObject> {
      try {
        const mineOnly = input.mineOnly === true;
        const limit = typeof input.limit === 'number' ? input.limit : 25;
        const cursorFilters: McpJsonObject = { mineOnly };
        const cursor =
          typeof input.cursor === 'string'
            ? decodeListCursor(input.cursor, cursorFilters, limit, dependencies.nowSeconds())
            : null;
        const user = mineOnly ? context.principal.identity?.email : undefined;
        if (mineOnly && !user) {
          return { sites: [] };
        }
        const result = await dependencies.service().listSites({
          ...(user ? { user } : {}),
          page: cursor ? cursor.position + 1 : 1,
          limit,
        });
        const nextCursor =
          result.pagination.current < result.pagination.total
            ? encodeListCursor(
                {
                  position: result.pagination.current,
                  filters: cursorFilters,
                  limit,
                },
                dependencies.nowSeconds()
              )
            : undefined;

        return {
          sites: result.sites.map(siteSummary),
          ...(nextCursor ? { nextCursor } : {}),
        };
      } catch (error) {
        throw mapSiteServiceError(error);
      }
    },
  };
}
