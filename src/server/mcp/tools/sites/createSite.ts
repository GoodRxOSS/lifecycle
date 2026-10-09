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
import { createSiteInputSchema, createSiteOutputSchema } from './schemas';
import { mapSiteServiceError, singleFileUpload, siteChangeSummary, type ResolvedSiteToolDependencies } from './shared';

const DESCRIPTION =
  'Publishes one text file as a new hosted site and returns its URL. For anything people will read, send a complete self-contained HTML document (inline CSS and scripts); other types (.md, .txt, .json, .csv, .xml, .svg via `filename`) are served as-is, not rendered. ZIP archives, multiple files, and binary files are not supported. Sites are private unless `visibility` is public. To revise a site, use update_site_content so the URL stays the same. Report the url.';

export function createCreateSiteToolDefinition(dependencies: ResolvedSiteToolDependencies): McpToolDefinition {
  return {
    name: 'create_site',
    title: 'Create site',
    description: DESCRIPTION,
    inputSchema: createSiteInputSchema,
    outputSchema: createSiteOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
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
        const site = await dependencies.service().createSite({
          ...upload,
          name: (input.name as string | undefined) ?? null,
          visibility: (input.visibility as 'private' | 'public' | undefined) ?? 'private',
          principal: context.principal,
        });
        context.audit.annotate({ siteId: site.id });
        return { site: siteChangeSummary(site) };
      } catch (error) {
        throw mapSiteServiceError(error, '/content');
      }
    },
  };
}
