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

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { McpJsonObject, McpObjectSchema, McpToolDefinition } from './contracts';

const MCP_REQUEST_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[\\x20-\\x7e]+$',
} as const;

export function closedObjectSchema(
  properties: McpObjectSchema['properties'],
  required: string[] = []
): McpObjectSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function successObjectSchema(
  properties: McpObjectSchema['properties'],
  required: string[] = []
): McpObjectSchema {
  return closedObjectSchema({ ...properties, requestId: MCP_REQUEST_ID_SCHEMA }, [...required, 'requestId']);
}

const validatorOptions = {
  allErrors: true,
  allowUnionTypes: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  validateFormats: true,
} as const;

const ajv2020 = new Ajv2020(validatorOptions);
const mcpSdkDialectAjv = new Ajv(validatorOptions);
addFormats(ajv2020);
addFormats(mcpSdkDialectAjv);

export function compileMcpJsonValidator<T = unknown>(schema: Record<string, unknown>): ValidateFunction<T> {
  return ajv2020.compile<T>(schema);
}

function assertMcpSdkDialectCompatible(schema: Record<string, unknown>, label: string): void {
  try {
    mcpSdkDialectAjv.compile(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is incompatible with the MCP SDK JSON Schema validator: ${message}`);
  }
}

export interface CompiledMcpToolDefinition {
  definition: McpToolDefinition;
  validateInput: ValidateFunction<McpJsonObject>;
  validateOutput: ValidateFunction<McpJsonObject>;
}

function assertCanonicalObjectSchema(schema: McpObjectSchema, label: string): void {
  if (schema.type !== 'object' || !schema.properties || schema.additionalProperties !== false) {
    throw new Error(`${label} must be a closed object-root JSON Schema`);
  }
  if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
    throw new Error(`${label} must not use a root combinator`);
  }
}

function assertSuccessRequestId(schema: McpObjectSchema, toolName: string): void {
  const requestId = schema.properties.requestId;
  if (
    !requestId ||
    requestId.type !== 'string' ||
    requestId.minLength !== 1 ||
    requestId.maxLength !== 128 ||
    !Array.isArray(schema.required) ||
    !schema.required.includes('requestId')
  ) {
    throw new Error(`${toolName} outputSchema must require the shared bounded requestId`);
  }
}

export function compileMcpToolDefinition(definition: McpToolDefinition): CompiledMcpToolDefinition {
  assertCanonicalObjectSchema(definition.inputSchema, `${definition.name}.inputSchema`);
  assertCanonicalObjectSchema(definition.outputSchema, `${definition.name}.outputSchema`);
  assertSuccessRequestId(definition.outputSchema, definition.name);
  assertMcpSdkDialectCompatible(definition.inputSchema, `${definition.name}.inputSchema`);
  assertMcpSdkDialectCompatible(definition.outputSchema, `${definition.name}.outputSchema`);

  return {
    definition,
    validateInput: compileMcpJsonValidator<McpJsonObject>(definition.inputSchema),
    validateOutput: compileMcpJsonValidator<McpJsonObject>(definition.outputSchema),
  };
}

export function validationIssues(errors: ErrorObject[] | null | undefined): McpJsonObject {
  const issues = (errors ?? []).slice(0, 20).map((error) => ({
    path: (error.instancePath || '/').slice(0, 500),
    message: (error.message || 'is invalid').slice(0, 500),
  }));
  return { issues: issues.length > 0 ? issues : [{ path: '/', message: 'The request is invalid.' }] };
}

export function schemaValidationSummary(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
    .join('; ')
    .slice(0, 1000);
}
