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

import type { OAuthClientProvider, OAuthClientInformation, OAuthTokens } from '@ai-sdk/mcp';

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export type McpTransportConfig =
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export type McpResolvedTransportConfig =
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      authProvider?: OAuthClientProvider;
      redirect?: 'follow' | 'error';
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export type McpCompiledConnectionConfig = {
  headers: Record<string, string>;
  query: Record<string, string>;
  env: Record<string, string>;
  defaultArgs: Record<string, string>;
};

export type McpSharedConnectionConfig = Partial<McpCompiledConnectionConfig>;

export type McpConfigFieldInputType = 'text' | 'password' | 'email' | 'url';

export type McpConfigField = {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  inputType?: McpConfigFieldInputType;
};

export type McpConfigBinding =
  | {
      target: 'header';
      key: string;
      fieldKey: string;
      format?: 'plain' | 'bearer';
    }
  | {
      target: 'header';
      key: string;
      format: 'basic';
      usernameFieldKey: string;
      passwordFieldKey: string;
    }
  | {
      target: 'query';
      key: string;
      fieldKey: string;
    }
  | {
      target: 'env';
      key: string;
      fieldKey: string;
    }
  | {
      target: 'defaultArg';
      key: string;
      fieldKey: string;
    };

export type McpFieldSchema = {
  fields: McpConfigField[];
  bindings: McpConfigBinding[];
};

export type McpOauthAuthConfig = {
  mode: 'oauth';
  provider: 'generic-oauth2.1';
  scope?: string;
  resource?: string;
  clientName?: string;
  instructions?: string;
};

export type McpAuthConfig =
  | { mode: 'none' }
  | {
      mode: 'user-fields';
      schema: McpFieldSchema;
    }
  | {
      mode: 'shared-fields';
      schema: McpFieldSchema;
    }
  | McpOauthAuthConfig;

export type McpPresetField = McpConfigField & {
  target: 'header' | 'query' | 'env' | 'defaultArg';
  targetKey: string;
};

export type McpPreset = {
  key: string;
  label: string;
  description: string;
  transportType: 'http' | 'sse' | 'stdio';
  endpointPlaceholder?: string;
  commandPlaceholder?: string;
  authConfig: McpAuthConfig;
  sharedFields?: McpPresetField[];
};

export interface McpServerConfigRecord {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  scope: string;
  preset: string | null;
  transport: McpTransportConfig;
  sharedConfig: McpSharedConnectionConfig;
  authConfig: McpAuthConfig;
  enabled: boolean;
  timeout: number;
  sharedDiscoveredTools: McpDiscoveredTool[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type CreateMcpServerConfigInput = Pick<McpServerConfigRecord, 'slug' | 'name' | 'scope' | 'transport'> &
  Partial<
    Pick<McpServerConfigRecord, 'description' | 'preset' | 'sharedConfig' | 'authConfig' | 'enabled' | 'timeout'>
  >;

export type UpdateMcpServerConfigInput = Partial<
  Pick<
    McpServerConfigRecord,
    'name' | 'description' | 'preset' | 'transport' | 'sharedConfig' | 'authConfig' | 'enabled' | 'timeout'
  >
>;

export type McpStoredUserConnectionState =
  | {
      type: 'fields';
      values: Record<string, string>;
    }
  | {
      type: 'oauth';
      tokens?: OAuthTokens;
      clientInformation?: OAuthClientInformation;
      codeVerifier?: string;
      oauthState?: string;
    };

export type UserMcpConnectionRecord = {
  id: number;
  userId: string;
  ownerGithubUsername: string;
  scope: string;
  slug: string;
  encryptedState: string;
  definitionFingerprint: string;
  discoveredTools: McpDiscoveredTool[];
  validationError: string | null;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserMcpConnectionState = {
  slug: string;
  scope: string;
  authMode: 'fields' | 'oauth' | 'none';
  configured: boolean;
  stale: boolean;
  configuredFieldKeys: string[];
  validatedAt: string | null;
  validationError: string | null;
  discoveredTools: McpDiscoveredTool[];
  updatedAt: string | null;
};

export type UserMcpConnectionMaskedUser = {
  userId: string;
  ownerGithubUsername: string | null;
  authMode: 'fields' | 'oauth' | 'none';
  stale: boolean;
  configuredFieldKeys: string[];
  discoveredToolCount: number;
  validationError: string | null;
  validatedAt: string | null;
  updatedAt: string | null;
};

export const MCP_ERROR_CODES = {
  CONNECTION: 'MCP_CONNECTION_ERROR',
  TOOL: 'MCP_TOOL_ERROR',
  PROTOCOL: 'MCP_PROTOCOL_ERROR',
} as const;

export interface ResolvedMcpServer {
  slug: string;
  name: string;
  transport: McpResolvedTransportConfig;
  timeout: number;
  defaultArgs: Record<string, string>;
  env: Record<string, string>;
  discoveredTools: McpDiscoveredTool[];
}

export interface AgentMcpConnection {
  slug: string;
  name: string;
  description: string | null;
  scope: string;
  preset: string | null;
  transport: McpTransportConfig;
  sharedConfig: McpSharedConnectionConfig;
  authConfig: McpAuthConfig;
  connectionRequired: boolean;
  configured: boolean;
  stale: boolean;
  configuredFieldKeys: string[];
  validationError: string | null;
  validatedAt: string | null;
  updatedAt: string | null;
  discoveredTools: McpDiscoveredTool[];
  sharedDiscoveredTools: McpDiscoveredTool[];
}
