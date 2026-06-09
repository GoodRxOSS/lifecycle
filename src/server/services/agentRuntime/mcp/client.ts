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

import type { MCPClient, MCPTransport } from '@ai-sdk/mcp';
import { getLogger } from 'server/lib/logger';
import { importEsm } from 'server/lib/esmImport';
import type { McpCallToolResult, McpDiscoveredTool, McpResolvedTransportConfig, McpToolAnnotations } from './types';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const REDACTED_MCP_SECRET = '******';
const MIN_SECRET_REDACTION_LENGTH = 4;

type ListToolsDefinitions = Awaited<ReturnType<MCPClient['listTools']>>;
type McpSdkModule = typeof import('@ai-sdk/mcp');
type ExperimentalStdioMCPTransportConstructor = new (config: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}) => MCPTransport;
type ExperimentalStdioMCPModule = {
  Experimental_StdioMCPTransport: ExperimentalStdioMCPTransportConstructor;
};

let mcpSdkPromise: Promise<McpSdkModule> | null = null;

function loadMcpSdk(): Promise<McpSdkModule> {
  mcpSdkPromise ||= importEsm<McpSdkModule>('@ai-sdk/mcp');
  return mcpSdkPromise;
}

async function getExperimentalStdioMCPTransport(): Promise<ExperimentalStdioMCPTransportConstructor> {
  const { Experimental_StdioMCPTransport } = await importEsm<ExperimentalStdioMCPModule>('@ai-sdk/mcp/mcp-stdio');
  return Experimental_StdioMCPTransport;
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
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
    annotations: mapToolAnnotations(tool.annotations as Record<string, unknown> | undefined),
  }));
}

async function createTransport(transport: McpResolvedTransportConfig) {
  if (transport.type === 'stdio') {
    const ExperimentalStdioMCPTransport = await getExperimentalStdioMCPTransport();

    return new ExperimentalStdioMCPTransport({
      command: transport.command,
      args: transport.args || [],
      env: transport.env,
    });
  }

  return transport.redirect === undefined ? { ...transport, redirect: 'follow' as const } : transport;
}

function addSecretValue(secrets: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }

  const secret = value.trim();
  if (secret.length < MIN_SECRET_REDACTION_LENGTH || secret === REDACTED_MCP_SECRET) {
    return;
  }

  secrets.add(secret);
  secrets.add(encodeURIComponent(secret));
  secrets.add(new URLSearchParams({ value: secret }).toString().slice('value='.length));
}

function collectRawQuerySecretValues(url: string, secrets: Set<string>): void {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return;
  }

  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  for (const part of query.split('&')) {
    if (!part) {
      continue;
    }

    const valueStart = part.indexOf('=');
    const rawValue = valueStart === -1 ? '' : part.slice(valueStart + 1);
    if (!rawValue) {
      continue;
    }

    addSecretValue(secrets, rawValue);
    try {
      addSecretValue(secrets, decodeURIComponent(rawValue));
    } catch {
      // Ignore malformed percent-encoding; the raw value is still redacted.
    }
  }
}

function sanitizeTransportErrorMessage(error: unknown, transport: McpResolvedTransportConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = new Set<string>();

  if (transport.type === 'http' || transport.type === 'sse') {
    Object.values(transport.headers || {}).forEach((value) => addSecretValue(secrets, value));
    collectRawQuerySecretValues(transport.url, secrets);
    try {
      new URL(transport.url).searchParams.forEach((value) => addSecretValue(secrets, value));
    } catch {
      // Ignore invalid URLs here; transport validation happens before connection.
    }
  }

  if (transport.type === 'stdio') {
    Object.values(transport.env || {}).forEach((value) => addSecretValue(secrets, value));
  }

  return Array.from(secrets)
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.split(secret).join(REDACTED_MCP_SECRET), message);
}

export class McpClientManager {
  private client: MCPClient | null = null;
  private toolDefinitions: ListToolsDefinitions | null = null;

  async connect(
    transport: McpResolvedTransportConfig,
    handshakeTimeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS
  ): Promise<void> {
    this.client = await withTimeout(
      (async () => {
        const [{ createMCPClient }, resolvedTransport] = await Promise.all([loadMcpSdk(), createTransport(transport)]);
        return createMCPClient({
          transport: resolvedTransport,
          clientName: 'lifecycle',
          version: '1.0.0',
          onUncaughtError: (error) => {
            getLogger().warn(`MCP client uncaught error: ${sanitizeTransportErrorMessage(error, transport)}`);
          },
        });
      })(),
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
  ): Promise<McpCallToolResult> {
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

    if (!definitions.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP tool '${toolName}' not found`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    try {
      const result = await withTimeout(
        this.client.callTool({
          name: toolName,
          arguments: args,
          options: {
            signal: controller.signal,
            timeout: timeoutMs,
          },
        }),
        timeoutMs,
        `MCP tool call '${toolName}'`
      );
      return result as McpCallToolResult;
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
