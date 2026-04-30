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

import type { McpPreset } from './types';

const MCP_PRESETS: McpPreset[] = [
  {
    key: 'custom-http',
    label: 'Custom HTTP',
    description: 'Generic remote MCP server over Streamable HTTP.',
    transportType: 'http',
    endpointPlaceholder: 'https://mcp.example.com/mcp',
    authConfig: { mode: 'none' },
  },
  {
    key: 'custom-stdio',
    label: 'Custom stdio',
    description: 'Local stdio MCP process launched from a command.',
    transportType: 'stdio',
    commandPlaceholder: 'npx',
    authConfig: { mode: 'none' },
  },
  {
    key: 'stdio-api-token',
    label: 'Stdio API token',
    description: 'Each user provides a single API token exposed as API_TOKEN to a local stdio MCP process.',
    transportType: 'stdio',
    commandPlaceholder: 'npx',
    authConfig: {
      mode: 'user-fields',
      schema: {
        fields: [
          {
            key: 'apiToken',
            label: 'API token',
            description: 'Users paste the token from the provider account.',
            required: true,
            inputType: 'password',
          },
        ],
        bindings: [
          {
            target: 'env',
            key: 'API_TOKEN',
            fieldKey: 'apiToken',
          },
        ],
      },
    },
  },
  {
    key: 'figma-stdio-pat',
    label: 'Figma (PAT)',
    description: 'Each user provides a Figma personal access token for a local stdio MCP process.',
    transportType: 'stdio',
    commandPlaceholder: 'npx',
    authConfig: {
      mode: 'user-fields',
      schema: {
        fields: [
          {
            key: 'figmaToken',
            label: 'Figma personal access token',
            description: 'Users create this token in Figma settings.',
            required: true,
            inputType: 'password',
          },
        ],
        bindings: [
          {
            target: 'env',
            key: 'FIGMA_API_KEY',
            fieldKey: 'figmaToken',
          },
        ],
      },
    },
  },
  {
    key: 'api-token-header',
    label: 'API token header',
    description: 'Each user provides a single API token mapped to a request header.',
    transportType: 'http',
    endpointPlaceholder: 'https://mcp.example.com/mcp',
    authConfig: {
      mode: 'user-fields',
      schema: {
        fields: [
          {
            key: 'apiToken',
            label: 'API token',
            description: 'Users paste the token from the provider account.',
            required: true,
            inputType: 'password',
          },
        ],
        bindings: [
          {
            target: 'header',
            key: 'Authorization',
            fieldKey: 'apiToken',
            format: 'bearer',
          },
        ],
      },
    },
  },
  {
    key: 'basic-auth-http',
    label: 'Basic auth',
    description: 'Each user provides a username and password or token for HTTP Basic auth.',
    transportType: 'http',
    endpointPlaceholder: 'https://mcp.example.com/mcp',
    authConfig: {
      mode: 'user-fields',
      schema: {
        fields: [
          {
            key: 'username',
            label: 'Username',
            description: 'Usually the account username or email.',
            required: true,
            inputType: 'text',
          },
          {
            key: 'password',
            label: 'Password',
            description: 'Use the password or token required by the provider.',
            required: true,
            inputType: 'password',
          },
        ],
        bindings: [
          {
            target: 'header',
            key: 'Authorization',
            format: 'basic',
            usernameFieldKey: 'username',
            passwordFieldKey: 'password',
          },
        ],
      },
    },
  },
  {
    key: 'oauth-http',
    label: 'OAuth 2.1',
    description: 'Each user signs in with OAuth 2.1 for a remote MCP server.',
    transportType: 'http',
    endpointPlaceholder: 'https://mcp.example.com/mcp',
    authConfig: {
      mode: 'oauth',
      provider: 'generic-oauth2.1',
      clientName: 'Lifecycle MCP',
    },
  },
];

export function listMcpPresets(): McpPreset[] {
  return MCP_PRESETS;
}

export function getMcpPreset(key?: string | null): McpPreset | undefined {
  if (!key) {
    return undefined;
  }

  return MCP_PRESETS.find((preset) => preset.key === key);
}
