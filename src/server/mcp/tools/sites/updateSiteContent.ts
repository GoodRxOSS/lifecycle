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
import { updateSiteContentInputSchema, updateSiteContentOutputSchema } from './schemas';
import { mapSiteServiceError, singleFileUpload, siteChangeSummary, type ResolvedSiteToolDependencies } from './shared';

const DESCRIPTION =
  'Replaces the content of a hosted site you own with one text file; the id and URL stay the same. Use this, not create_site, to revise a published page. ZIP archives, multiple files, and binary files are not supported. Pass expectedContentRevision from get_site to avoid overwriting a newer change.';

export function createUpdateSiteContentToolDefinition(dependencies: ResolvedSiteToolDependencies): McpToolDefinition {
  return {
    name: 'update_site_content',
    title: 'Update site content',
    description: DESCRIPTION,
    inputSchema: updateSiteContentInputSchema,
    outputSchema: updateSiteContentOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'manage-hosted-sites',
    access: 'change',
    async handler(input, context): Promise<McpJsonObject> {
      try {
        const upload = singleFileUpload(
          input.content as string,
          (input.filename as string | undefined) ?? 'index.html'
        );
        const site = await dependencies.service().replaceSiteContent(input.siteId as string, {
          ...upload,
          principal: context.principal,
          ...(typeof input.expectedContentRevision === 'number'
            ? { expectedContentRevision: input.expectedContentRevision }
            : {}),
        });
        return { site: siteChangeSummary(site) };
      } catch (error) {
        throw mapSiteServiceError(error, '/content');
      }
    },
  };
}
