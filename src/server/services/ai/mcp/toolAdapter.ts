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

import { Tool, ToolResult, ToolSafetyLevel, ToolCategory, JSONSchema } from '../types/tool';
import { McpCachedTool, McpToolAnnotations, ResolvedMcpServer, MCP_ERROR_CODES } from './types';
import { McpClientManager } from './client';
import { getLogger } from 'server/lib/logger';
import { OutputLimiter } from '../tools/outputLimiter';

function mapAnnotationsToSafetyLevel(annotations?: McpToolAnnotations): ToolSafetyLevel {
  if (!annotations) return ToolSafetyLevel.CAUTIOUS;
  if (annotations.destructiveHint === true) return ToolSafetyLevel.DANGEROUS;
  if (annotations.readOnlyHint === true) return ToolSafetyLevel.SAFE;
  if (annotations.openWorldHint === true) return ToolSafetyLevel.CAUTIOUS;
  return ToolSafetyLevel.CAUTIOUS;
}

function prefixDescription(description: string, level: ToolSafetyLevel): string {
  if (level === ToolSafetyLevel.DANGEROUS) return `[DANGEROUS] ${description}`;
  if (level === ToolSafetyLevel.SAFE) return `[SAFE] ${description}`;
  return description;
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');
}

function classifyMcpError(error: unknown): { code: string; message: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (
    lower.includes('econnrefused') ||
    lower.includes('timeout') ||
    lower.includes('abort') ||
    lower.includes('connection failed') ||
    lower.includes('fetch failed')
  ) {
    return { code: MCP_ERROR_CODES.CONNECTION, message: msg };
  }

  if (lower.includes('protocol') || lower.includes('json-rpc') || lower.includes('jsonrpc')) {
    return { code: MCP_ERROR_CODES.PROTOCOL, message: msg };
  }

  return { code: MCP_ERROR_CODES.TOOL, message: msg };
}

export class MCPToolAdapter implements Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  safetyLevel: ToolSafetyLevel;
  category: ToolCategory;

  private originalName: string;
  private serverUrl: string;
  private serverHeaders: Record<string, string>;
  private serverTimeout: number;

  constructor(
    serverId: string,
    cachedTool: McpCachedTool,
    serverUrl: string,
    serverHeaders: Record<string, string>,
    serverTimeout: number
  ) {
    this.name = `mcp__${serverId}__${cachedTool.name}`;
    this.safetyLevel = mapAnnotationsToSafetyLevel(cachedTool.annotations);
    this.description = prefixDescription(
      cachedTool.description || `MCP tool ${cachedTool.name} from ${serverId}`,
      this.safetyLevel
    );
    this.parameters = cachedTool.inputSchema as JSONSchema;
    this.category = 'mcp';
    this.originalName = cachedTool.name;
    this.serverUrl = serverUrl;
    this.serverHeaders = serverHeaders;
    this.serverTimeout = serverTimeout;
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const client = new McpClientManager();
    try {
      try {
        await client.connect(this.serverUrl, this.serverHeaders, this.serverTimeout);
      } catch (error) {
        getLogger().warn(
          `MCP connection failed for tool ${this.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        return {
          success: false,
          error: {
            message: `Failed to connect to MCP server: ${error instanceof Error ? error.message : String(error)}`,
            code: MCP_ERROR_CODES.CONNECTION,
            recoverable: true,
            suggestedAction: 'MCP server may be temporarily unavailable. Try again or skip this tool.',
          },
        };
      }

      const result = await client.callTool(this.originalName, args, this.serverTimeout, signal);
      const textContent = extractTextContent(result.content);

      if (result.isError) {
        return {
          success: false,
          agentContent: textContent,
          error: {
            message: `MCP tool returned error: ${textContent}`,
            code: MCP_ERROR_CODES.TOOL,
            recoverable: true,
            suggestedAction: 'Check tool arguments and try again.',
          },
        };
      }

      return {
        success: true,
        agentContent: OutputLimiter.truncate(textContent),
      };
    } catch (error) {
      const classified = classifyMcpError(error);
      getLogger().warn(`MCP tool error for ${this.name}: code=${classified.code} ${classified.message}`);
      return {
        success: false,
        error: {
          message: classified.message,
          code: classified.code,
          recoverable: classified.code !== MCP_ERROR_CODES.PROTOCOL,
          suggestedAction:
            classified.code === MCP_ERROR_CODES.PROTOCOL
              ? 'MCP server may have a compatibility issue.'
              : 'Check tool arguments and try again.',
        },
      };
    } finally {
      await client.close();
    }
  }
}

export function createMcpTools(servers: ResolvedMcpServer[]): Tool[] {
  const tools: Tool[] = [];
  for (const server of servers) {
    for (const cachedTool of server.cachedTools) {
      tools.push(new MCPToolAdapter(server.slug, cachedTool, server.url, server.headers, server.timeout));
    }
  }
  return tools;
}
