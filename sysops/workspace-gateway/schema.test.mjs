import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeToolInputSchema } from './schema.mjs';

test('normalizeToolInputSchema converts JSON Schema objects into MCP-compatible Zod schemas', () => {
  const inputSchema = {
    type: 'object',
    description: 'Figma tool arguments',
    properties: {
      fileKey: {
        type: 'string',
        description: 'Figma file key',
      },
      nodeId: {
        type: ['string', 'null'],
        description: 'Optional node id',
      },
      depth: {
        type: 'integer',
      },
      includeImages: {
        type: 'boolean',
      },
      variants: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
    },
    required: ['fileKey'],
    additionalProperties: false,
  };

  const normalized = normalizeToolInputSchema(inputSchema);
  const valid = normalized.safeParse({
    fileKey: 'sample-file',
    nodeId: null,
    depth: 2,
    includeImages: true,
    variants: ['desktop', 'mobile'],
  });

  assert.equal(valid.success, true);

  const missingRequired = normalized.safeParse({
    depth: 2,
  });
  assert.equal(missingRequired.success, false);
});

test('normalizeToolInputSchema keeps empty shapes compatible with registerTool', () => {
  const normalized = normalizeToolInputSchema({});
  const server = new McpServer(
    { name: 'schema-test', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  assert.doesNotThrow(() => {
    server.registerTool(
      'inspect_workspace',
      {
        title: 'Inspect workspace',
        inputSchema: normalized,
      },
      async () => ({ content: [] })
    );
  });
});

test('normalizeToolInputSchema returns an MCP-compatible schema for JSON Schema tool definitions', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
      },
      clientFrameworks: {
        type: 'array',
        items: {
          enum: ['nextjs', 'react-native'],
        },
      },
    },
    required: ['url'],
  };

  const server = new McpServer(
    { name: 'schema-test', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const normalized = normalizeToolInputSchema(inputSchema);
  assert.equal(typeof normalized.safeParse, 'function');

  assert.doesNotThrow(() => {
    server.registerTool(
      'fixed_figma_proxy',
      {
        title: 'Fixed Figma proxy',
        inputSchema: normalized,
      },
      async () => ({ content: [] })
    );
  });
});

test('normalizeToolInputSchema merges object allOf schemas into one tool input schema', () => {
  const normalized = normalizeToolInputSchema({
    allOf: [
      {
        type: 'object',
        properties: {
          fileKey: {
            type: 'string',
          },
        },
        required: ['fileKey'],
      },
      {
        type: 'object',
        properties: {
          nodeId: {
            type: 'string',
          },
        },
      },
    ],
  });

  const valid = normalized.safeParse({
    fileKey: 'sample-file',
    nodeId: '0:1',
  });
  assert.equal(valid.success, true);

  const missingRequired = normalized.safeParse({
    nodeId: '0:1',
  });
  assert.equal(missingRequired.success, false);
});
