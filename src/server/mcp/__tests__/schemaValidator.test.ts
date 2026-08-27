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

import type { ErrorObject } from 'ajv';
import type { McpObjectSchema, McpToolDefinition } from '../contracts';
import {
  closedObjectSchema,
  compileMcpToolDefinition,
  schemaValidationSummary,
  successObjectSchema,
  validationIssues,
} from '../schemaValidator';

function toolDefinition(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name: 'test_tool',
    title: 'Test tool',
    description: 'Test schema validation',
    inputSchema: closedObjectSchema({}),
    outputSchema: successObjectSchema({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'understand-environments',
    access: 'read',
    handler: async () => ({}),
    ...overrides,
  };
}

function validationError(instancePath: string, message: string | undefined): ErrorObject {
  return {
    instancePath,
    schemaPath: '#/type',
    keyword: 'type',
    params: {},
    message,
  };
}

describe('MCP schema builders', () => {
  it('omits an empty required list and always adds the shared success request id', () => {
    expect(closedObjectSchema({ value: { type: 'string' } })).toEqual({
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    });
    expect(successObjectSchema({ value: { type: 'string' } })).toMatchObject({
      type: 'object',
      required: ['requestId'],
      properties: {
        value: { type: 'string' },
        requestId: { type: 'string', minLength: 1, maxLength: 128 },
      },
      additionalProperties: false,
    });
  });
});

describe('compileMcpToolDefinition schema contracts', () => {
  it('rejects an input schema that is not a closed object root', () => {
    const inputSchema = {
      type: 'array',
      properties: {},
      additionalProperties: false,
    } as unknown as McpObjectSchema;

    expect(() => compileMcpToolDefinition(toolDefinition({ inputSchema }))).toThrow(
      'test_tool.inputSchema must be a closed object-root JSON Schema'
    );
  });

  it('rejects a root combinator even when the surrounding object is closed', () => {
    const inputSchema = {
      ...closedObjectSchema({}),
      oneOf: [closedObjectSchema({})],
    } as McpObjectSchema;

    expect(() => compileMcpToolDefinition(toolDefinition({ inputSchema }))).toThrow(
      'test_tool.inputSchema must not use a root combinator'
    );
  });

  it('rejects an output schema without the bounded required request id', () => {
    const outputSchema = closedObjectSchema({ value: { type: 'string' } }, ['value']);

    expect(() => compileMcpToolDefinition(toolDefinition({ outputSchema }))).toThrow(
      'test_tool outputSchema must require the shared bounded requestId'
    );
  });
});

describe('MCP validation error presentation', () => {
  it('provides a stable fallback when Ajv reports no issues', () => {
    expect(validationIssues(null)).toEqual({
      issues: [{ path: '/', message: 'The request is invalid.' }],
    });
    expect(schemaValidationSummary(undefined)).toBe('');
  });

  it('bounds issue details and summaries while supplying missing Ajv fields', () => {
    const errors = [
      validationError('', undefined),
      validationError('/name', 'must be a string'),
      validationError('/description', 'x'.repeat(600)),
      validationError('/ignored', 'fourth summary issue'),
      ...Array.from({ length: 20 }, (_, index) => validationError(`/extra/${index}`, 'is invalid')),
    ];

    const issues = validationIssues(errors).issues as Array<{ path: string; message: string }>;
    expect(issues).toHaveLength(20);
    expect(issues[0]).toEqual({ path: '/', message: 'is invalid' });
    expect(issues[2].message).toHaveLength(500);
    expect(schemaValidationSummary(errors)).toBe(
      `/ is invalid; /name must be a string; /description ${'x'.repeat(600)}`
    );
  });
});
