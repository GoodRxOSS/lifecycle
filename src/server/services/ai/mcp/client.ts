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

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { getLogger } from 'server/lib/logger';
import type { McpDiscoveredTool, McpResolvedTransportConfig, McpToolAnnotations } from './types';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;

type ListToolsDefinitions = Awaited<ReturnType<MCPClient['listTools']>>;
type ExperimentalStdioMCPModule = typeof import('@ai-sdk/mcp/dist/mcp-stdio');

function getExperimentalStdioMCPTransport(): ExperimentalStdioMCPModule['Experimental_StdioMCPTransport'] {
  return require('@ai-sdk/mcp/mcp-stdio')
    .Experimental_StdioMCPTransport as ExperimentalStdioMCPModule['Experimental_StdioMCPTransport'];
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

    operation.then(
      (result) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(result);
      },
      (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      }
    );
  });
}

function mapToolAnnotations(annotations: Record<string, unknown> | undefined): McpToolAnnotations | undefined {
  if (!annotations || typeof annotations !== 'object') {
    return undefined;
  }

  return {
    readOnlyHint: annotations.readOnlyHint === true,
    destructiveHint: annotations.destructiveHint === true,
    openWorldHint: annotations.openWorldHint === true,
  };
}

function toMcpDiscoveredTools(definitions: ListToolsDefinitions): McpDiscoveredTool[] {
  return definitions.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    annotations: mapToolAnnotations(tool.annotations as Record<string, unknown> | undefined),
  }));
}

function createTransport(transport: McpResolvedTransportConfig) {
  if (transport.type === 'stdio') {
    const ExperimentalStdioMCPTransport = getExperimentalStdioMCPTransport();

    return new ExperimentalStdioMCPTransport({
      command: transport.command,
      args: transport.args || [],
      env: transport.env,
    });
  }

  return transport;
}

export class McpClientManager {
  private client: MCPClient | null = null;
  private toolDefinitions: ListToolsDefinitions | null = null;

  async connect(
    transport: McpResolvedTransportConfig,
    handshakeTimeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS
  ): Promise<void> {
    this.client = await withTimeout(
      createMCPClient({
        transport: createTransport(transport),
        name: 'lifecycle',
        version: '1.0.0',
        onUncaughtError: (error) => {
          getLogger().warn(`MCP client uncaught error: ${error instanceof Error ? error.message : String(error)}`);
        },
      }),
      handshakeTimeoutMs,
      'MCP client connect'
    );
    this.toolDefinitions = null;
  }

  async listTools(timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS): Promise<McpDiscoveredTool[]> {
    if (!this.client) {
      throw new Error('MCP client not connected. Call connect() first.');
    }

    const definitions = await this.client.listTools({
      options: {
        timeout: timeoutMs,
      },
    });
    this.toolDefinitions = definitions;

    return toMcpDiscoveredTools(definitions);
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<{ content: unknown; isError: boolean }> {
    if (!this.client) {
      throw new Error('MCP client not connected. Call connect() first.');
    }

    const definitions =
      this.toolDefinitions ||
      (await this.client.listTools({
        options: {
          timeout: timeoutMs,
        },
      }));
    this.toolDefinitions = definitions;

    const tools = this.client.toolsFromDefinitions(definitions);
    const tool = tools[toolName] as unknown as {
      execute?: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
    };
    if (!tool?.execute) {
      throw new Error(`MCP tool '${toolName}' not found`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    try {
      const result = await tool.execute(args, { abortSignal: controller.signal });
      return result as { content: unknown; isError: boolean };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Request was aborted')) {
        throw new Error(`MCP tool call '${toolName}' timed out after ${timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.close();
    } catch (error) {
      getLogger().warn(`MCP client close warning: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.client = null;
      this.toolDefinitions = null;
    }
  }
}
