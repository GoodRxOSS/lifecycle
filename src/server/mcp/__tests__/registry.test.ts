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

import type {
  McpCapabilityId,
  McpRuntimePolicy,
  McpToolAccess,
  McpToolDefinition,
  McpToolInvocationContext,
} from '../contracts';
import { buildMcpAdminCatalog, McpToolRegistry } from '../registry';
import { successObjectSchema } from '../schemaValidator';

const inputSchema = { type: 'object' as const, properties: {}, additionalProperties: false as const };
const outputSchema = successObjectSchema({ value: { type: 'string' } }, ['value']);

function definition(
  name: string,
  capabilityId: McpCapabilityId,
  access: McpToolAccess,
  handler: McpToolDefinition['handler'] = jest.fn(async () => ({ value: 'ok' }))
): McpToolDefinition {
  return {
    name,
    title: `${name} title`,
    description: `${name} description`,
    capabilityId,
    access,
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: access === 'read',
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler,
  };
}

const enabled: McpRuntimePolicy = {
  enabled: true,
  allowChanges: true,
  sitesAvailable: true,
};

function parseFirstText(result: Awaited<ReturnType<McpToolRegistry['callTool']>>): unknown {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text tool result');
  return JSON.parse(first.text);
}

const context: McpToolInvocationContext = {
  principal: {
    kind: 'user',
    authMethod: 'oauth',
    userId: 'user-1',
    actor: 'user-1',
    roles: ['user'],
    scopes: null,
    tokenId: null,
    repositoryAllowlist: null,
    repositoryAllowlistRepoIds: null,
    identity: null,
  },
  requestId: 'request-1',
  signal: new AbortController().signal,
};

function setup() {
  const registry = new McpToolRegistry(
    [
      definition('get_environment', 'understand-environments', 'read'),
      definition('diagnose_environment', 'diagnose-environments', 'read'),
      definition('deploy_environment', 'manage-environments', 'change'),
      definition('get_site', 'view-hosted-sites', 'read'),
    ],
    {
      increment: jest.fn(),
      timing: jest.fn(),
      gauge: jest.fn(),
    },
    { record: jest.fn() }
  );
  return { registry };
}

it('uses the registered definitions as the admin capability catalog', () => {
  const { registry } = setup();
  expect(buildMcpAdminCatalog(registry.definitions(), { sitesAvailable: true })).toEqual([
    expect.objectContaining({
      id: 'understand-environments',
      tools: [expect.objectContaining({ name: 'get_environment', access: 'read' })],
    }),
    expect.objectContaining({
      id: 'diagnose-environments',
      tools: [expect.objectContaining({ name: 'diagnose_environment', access: 'read' })],
    }),
    expect.objectContaining({
      id: 'manage-environments',
      tools: [expect.objectContaining({ name: 'deploy_environment', access: 'change' })],
    }),
    expect.objectContaining({
      id: 'view-hosted-sites',
      tools: [expect.objectContaining({ name: 'get_site', access: 'read' })],
    }),
  ]);
});

it('returns an empty catalog and rejects calls while MCP is disabled', async () => {
  const { registry } = setup();
  const policy = { ...enabled, enabled: false };
  expect(registry.listTools(policy).tools).toEqual([]);
  const result = await registry.callTool('get_environment', {}, context, policy);
  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'toolset_disabled' }),
    })
  );
});

it('omits and rejects change tools when allowChanges is false', async () => {
  const { registry } = setup();
  const policy = { ...enabled, allowChanges: false };
  expect(registry.listTools(policy).tools.map(({ name }) => name)).not.toContain('deploy_environment');
  const result = await registry.callTool('deploy_environment', {}, context, policy);
  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'toolset_disabled' }),
    })
  );
});

it('omits and rejects Sites tools when Sites is unavailable', async () => {
  const { registry } = setup();
  const policy = { ...enabled, sitesAvailable: false };
  expect(registry.listTools(policy).tools.map(({ name }) => name)).not.toContain('get_site');
  const result = await registry.callTool('get_site', {}, context, policy);
  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'toolset_disabled' }),
    })
  );
});

it('runs the handler only after coarse admission and OAuth role validation', async () => {
  const handler = jest.fn(async () => ({ value: 'ok' }));
  const registry = new McpToolRegistry(
    [definition('get_environment', 'understand-environments', 'read', handler)],
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    { record: jest.fn() }
  );
  const result = await registry.callTool('get_environment', {}, context, enabled);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(result.structuredContent).toEqual({ value: 'ok', requestId: 'request-1' });
});

it('serializes structured content unchanged for text-only MCP clients', async () => {
  const tool = definition('get_untrusted', 'diagnose-environments', 'read', async () => ({
    payload: { untrusted: true, value: 'literal environment-id' },
  }));
  tool.outputSchema = successObjectSchema(
    {
      payload: {
        type: 'object',
        properties: {
          untrusted: { type: 'boolean', const: true },
          value: { type: 'string' },
        },
        required: ['untrusted', 'value'],
        additionalProperties: false,
      },
    },
    ['payload']
  );
  const registry = new McpToolRegistry(
    [tool],
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    { record: jest.fn() }
  );

  const result = await registry.callTool('get_untrusted', {}, context, enabled);
  expect(parseFirstText(result)).toEqual(result.structuredContent);
  expect(result.content[0]).toEqual(
    expect.objectContaining({ type: 'text', text: expect.stringContaining('literal environment-id') })
  );
});

it('rejects duplicate registered names without a fixed production count', () => {
  expect(
    () =>
      new McpToolRegistry([
        definition('same', 'understand-environments', 'read'),
        definition('same', 'diagnose-environments', 'read'),
      ])
  ).toThrow('Duplicate MCP tool definition');
});

it('rejects schemas that the MCP SDK JSON Schema dialect cannot interpret', () => {
  const tool = definition('incompatible_output', 'understand-environments', 'read');
  tool.outputSchema = successObjectSchema(
    {
      values: {
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: false,
      },
    },
    ['values']
  );

  expect(() => new McpToolRegistry([tool])).toThrow(
    'incompatible_output.outputSchema is incompatible with the MCP SDK JSON Schema validator'
  );
});

it('rejects input and output schemas that exceed their byte budgets', () => {
  const oversizedInput = definition('oversized_input', 'understand-environments', 'read');
  oversizedInput.inputSchema = {
    type: 'object',
    properties: { value: { type: 'string', description: 'x'.repeat(5 * 1024) } },
    additionalProperties: false,
  };
  expect(
    () =>
      new McpToolRegistry(
        [oversizedInput],
        { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
        { record: jest.fn() }
      )
  ).toThrow('oversized_input.inputSchema exceeds 4096 UTF-8 bytes');

  const oversizedOutput = definition('oversized_output', 'understand-environments', 'read');
  oversizedOutput.outputSchema = successObjectSchema({ value: { type: 'string', description: 'x'.repeat(9 * 1024) } }, [
    'value',
  ]);
  expect(
    () =>
      new McpToolRegistry(
        [oversizedOutput],
        { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
        { record: jest.fn() }
      )
  ).toThrow('oversized_output.outputSchema exceeds 8192 UTF-8 bytes');
});

it('rejects a full wire catalog that exceeds 64 KiB', () => {
  const definitions = Array.from({ length: 40 }, (_, index) => {
    const toolDefinition = definition(`tool_${index}`, 'understand-environments', 'read');
    toolDefinition.description = 'x'.repeat(1900);
    return toolDefinition;
  });

  expect(
    () =>
      new McpToolRegistry(
        definitions,
        { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
        { record: jest.fn() }
      )
  ).toThrow('MCP catalog exceeds 65536 UTF-8 bytes');
});
