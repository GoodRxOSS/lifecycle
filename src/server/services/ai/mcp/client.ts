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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getLogger } from 'server/lib/logger';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

export class McpClientManager {
  private client: Client | null = null;

  async connect(
    url: string,
    headers?: Record<string, string>,
    handshakeTimeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS
  ): Promise<void> {
    const parsedUrl = new URL(url);
    const requestInit: RequestInit = headers ? { headers } : {};

    const client = new Client({ name: 'lifecycle', version: '1.0.0' });

    try {
      const transport = new StreamableHTTPClientTransport(parsedUrl, { requestInit });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), handshakeTimeoutMs);
      try {
        await client.connect(transport, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      this.client = client;
      return;
    } catch {
      // StreamableHTTP failed, try SSE
    }

    try {
      const fallbackClient = new Client({ name: 'lifecycle', version: '1.0.0' });
      const transport = new SSEClientTransport(parsedUrl, { requestInit });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), handshakeTimeoutMs);
      try {
        await fallbackClient.connect(transport, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      this.client = fallbackClient;
      return;
    } catch (sseError) {
      throw new Error(
        `MCP connection failed for ${url}: both StreamableHTTP and SSE transports failed. Last error: ${
          sseError instanceof Error ? sseError.message : String(sseError)
        }`
      );
    }
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.client) {
      throw new Error('MCP client not connected. Call connect() first.');
    }

    const tools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of result.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: tool.annotations
            ? {
                readOnlyHint: tool.annotations.readOnlyHint,
                destructiveHint: tool.annotations.destructiveHint,
                openWorldHint: tool.annotations.openWorldHint,
              }
            : undefined,
        });
      }
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const result = await this.client.callTool({ name: toolName, arguments: args }, undefined, {
        signal: controller.signal,
      });
      return { content: result.content, isError: result.isError ?? false };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
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
    }
  }
}
