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

const mockRecordAuthAuditEvent = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('server/services/authAudit', () => ({
  recordAuthAuditEvent: (...args: unknown[]) => mockRecordAuthAuditEvent(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ error: mockLoggerError, warn: mockLoggerWarn }),
}));

jest.mock('server/lib/metrics', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    increment: jest.fn(),
    timing: jest.fn(),
    gauge: jest.fn(),
  })),
}));

import type {
  McpCapabilityId,
  McpRuntimePolicy,
  McpToolAccess,
  McpToolDefinition,
  McpToolInvocationContext,
} from '../contracts';
import { McpExecutionError } from '../errors';
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

beforeEach(() => {
  jest.clearAllMocks();
});

function setup() {
  const metrics = {
    increment: jest.fn(),
    timing: jest.fn(),
    gauge: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const registry = new McpToolRegistry(
    [
      definition('get_environment', 'understand-environments', 'read'),
      definition('diagnose_environment', 'diagnose-environments', 'read'),
      definition('deploy_environment', 'manage-environments', 'change'),
      definition('get_site', 'view-hosted-sites', 'read'),
    ],
    metrics,
    audit
  );
  return { registry, metrics, audit };
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
  const { registry, metrics, audit } = setup();
  const policy = { ...enabled, enabled: false };
  expect(registry.listTools(policy).tools).toEqual([]);
  const result = await registry.callTool('get_environment', {}, context, policy);
  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'toolset_disabled' }),
    })
  );
  expect(metrics.increment).not.toHaveBeenCalled();
  expect(audit.record).not.toHaveBeenCalled();
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

it('rejects unknown tool names with a bounded printable diagnostic', async () => {
  const { registry } = setup();
  const untrustedName = `unknown\nπ${'x'.repeat(200)}`;

  await expect(registry.callTool(untrustedName, {}, context, enabled)).rejects.toMatchObject({
    code: -32602,
    message: `MCP error -32602: Unknown tool: unknown??${'x'.repeat(119)}`,
  });
});

it('returns a validation error before authorization or handler execution', async () => {
  const handler = jest.fn(async () => ({ value: 'ok' }));
  const metrics = { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() };
  const audit = { record: jest.fn() };
  const registry = new McpToolRegistry(
    [definition('deploy_environment', 'manage-environments', 'change', handler)],
    metrics,
    audit
  );

  const result = await registry.callTool('deploy_environment', { unexpected: true }, context, enabled);

  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_body', nextAction: 'fix_input' }) })
  );
  expect(handler).not.toHaveBeenCalled();
  expect(audit.record).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'invalid_body', stage: 'validation', fields: {} })
  );
  expect(metrics.increment).toHaveBeenCalledWith('tool.errors', {
    tool: 'deploy_environment',
    code: 'invalid_body',
  });
});

it.each([
  ['API-key principal', { ...context.principal, kind: 'personal_key', authMethod: 'api_key', roles: [] }],
  ['non-OAuth user', { ...context.principal, authMethod: 'session' }],
  ['OAuth user without an allowed role', { ...context.principal, roles: [] }],
] as const)('rejects a %s before handler execution', async (_label, principal) => {
  const handler = jest.fn(async () => ({ value: 'ok' }));
  const audit = { record: jest.fn() };
  const registry = new McpToolRegistry(
    [definition('deploy_environment', 'manage-environments', 'change', handler)],
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    audit
  );

  const result = await registry.callTool('deploy_environment', {}, { ...context, principal }, enabled);

  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({ error: expect.objectContaining({ code: 'forbidden_role' }) })
  );
  expect(handler).not.toHaveBeenCalled();
  expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'forbidden_role', stage: 'policy' }));
});

it('audits successful change tools with bounded initial and handler-annotated identifiers', async () => {
  const handler = jest.fn(async (_input, invocationContext) => {
    invocationContext.audit.annotate({
      uuid: 'handler_uuid',
      environmentId: 42,
      deployId: 'deploy_1',
      siteId: 'siteid1234',
      idempotencyKeyFingerprint: 'a'.repeat(64),
      operation: 'execute',
    });
    return { value: 'ok' };
  });
  const tool = definition('deploy_environment', 'manage-environments', 'change', handler);
  tool.inputSchema = {
    type: 'object',
    properties: {
      uuid: { type: 'string' },
      environmentId: { type: 'integer' },
      siteId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      confirmation: {
        type: 'object',
        properties: { phase: { type: 'string', enum: ['preview', 'execute'] } },
        required: ['phase'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
  const audit = { record: jest.fn() };
  const registry = new McpToolRegistry([tool], { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() }, audit);

  await expect(
    registry.callTool(
      'deploy_environment',
      {
        uuid: 'input_uuid',
        environmentId: 7,
        siteId: 'inputsite1',
        idempotencyKey: 'private-key',
        confirmation: { phase: 'preview' },
      },
      context,
      enabled
    )
  ).resolves.toEqual(expect.objectContaining({ structuredContent: { value: 'ok', requestId: 'request-1' } }));

  expect(audit.record).toHaveBeenCalledWith({
    principal: context.principal,
    requestId: 'request-1',
    tool: 'deploy_environment',
    outcome: 'succeeded',
    stage: 'success',
    fields: {
      uuid: 'handler_uuid',
      environmentId: 42,
      deployId: 'deploy_1',
      siteId: 'siteid1234',
      idempotencyKeyFingerprint: 'a'.repeat(64),
      operation: 'execute',
    },
  });
  expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain('private-key');
});

it('drops malformed audit identifiers rather than persisting untrusted values', async () => {
  const tool = definition('deploy_environment', 'manage-environments', 'change', async (_input, invocationContext) => {
    invocationContext.audit.annotate({
      uuid: 'contains spaces',
      environmentId: -1,
      deployId: 'also invalid!',
      siteId: 'short',
      idempotencyKeyFingerprint: 'not-a-hash',
      operation: 'unknown' as 'execute',
    });
    return { value: 'ok' };
  });
  tool.inputSchema = {
    type: 'object',
    properties: {
      uuid: { type: 'string' },
      environmentId: { type: 'integer' },
      siteId: { type: 'string' },
      confirmation: {},
    },
    additionalProperties: false,
  };
  const audit = { record: jest.fn() };
  const registry = new McpToolRegistry([tool], { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() }, audit);

  await registry.callTool(
    'deploy_environment',
    { uuid: 'contains spaces', environmentId: 0, siteId: 'short', confirmation: [] },
    context,
    enabled
  );

  expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ fields: {} }));
});

it('preserves domain errors and records their domain-stage audit outcome', async () => {
  const audit = { record: jest.fn() };
  const handlerError = new McpExecutionError('env_not_found', 'Environment was not found.');
  const registry = new McpToolRegistry(
    [
      definition('deploy_environment', 'manage-environments', 'change', async () => {
        throw handlerError;
      }),
    ],
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    audit
  );

  const result = await registry.callTool('deploy_environment', {}, context, enabled);

  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({ error: expect.objectContaining({ code: 'env_not_found' }) })
  );
  expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'env_not_found', stage: 'domain' }));
});

it('fails closed, logs, and audits when a handler throws an unexpected error', async () => {
  const audit = { record: jest.fn() };
  const error = new Error('secret upstream detail');
  const registry = new McpToolRegistry(
    [
      definition('deploy_environment', 'manage-environments', 'change', async () => {
        throw error;
      }),
    ],
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    audit
  );

  const result = await registry.callTool('deploy_environment', {}, context, enabled);

  expect(parseFirstText(result)).toEqual(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'internal_error', message: expect.not.stringContaining('secret') }),
    })
  );
  expect(mockLoggerError).toHaveBeenCalledWith(
    { error, tool: 'deploy_environment', requestId: 'request-1' },
    'MCP tool execution failed closed'
  );
  expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'internal_error', stage: 'domain' }));
});

it('keeps tool execution successful when metrics and audit emission fail', async () => {
  const metricError = new Error('metrics unavailable');
  const auditError = new Error('audit unavailable');
  const metrics = {
    increment: jest.fn(() => {
      throw metricError;
    }),
    timing: jest.fn(() => {
      throw metricError;
    }),
    gauge: jest.fn(() => {
      throw metricError;
    }),
  };
  const audit = { record: jest.fn(async () => Promise.reject(auditError)) };
  const registry = new McpToolRegistry(
    [definition('deploy_environment', 'manage-environments', 'change')],
    metrics,
    audit
  );

  await expect(registry.callTool('deploy_environment', {}, context, enabled)).resolves.toEqual(
    expect.objectContaining({ structuredContent: { value: 'ok', requestId: 'request-1' } })
  );
  expect(mockLoggerWarn).toHaveBeenCalledWith({ error: metricError }, 'MCP metric emission failed');
  expect(mockLoggerWarn).toHaveBeenCalledWith(
    { error: auditError, tool: 'deploy_environment' },
    'MCP tool-call audit emission failed'
  );
});

it('uses the default audit sink for successful change tools', async () => {
  const registry = new McpToolRegistry([definition('deploy_environment', 'manage-environments', 'change')]);

  await registry.callTool('deploy_environment', {}, context, enabled);

  expect(mockRecordAuthAuditEvent).toHaveBeenCalledWith({
    event: 'mcp.tool_call',
    principalKind: 'user',
    principalId: 'user-1',
    actorId: 'user-1',
    tokenId: null,
    requestId: 'request-1',
    route: 'MCP deploy_environment',
    outcome: 'succeeded',
    meta: {
      tool: 'deploy_environment',
      stage: 'success',
      credentialKind: 'user',
    },
  });
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

it.each(['title', 'description'] as const)('rejects a %s that exceeds its UTF-8 byte budget', (field) => {
  const tool = definition('oversized_descriptor', 'understand-environments', 'read');
  tool[field] = 'é'.repeat(1025);

  expect(
    () =>
      new McpToolRegistry([tool], { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() }, { record: jest.fn() })
  ).toThrow(`oversized_descriptor.${field} exceeds 2048 UTF-8 bytes`);
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
