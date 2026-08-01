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

import { buildMcpAdminCatalog, McpToolRegistry } from '../registry';
import { compileMcpJsonValidator } from '../schemaValidator';
import { MCP_INITIALIZE_INSTRUCTIONS } from '../server';
import { createLifecycleMcpRegistry, createLifecycleMcpToolDefinitions } from '../tools';

const ALL_TOOLS = [
  'get_context',
  'list_repositories',
  'preview_environment_config',
  'validate_lifecycle_config',
  'list_environments',
  'get_environment',
  'wait_for_environment',
  'create_environment',
  'configure_environment',
  'deploy_environment',
  'extend_environment',
  'destroy_environment',
  'diagnose_environment',
  'get_logs',
  'get_kubernetes_state',
  'list_sites',
  'get_site',
];

const CHANGE_TOOLS = [
  'create_environment',
  'configure_environment',
  'deploy_environment',
  'extend_environment',
  'destroy_environment',
];

const SITE_TOOLS = ['list_sites', 'get_site'];

it('compiles the production catalog exactly as ws-server boots it', () => {
  expect(() => createLifecycleMcpRegistry()).not.toThrow();
});

describe('production catalog', () => {
  const registry = new McpToolRegistry(createLifecycleMcpToolDefinitions());

  it('serves every tool in the published order', () => {
    const { tools } = registry.listTools({ enabled: true, allowChanges: true, sitesAvailable: true });
    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOLS);
  });

  it('hides every change tool when changes are disabled', () => {
    const { tools } = registry.listTools({ enabled: true, allowChanges: false, sitesAvailable: true });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(ALL_TOOLS.filter((name) => !CHANGE_TOOLS.includes(name)));
  });

  it('hides site tools when sites are unavailable', () => {
    const { tools } = registry.listTools({ enabled: true, allowChanges: true, sitesAvailable: false });
    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOLS.filter((name) => !SITE_TOOLS.includes(name)));
  });

  it('serves no tools while the product is disabled', () => {
    const { tools } = registry.listTools({ enabled: false, allowChanges: true, sitesAvailable: true });
    expect(tools).toEqual([]);
  });

  it('marks exactly the change tools as non-read-only', () => {
    for (const definition of registry.definitions()) {
      expect(definition.annotations.readOnlyHint).toBe(!CHANGE_TOOLS.includes(definition.name));
      expect(definition.access).toBe(CHANGE_TOOLS.includes(definition.name) ? 'change' : 'read');
    }
  });

  it('marks tools that reach external systems or return external workload content as open-world', () => {
    expect(
      registry
        .definitions()
        .filter((definition) => definition.annotations.openWorldHint)
        .map((definition) => definition.name)
    ).toEqual([
      'list_repositories',
      'preview_environment_config',
      'validate_lifecycle_config',
      'create_environment',
      'configure_environment',
      'deploy_environment',
      'destroy_environment',
      'diagnose_environment',
      'get_logs',
      'get_kubernetes_state',
    ]);
  });

  it('presents mutations as receipts without prompting automatic monitoring', () => {
    expect(MCP_INITIALIZE_INSTRUCTIONS).toContain('acceptance receipts');
    expect(MCP_INITIALIZE_INSTRUCTIONS).toContain('get_environment');
    expect(MCP_INITIALIZE_INSTRUCTIONS).toContain('Report the receipt without waiting');
    expect(MCP_INITIALIZE_INSTRUCTIONS).toContain('include that plain URL');
    expect(MCP_INITIALIZE_INSTRUCTIONS).toContain('only when the user explicitly asks');
    expect(MCP_INITIALIZE_INSTRUCTIONS).not.toContain('Start with get_context');

    for (const name of ['create_environment', 'configure_environment', 'deploy_environment', 'destroy_environment']) {
      const description = registry.definitions().find((definition) => definition.name === name)?.description ?? '';
      expect(description).toContain('background');
      expect(description).toContain('get_environment');
      expect(description).toContain('when the user asks');
      expect(description).not.toMatch(/wait binding|call wait_for_environment|on a timeout/i);
    }

    const waitDescription =
      registry.definitions().find((definition) => definition.name === 'wait_for_environment')?.description ?? '';
    expect(waitDescription).toContain('only when the user explicitly asks');
    expect(waitDescription).toContain('report the acceptance receipt without calling this tool');
  });

  it('publishes mutation and wait schemas without automatic-monitoring signals', () => {
    const { tools } = registry.listTools({ enabled: true, allowChanges: true, sitesAvailable: true });
    for (const name of ['create_environment', 'configure_environment', 'deploy_environment', 'destroy_environment']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(JSON.stringify(tool!.outputSchema)).not.toContain('"wait"');
    }

    const waitTool = tools.find((tool) => tool.name === 'wait_for_environment');
    expect(waitTool).toBeDefined();
    expect(JSON.stringify(waitTool!.outputSchema)).not.toContain('pollAfterSeconds');
    expect((waitTool!.outputSchema.properties.result as Record<string, unknown>).oneOf).toBeUndefined();
  });

  it('keeps the full production wire catalog within 64 KiB', () => {
    const catalog = registry.listTools({ enabled: true, allowChanges: true, sitesAvailable: true });
    expect(Buffer.byteLength(JSON.stringify(catalog), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps empty calls flat for every zero-argument or optional-argument tool', () => {
    const definitions = registry
      .definitions()
      .filter((definition) => (definition.inputSchema.required?.length ?? 0) === 0);

    expect(definitions.map((definition) => definition.name)).toEqual([
      'get_context',
      'list_environments',
      'list_sites',
    ]);

    for (const definition of definitions) {
      const validate = compileMcpJsonValidator(definition.inputSchema);

      expect(validate({})).toBe(true);
      expect(validate({ request: {} })).toBe(false);
      expect(validate.errors).toEqual([
        expect.objectContaining({
          keyword: 'additionalProperties',
          params: { additionalProperty: 'request' },
        }),
      ]);
    }
  });

  it('assigns every tool to a catalog capability', () => {
    const catalog = buildMcpAdminCatalog(registry.definitions(), { sitesAvailable: true });
    const cataloged = catalog.flatMap((capability) => capability.tools.map((tool) => tool.name)).sort();
    expect(cataloged).toEqual([...ALL_TOOLS].sort());
  });

  it('omits unavailable product capabilities from the admin catalog', () => {
    const catalog = buildMcpAdminCatalog(registry.definitions(), { sitesAvailable: false });
    expect(catalog.map((capability) => capability.id)).toEqual([
      'understand-environments',
      'diagnose-environments',
      'manage-environments',
    ]);
  });
});
