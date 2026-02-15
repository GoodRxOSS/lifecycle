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

import JsonSchema from 'jsonschema';
import { Tool, ToolResult, ToolSafetyLevel } from '../types/tool';
import { StreamCallbacks } from '../types/stream';
import { getLogger } from 'server/lib/logger';
import { OutputLimiter } from '../tools/outputLimiter';

export class ToolSafetyManager {
  private requireConfirmation: boolean;
  private validator: JsonSchema.Validator;
  private toolExecutionTimeout: number;
  private toolOutputMaxChars: number;

  constructor(requireConfirmation: boolean = true, toolExecutionTimeout?: number, toolOutputMaxChars?: number) {
    this.requireConfirmation = requireConfirmation;
    this.validator = new JsonSchema.Validator();
    this.toolExecutionTimeout = toolExecutionTimeout || 30000;
    this.toolOutputMaxChars = toolOutputMaxChars || 30000;
  }

  async safeExecute(
    tool: Tool,
    args: Record<string, unknown>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    buildUuid?: string
  ): Promise<ToolResult> {
    const validation = this.validateArgs(tool.parameters, args);
    if (!validation.valid) {
      getLogger().warn(
        `AI: validation failed tool=${tool.name} errors=${validation.errors.join(', ')} buildUuid=${
          buildUuid || 'none'
        }`
      );
      return {
        success: false,
        error: {
          message: `Invalid arguments: ${validation.errors.join(', ')}`,
          code: 'INVALID_ARGUMENTS',
          recoverable: true,
        },
      };
    }

    if (this.needsConfirmation(tool)) {
      const confirmDetails = await tool.shouldConfirmExecution?.(args);

      if (confirmDetails) {
        if (!callbacks.onToolConfirmation) {
          getLogger().error(`AI: confirmation callback missing tool=${tool.name} buildUuid=${buildUuid || 'none'}`);
          return {
            success: false,
            error: {
              message: `This operation requires user confirmation, but the confirmation system is not available. Please implement onToolConfirmation callback.`,
              code: 'NO_CONFIRMATION_HANDLER',
              recoverable: false,
            },
          };
        }

        const confirmed = await callbacks.onToolConfirmation(confirmDetails);

        if (!confirmed) {
          return {
            success: false,
            error: {
              message: 'Operation cancelled by user',
              code: 'USER_CANCELLED',
              recoverable: false,
            },
          };
        }
      }
    }

    try {
      const result = await this.withTimeout(tool.execute(args, signal), this.toolExecutionTimeout);

      if (result.success && result.agentContent) {
        result.agentContent = OutputLimiter.truncate(result.agentContent, this.toolOutputMaxChars);
      }

      this.logToolExecution(tool.name, args, result, buildUuid);

      return result;
    } catch (error: any) {
      if (error.message === 'Tool execution timeout') {
        getLogger().warn(
          `AI: tool timeout tool=${tool.name} timeout=${this.toolExecutionTimeout}ms buildUuid=${buildUuid || 'none'}`
        );
        return {
          success: false,
          error: {
            message: `${tool.name} timed out after ${this.toolExecutionTimeout / 1000} seconds`,
            code: 'TIMEOUT',
            recoverable: true,
            suggestedAction: 'The operation took too long. Try narrowing your query.',
          },
        };
      }

      getLogger().error(
        `AI: tool execution failed tool=${tool.name} error=${error?.message} buildUuid=${buildUuid || 'none'}`
      );
      return {
        success: false,
        error: {
          message: error.message || 'Unknown error',
          code: error.code || 'EXECUTION_ERROR',
          details: error,
          recoverable: true,
        },
      };
    }
  }

  private needsConfirmation(tool: Tool): boolean {
    if (tool.safetyLevel === ToolSafetyLevel.DANGEROUS) {
      return true;
    }

    if (!this.requireConfirmation) {
      return false;
    }

    if (tool.safetyLevel === ToolSafetyLevel.CAUTIOUS) {
      return true;
    }

    return false;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Tool execution timeout')), timeoutMs)),
    ]);
  }

  private validateArgs(schema: any, args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const validationResult = this.validator.validate(args, schema);

    return {
      valid: validationResult.valid,
      errors: validationResult.valid ? [] : validationResult.errors.map((e) => e.message || 'Validation error'),
    };
  }

  private logToolExecution(name: string, args: Record<string, unknown>, result: ToolResult, buildUuid?: string): void {
    if (!result.success) {
      const level = result.error?.recoverable ? 'warn' : 'error';
      getLogger()[level](
        `AI: tool error tool=${name} error=${result.error?.message} code=${result.error?.code} recoverable=${
          result.error?.recoverable
        } buildUuid=${buildUuid || 'none'}`
      );
    }
  }
}
