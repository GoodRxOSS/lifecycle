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

import { Tool, ToolResult, ToolCategory } from '../types/tool';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerMultiple(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getByCategory(category: ToolCategory): Tool[] {
    return this.getAll().filter((t) => t.category === category);
  }

  getFiltered(filter: (tool: Tool) => boolean): Tool[] {
    return this.getAll().filter(filter);
  }

  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        error: {
          message: `Tool not found: ${name}`,
          code: 'TOOL_NOT_FOUND',
          recoverable: false,
        },
      };
    }

    try {
      return await tool.execute(args, signal);
    } catch (error: any) {
      return {
        success: false,
        error: {
          message: error.message || 'Unknown error',
          code: error.code || 'TOOL_EXECUTION_ERROR',
          details: error,
          recoverable: true,
          suggestedAction: 'Check tool arguments and try again',
        },
      };
    }
  }
}
