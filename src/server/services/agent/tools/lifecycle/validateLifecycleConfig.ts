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

import { renderLifecycleSchemaSlices } from 'server/lib/yamlSchemas/schemaSlice';
import { BaseTool } from '../baseTool';
import { ToolResult } from '../types';
import { validateLifecycleConfigContent } from '../github/updateFile';

export class ValidateLifecycleConfigTool extends BaseTool {
  static readonly Name = 'validate_lifecycle_config';

  constructor() {
    super(
      'Validate candidate lifecycle.yaml content against the schema WITHOUT committing anything. Returns path-specific validation errors plus the schema slice (allowed fields, types, enums) for each failing path. Always validate a lifecycle.yaml fix here first and only request update_file approval for content that validates — an invalid commit proposal wastes an approval round-trip.',
      {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The full proposed lifecycle.yaml file content to validate.',
          },
        },
        required: ['content'],
      }
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    const content = typeof args.content === 'string' ? args.content : '';
    if (!content.trim()) {
      return this.createErrorResult('content is required — pass the full proposed lifecycle.yaml.', 'INVALID_INPUT');
    }

    const validation = validateLifecycleConfigContent(content);
    if (validation.valid) {
      return this.createSuccessResult(
        'VALID: the content passes lifecycle.yaml schema validation. It is safe to propose via update_file.',
        'lifecycle.yaml content is schema-valid'
      );
    }

    const error = validation.error || 'unknown validation error';
    const slices = renderLifecycleSchemaSlices(error);
    const agentContent = [
      'INVALID: the content fails lifecycle.yaml schema validation. Fix these errors and validate again before proposing update_file.',
      'Errors:',
      error,
      ...(slices ? ['Relevant schema for the failing paths:', slices] : []),
    ].join('\n');

    return this.createSuccessResult(agentContent, 'lifecycle.yaml content is schema-invalid');
  }
}
