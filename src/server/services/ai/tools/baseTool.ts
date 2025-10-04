/**
 * Copyright 2025 GoodRx, Inc.
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

import { Tool, ToolResult, ToolSafetyLevel, ToolCategory, JSONSchema, ConfirmationDetails } from '../types/tool';

export abstract class BaseTool implements Tool {
  static readonly Name: string;

  get name(): string {
    const toolClass = this.constructor as typeof BaseTool;
    if (!toolClass.Name) {
      throw new Error(`Tool class ${toolClass.name} must define static Name property`);
    }
    return toolClass.Name;
  }

  public readonly description: string;
  public readonly parameters: JSONSchema;
  public readonly safetyLevel: ToolSafetyLevel;
  public readonly category: ToolCategory;

  constructor(description: string, parameters: JSONSchema, safetyLevel: ToolSafetyLevel, category: ToolCategory) {
    this.description = description;
    this.parameters = parameters;
    this.safetyLevel = safetyLevel;
    this.category = category;
  }

  abstract execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;

  async shouldConfirmExecution?(_args: Record<string, unknown>): Promise<ConfirmationDetails | false> {
    return false;
  }

  protected createSuccessResult(agentContent: string, displayContent?: string): ToolResult {
    return {
      success: true,
      agentContent,
      displayContent: displayContent
        ? {
            type: 'text',
            content: displayContent,
          }
        : undefined,
    };
  }

  protected createErrorResult(message: string, code: string, recoverable: boolean = true): ToolResult {
    return {
      success: false,
      agentContent: `Error: ${message}`,
      error: {
        message,
        code,
        recoverable,
      },
    };
  }

  protected checkAborted(signal?: AbortSignal): boolean {
    return signal?.aborted || false;
  }
}
