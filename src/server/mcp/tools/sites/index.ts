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

import type { McpToolDefinition } from '../../contracts';
import { createCreateSiteToolDefinition } from './createSite';
import { createDeleteSiteToolDefinition } from './deleteSite';
import { createExtendSiteToolDefinition } from './extendSite';
import { createGetSiteToolDefinition } from './getSite';
import { createListSitesToolDefinition } from './listSites';
import { createRestoreSiteToolDefinition } from './restoreSite';
import { createSetSiteVisibilityToolDefinition } from './setSiteVisibility';
import { createUpdateSiteContentToolDefinition } from './updateSiteContent';
import { resolveSiteToolDependencies, type SiteToolDependencies } from './shared';

export type { SiteToolService } from './shared';

export function createSiteToolDefinitions(dependencies: SiteToolDependencies = {}): McpToolDefinition[] {
  const resolved = resolveSiteToolDependencies(dependencies);
  return [
    createListSitesToolDefinition(resolved),
    createGetSiteToolDefinition(resolved),
    createCreateSiteToolDefinition(resolved),
    createUpdateSiteContentToolDefinition(resolved),
    createSetSiteVisibilityToolDefinition(resolved),
    createExtendSiteToolDefinition(resolved),
    createDeleteSiteToolDefinition(resolved),
    createRestoreSiteToolDefinition(resolved),
  ];
}
