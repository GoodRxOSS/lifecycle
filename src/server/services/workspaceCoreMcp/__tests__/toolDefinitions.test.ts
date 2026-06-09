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

import { isWorkspaceCoreMcpEnabled, WORKSPACE_CORE_MCP_FEATURE_FLAG } from '../config';
import { toolUnavailableResult } from '../result';
import { WORKSPACE_CORE_REQUIRED_TOOL_NAMES, WORKSPACE_CORE_TOOL_DEFINITIONS } from '../toolDefinitions';
import { AGENT_CAPABILITY_CATALOG } from 'server/services/agent/capabilityCatalog';

describe('workspace_core tool contract', () => {
  const originalFlag = process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG];

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG];
    } else {
      process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG] = originalFlag;
    }
  });

  it('is enabled unless explicitly disabled', () => {
    delete process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG];
    expect(isWorkspaceCoreMcpEnabled()).toBe(true);

    process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG] = 'false';
    expect(isWorkspaceCoreMcpEnabled()).toBe(false);
  });

  it('defines every required v1 tool with input and output schemas', () => {
    expect(WORKSPACE_CORE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(WORKSPACE_CORE_REQUIRED_TOOL_NAMES);

    for (const tool of WORKSPACE_CORE_TOOL_DEFINITIONS) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.outputSchema).toMatchObject({
        oneOf: expect.arrayContaining([
          expect.any(Object),
          expect.objectContaining({
            oneOf: expect.any(Array),
          }),
        ]),
      });
      expect(tool.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('keeps workspace_core catalog ownership aligned with runtime capability gates', () => {
    const definitionsByName = new Map(
      WORKSPACE_CORE_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])
    );

    for (const catalogEntry of AGENT_CAPABILITY_CATALOG) {
      for (const toolKey of catalogEntry.toolKeys || []) {
        if (!toolKey.startsWith('workspace_core.')) {
          continue;
        }

        const toolName = toolKey.slice('workspace_core.'.length);
        const definition = definitionsByName.get(toolName as (typeof WORKSPACE_CORE_REQUIRED_TOOL_NAMES)[number]);
        expect(definition).toBeDefined();
        expect(definition?.catalogCapabilityId).toBe(catalogEntry.id);
      }
    }
  });

  it('does not advertise publish_http inputs rejected by the adapter', () => {
    const publishHttp = WORKSPACE_CORE_TOOL_DEFINITIONS.find((tool) => tool.name === 'publish_http');
    expect(publishHttp?.inputSchema).toMatchObject({
      properties: {
        port: expect.any(Object),
        label: expect.any(Object),
      },
    });
    expect((publishHttp?.inputSchema.properties as Record<string, unknown>).path).toBeUndefined();
    expect((publishHttp?.inputSchema.properties as Record<string, unknown>).healthcheck_path).toBeUndefined();
    expect((publishHttp?.inputSchema.properties as Record<string, unknown>).expected_status).toBeUndefined();
  });

  it('uses the shared tool_unavailable policy envelope', () => {
    const result = toolUnavailableResult('apply_patch');

    expect(result).toMatchObject({
      ok: false,
      code: 'tool_unavailable',
      retry: 'never',
      details: {
        tool: 'apply_patch',
      },
    });
    expect(result.audit_id).toMatch(/^workspace_core:/);
  });
});
