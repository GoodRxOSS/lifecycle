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

import type { OAuthClientProvider } from '@ai-sdk/mcp';
import objectHash from 'object-hash';
import type {
  McpAuthConfig,
  McpCompiledConnectionConfig,
  McpConfigBinding,
  McpConfigField,
  McpConfigFieldInputType,
  McpFieldSchema,
  McpResolvedTransportConfig,
  McpSharedConnectionConfig,
  McpTransportConfig,
} from './types';

type NormalizedValues = Record<string, string>;

const VALID_FIELD_INPUT_TYPES: McpConfigFieldInputType[] = ['text', 'password', 'email', 'url'];

function normalizeStringRecord(input: Record<string, string> | undefined | null): Record<string, string> {
  if (!input) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0)
  );
}

function normalizeFieldInputType(input: unknown): McpConfigFieldInputType | undefined {
  return typeof input === 'string' && VALID_FIELD_INPUT_TYPES.includes(input as McpConfigFieldInputType)
    ? (input as McpConfigFieldInputType)
    : undefined;
}

function normalizeField(field: unknown): McpConfigField | null {
  if (!field || typeof field !== 'object') {
    return null;
  }

  const candidate = field as Record<string, unknown>;
  if (typeof candidate.key !== 'string' || typeof candidate.label !== 'string') {
    return null;
  }

  const normalized: McpConfigField = {
    key: candidate.key.trim(),
    label: candidate.label.trim(),
  };

  if (typeof candidate.description === 'string') {
    normalized.description = candidate.description.trim();
  }
  if (typeof candidate.placeholder === 'string') {
    normalized.placeholder = candidate.placeholder.trim();
  }
  if (candidate.required === true) {
    normalized.required = true;
  }

  const inputType = normalizeFieldInputType(candidate.inputType);
  if (inputType) {
    normalized.inputType = inputType;
  }

  return normalized.key.length > 0 && normalized.label.length > 0 ? normalized : null;
}

function normalizeBinding(binding: unknown): McpConfigBinding | null {
  if (!binding || typeof binding !== 'object') {
    return null;
  }

  const candidate = binding as Record<string, unknown>;
  if (candidate.target === 'header') {
    if (
      candidate.format === 'basic' &&
      typeof candidate.key === 'string' &&
      typeof candidate.usernameFieldKey === 'string' &&
      typeof candidate.passwordFieldKey === 'string'
    ) {
      return {
        target: 'header',
        key: candidate.key.trim(),
        format: 'basic',
        usernameFieldKey: candidate.usernameFieldKey.trim(),
        passwordFieldKey: candidate.passwordFieldKey.trim(),
      };
    }

    if (typeof candidate.key === 'string' && typeof candidate.fieldKey === 'string') {
      return {
        target: 'header',
        key: candidate.key.trim(),
        fieldKey: candidate.fieldKey.trim(),
        format: candidate.format === 'bearer' ? 'bearer' : 'plain',
      };
    }
  }

  if (
    (candidate.target === 'query' || candidate.target === 'env' || candidate.target === 'defaultArg') &&
    typeof candidate.key === 'string' &&
    typeof candidate.fieldKey === 'string'
  ) {
    return {
      target: candidate.target,
      key: candidate.key.trim(),
      fieldKey: candidate.fieldKey.trim(),
    };
  }

  return null;
}

export function normalizeUserConnectionValues(input: unknown): NormalizedValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  return normalizeStringRecord(
    Object.fromEntries(
      Object.entries(input).filter((entry): entry is [string, string] => {
        return typeof entry[0] === 'string' && typeof entry[1] === 'string';
      })
    )
  );
}

export function normalizeFieldSchema(input: unknown): McpFieldSchema {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { fields: [], bindings: [] };
  }

  const raw = input as { fields?: unknown; bindings?: unknown };
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map(normalizeField).filter((field): field is McpConfigField => field != null)
    : [];
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings.map(normalizeBinding).filter((binding): binding is McpConfigBinding => binding != null)
    : [];

  return { fields, bindings };
}

export function normalizeAuthConfig(input: unknown): McpAuthConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { mode: 'none' };
  }

  const raw = input as Record<string, unknown>;
  switch (raw.mode) {
    case 'user-fields':
      return {
        mode: 'user-fields',
        schema: normalizeFieldSchema(raw.schema),
      };
    case 'shared-fields':
      return {
        mode: 'shared-fields',
        schema: normalizeFieldSchema(raw.schema),
      };
    case 'oauth':
      return {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
        scope: typeof raw.scope === 'string' ? raw.scope.trim() : undefined,
        resource: typeof raw.resource === 'string' ? raw.resource.trim() : undefined,
        clientName: typeof raw.clientName === 'string' ? raw.clientName.trim() : undefined,
        instructions: typeof raw.instructions === 'string' ? raw.instructions.trim() : undefined,
      };
    case 'none':
    default:
      return { mode: 'none' };
  }
}

export function normalizeSharedConnectionConfig(input: unknown): McpSharedConnectionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const raw = input as Partial<McpSharedConnectionConfig>;
  return {
    headers: normalizeStringRecord(raw.headers),
    query: normalizeStringRecord(raw.query),
    env: normalizeStringRecord(raw.env),
    defaultArgs: normalizeStringRecord(raw.defaultArgs),
  };
}

export function normalizeTransportConfig(input: unknown): McpTransportConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MCP transport is required');
  }

  const raw = input as Record<string, unknown>;
  if (raw.type === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
      throw new Error('MCP stdio transport requires a command');
    }

    return {
      type: 'stdio',
      command: raw.command.trim(),
      args: Array.isArray(raw.args)
        ? raw.args.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
      env: normalizeStringRecord(
        raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
          ? (raw.env as Record<string, string>)
          : undefined
      ),
    };
  }

  if ((raw.type === 'http' || raw.type === 'sse') && typeof raw.url === 'string' && raw.url.trim().length > 0) {
    return {
      type: raw.type,
      url: raw.url.trim(),
      headers: normalizeStringRecord(
        raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
          ? (raw.headers as Record<string, string>)
          : undefined
      ),
    };
  }

  throw new Error('MCP transport must be a valid http, sse, or stdio configuration');
}

export function getFieldSchema(authConfig: McpAuthConfig | undefined): McpFieldSchema | undefined {
  if (!authConfig) {
    return undefined;
  }

  if (authConfig.mode === 'user-fields' || authConfig.mode === 'shared-fields') {
    return authConfig.schema;
  }

  return undefined;
}

export function requiresUserConnection(authConfig: McpAuthConfig | undefined): boolean {
  return authConfig?.mode === 'user-fields' || authConfig?.mode === 'oauth';
}

export function getAuthMode(authConfig: McpAuthConfig | undefined): 'fields' | 'oauth' | 'none' {
  if (authConfig?.mode === 'user-fields' || authConfig?.mode === 'shared-fields') {
    return 'fields';
  }

  if (authConfig?.mode === 'oauth') {
    return 'oauth';
  }

  return 'none';
}

export function validateFieldConnectionValues(schema: McpFieldSchema, values: NormalizedValues): void {
  const knownKeys = new Set(schema.fields.map((field) => field.key));

  for (const key of Object.keys(values)) {
    if (!knownKeys.has(key)) {
      throw new Error(`Unknown MCP connection field '${key}'`);
    }
  }

  for (const field of schema.fields) {
    if (field.required && !values[field.key]) {
      throw new Error(`Missing required MCP connection field '${field.label}'`);
    }
  }

  for (const binding of schema.bindings) {
    if ('fieldKey' in binding && !knownKeys.has(binding.fieldKey)) {
      throw new Error(`MCP binding references unknown field '${binding.fieldKey}'`);
    }

    if ('usernameFieldKey' in binding && !knownKeys.has(binding.usernameFieldKey)) {
      throw new Error(`MCP binding references unknown field '${binding.usernameFieldKey}'`);
    }

    if ('passwordFieldKey' in binding && !knownKeys.has(binding.passwordFieldKey)) {
      throw new Error(`MCP binding references unknown field '${binding.passwordFieldKey}'`);
    }
  }
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export function compileFieldConnectionConfig(
  schema: McpFieldSchema,
  values: NormalizedValues
): McpCompiledConnectionConfig {
  validateFieldConnectionValues(schema, values);

  const compiled: McpCompiledConnectionConfig = {
    headers: {},
    query: {},
    env: {},
    defaultArgs: {},
  };

  for (const binding of schema.bindings) {
    if (binding.target === 'header') {
      if (binding.format === 'basic') {
        const username = values[binding.usernameFieldKey];
        const password = values[binding.passwordFieldKey];
        if (username && password) {
          compiled.headers[binding.key] = basicAuthHeader(username, password);
        }
        continue;
      }

      const value = values[binding.fieldKey];
      if (!value) {
        continue;
      }

      compiled.headers[binding.key] = binding.format === 'bearer' ? `Bearer ${value}` : value;
      continue;
    }

    const value = values[binding.fieldKey];
    if (!value) {
      continue;
    }

    if (binding.target === 'query') {
      compiled.query[binding.key] = value;
      continue;
    }

    if (binding.target === 'env') {
      compiled.env[binding.key] = value;
      continue;
    }

    compiled.defaultArgs[binding.key] = value;
  }

  return compiled;
}

export function mergeCompiledConnectionConfig(
  sharedConfig: McpSharedConnectionConfig | undefined,
  userConfig: McpCompiledConnectionConfig | undefined
): McpCompiledConnectionConfig {
  return {
    headers: {
      ...(sharedConfig?.headers || {}),
      ...(userConfig?.headers || {}),
    },
    query: {
      ...(sharedConfig?.query || {}),
      ...(userConfig?.query || {}),
    },
    env: {
      ...(sharedConfig?.env || {}),
      ...(userConfig?.env || {}),
    },
    defaultArgs: {
      ...(sharedConfig?.defaultArgs || {}),
      ...(userConfig?.defaultArgs || {}),
    },
  };
}

export function applyCompiledQueryParams(url: string, query: Record<string, string> | undefined): string {
  if (!query || Object.keys(query).length === 0) {
    return url;
  }

  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    parsed.searchParams.set(key, value);
  }

  return parsed.toString();
}

export function applyCompiledConnectionConfigToTransport(
  transport: McpTransportConfig,
  config: McpCompiledConnectionConfig | undefined,
  options: {
    authProvider?: OAuthClientProvider;
  } = {}
): McpResolvedTransportConfig {
  if (transport.type === 'http' || transport.type === 'sse') {
    return {
      ...transport,
      url: applyCompiledQueryParams(transport.url, config?.query),
      headers: {
        ...(transport.headers || {}),
        ...(config?.headers || {}),
      },
      ...(options.authProvider ? { authProvider: options.authProvider } : {}),
    };
  }

  return {
    ...transport,
    env: {
      ...(transport.env || {}),
      ...(config?.env || {}),
    },
  };
}

export function buildMcpDefinitionFingerprint({
  preset,
  transport,
  sharedConfig,
  authConfig,
}: {
  preset?: string | null;
  transport: McpTransportConfig;
  sharedConfig: McpSharedConnectionConfig | undefined;
  authConfig: McpAuthConfig | undefined;
}): string {
  return objectHash(
    {
      preset: preset || null,
      transport: normalizeTransportConfig(transport),
      sharedConfig: normalizeSharedConnectionConfig(sharedConfig),
      authConfig: normalizeAuthConfig(authConfig),
    },
    { unorderedObjects: true, unorderedArrays: false, algorithm: 'sha1' }
  );
}
