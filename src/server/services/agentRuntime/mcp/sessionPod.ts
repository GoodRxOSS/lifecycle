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

import type { McpResolvedTransportConfig, ResolvedMcpServer } from './types';

export const SESSION_POD_MCP_CONFIG_ENV = 'LIFECYCLE_SESSION_MCP_CONFIG_JSON';
export const SESSION_POD_MCP_CONFIG_SECRET_KEY = SESSION_POD_MCP_CONFIG_ENV;

export interface SessionWorkspaceGatewayServerConfig {
  slug: string;
  name: string;
  transport: Extract<McpResolvedTransportConfig, { type: 'stdio' }>;
  timeout: number;
}

export function usesSessionWorkspaceGatewayExecution(
  transport: Pick<McpResolvedTransportConfig, 'type'>
): transport is Extract<McpResolvedTransportConfig, { type: 'stdio' }> {
  return transport.type === 'stdio';
}

export function toSessionWorkspaceGatewayServerConfig(
  server: ResolvedMcpServer
): SessionWorkspaceGatewayServerConfig | null {
  if (!usesSessionWorkspaceGatewayExecution(server.transport)) {
    return null;
  }

  return {
    slug: server.slug,
    name: server.name,
    transport: server.transport,
    timeout: server.timeout,
  };
}

export function serializeSessionWorkspaceGatewayServers(servers: ResolvedMcpServer[]): string {
  return JSON.stringify(
    servers
      .map((server) => toSessionWorkspaceGatewayServerConfig(server))
      .filter((server): server is SessionWorkspaceGatewayServerConfig => Boolean(server))
  );
}
