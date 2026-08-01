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

import type { ValidateFunction } from 'ajv';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { canonicalJson } from 'server/lib/canonicalJson';
import type { McpJsonObject, McpSuccessResult } from './contracts';
import { McpExecutionError, toExecutionErrorEnvelope } from './errors';
import { schemaValidationSummary } from './schemaValidator';

export function successResult(
  output: McpJsonObject,
  requestId: string,
  validateOutput: ValidateFunction<McpJsonObject>
): McpSuccessResult & CallToolResult {
  const structuredContent: McpJsonObject = { ...output, requestId };
  if (!validateOutput(structuredContent)) {
    throw new Error(`MCP handler returned invalid success output: ${schemaValidationSummary(validateOutput.errors)}`);
  }
  return {
    content: [{ type: 'text', text: canonicalJson(structuredContent) }],
    structuredContent,
  };
}

export function executionErrorResult(error: McpExecutionError, requestId: string) {
  const envelope = toExecutionErrorEnvelope(error, requestId);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  } satisfies CallToolResult;
}
