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

import {
  AGENT_CAPABILITY_CATALOG,
  AGENT_CAPABILITY_CATALOG_IDS,
  getAgentCapabilityCatalogEntry,
  isAgentCapabilityCatalogId,
} from '../capabilityCatalog';
import { isAgentCapabilityKey } from '../types';

describe('agent capability catalog', () => {
  it('has unique ids with non-empty labels and descriptions', () => {
    expect(new Set(AGENT_CAPABILITY_CATALOG_IDS).size).toBe(AGENT_CAPABILITY_CATALOG_IDS.length);
    expect(new Set(AGENT_CAPABILITY_CATALOG.map((entry) => entry.id)).size).toBe(AGENT_CAPABILITY_CATALOG.length);

    for (const entry of AGENT_CAPABILITY_CATALOG) {
      expect(entry.label.trim()).not.toHaveLength(0);
      expect(entry.description.trim()).not.toHaveLength(0);
      expect(isAgentCapabilityCatalogId(entry.id)).toBe(true);
    }
  });

  it('maps runtime capability keys to known approval capabilities', () => {
    for (const entry of AGENT_CAPABILITY_CATALOG) {
      if (entry.runtimeCapabilityKey) {
        expect(isAgentCapabilityKey(entry.runtimeCapabilityKey)).toBe(true);
      }
    }
  });

  it('contains the required governable capability families', () => {
    expect(getAgentCapabilityCatalogEntry('read_context').label).toBe('Read/context');
    expect(getAgentCapabilityCatalogEntry('diagnostics_codefresh').category).toBe('diagnostics');
    expect(getAgentCapabilityCatalogEntry('diagnostics_kubernetes').category).toBe('diagnostics');
    expect(getAgentCapabilityCatalogEntry('diagnostics_database').category).toBe('diagnostics');
    expect(getAgentCapabilityCatalogEntry('github_read').category).toBe('source_control');
    expect(getAgentCapabilityCatalogEntry('github_write').runtimeCapabilityKey).toBe('git_write');
    expect(getAgentCapabilityCatalogEntry('workspace_files').runtimeCapabilityKey).toBe('workspace_write');
    expect(getAgentCapabilityCatalogEntry('workspace_shell').runtimeCapabilityKey).toBe('shell_exec');
    expect(getAgentCapabilityCatalogEntry('workspace_git').runtimeCapabilityKey).toBe('read');
    expect(getAgentCapabilityCatalogEntry('external_mcp_read').runtimeCapabilityKey).toBe('external_mcp_read');
    expect(getAgentCapabilityCatalogEntry('external_mcp_write').runtimeCapabilityKey).toBe('external_mcp_write');
    expect(getAgentCapabilityCatalogEntry('preview_publish').category).toBe('preview');
    expect(getAgentCapabilityCatalogEntry('approval_controls').category).toBe('approval');
  });
});
