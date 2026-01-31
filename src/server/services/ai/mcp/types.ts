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

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpCachedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpServerConfigRecord {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  url: string;
  scope: string;
  headers: Record<string, string>;
  envVars: Record<string, string>;
  enabled: boolean;
  timeout: number;
  cachedTools: McpCachedTool[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type CreateMcpServerConfigInput = Pick<McpServerConfigRecord, 'slug' | 'name' | 'url' | 'scope'> &
  Partial<Pick<McpServerConfigRecord, 'description' | 'headers' | 'envVars' | 'enabled' | 'timeout'>>;

export type UpdateMcpServerConfigInput = Partial<
  Pick<McpServerConfigRecord, 'name' | 'description' | 'url' | 'headers' | 'envVars' | 'enabled' | 'timeout'>
>;

export const MCP_ERROR_CODES = {
  CONNECTION: 'MCP_CONNECTION_ERROR',
  TOOL: 'MCP_TOOL_ERROR',
  PROTOCOL: 'MCP_PROTOCOL_ERROR',
} as const;

export interface ResolvedMcpServer {
  slug: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  envVars: Record<string, string>;
  timeout: number;
  cachedTools: McpCachedTool[];
}
