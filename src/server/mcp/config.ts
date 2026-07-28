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

import { APP_HOST, LIFECYCLE_MODE } from 'shared/config';

export const MCP_PATH = '/mcp';
export const MCP_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
export const MCP_SCOPE = 'mcp';
export const MCP_SCOPES_SUPPORTED = [MCP_SCOPE, 'offline_access'] as const;
export const DEFAULT_MCP_WAIT_SECONDS = 10;
export const MAX_MCP_WAIT_SECONDS = 15;

export interface McpRuntimeConfig {
  authEnabled: boolean;
  maxWaitSeconds: number;
  resourceUrl: string;
}

export function isLoopbackHostname(hostname: string): boolean {
  // Callers pass URL.hostname, which keeps IPv6 brackets.
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}

export function isMcpServingProcess(mode: string | undefined = LIFECYCLE_MODE): boolean {
  return mode === 'web' || mode === 'all';
}

function booleanFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly "true" or "false"`);
}

/** Derive the canonical protected-resource identifier from Lifecycle's public host. */
export function getMcpResourceUrl(appHost = process.env.APP_HOST?.trim() || APP_HOST): string {
  let parsed: URL;
  try {
    parsed = new URL(appHost);
  } catch {
    throw new Error('APP_HOST must be an absolute URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('APP_HOST must be a canonical HTTP(S) URL without credentials, query, or fragment');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error('APP_HOST must use HTTPS unless it is a loopback URL');
  }
  parsed.pathname = MCP_PATH;
  return parsed.toString().replace(/\/$/, '');
}

export function loadMcpRuntimeConfig(): McpRuntimeConfig {
  return {
    authEnabled: booleanFlag('ENABLE_AUTH', false),
    maxWaitSeconds: MAX_MCP_WAIT_SECONDS,
    resourceUrl: getMcpResourceUrl(),
  };
}

export function getMcpResourceMetadataUrl(): string {
  const resource = new URL(getMcpResourceUrl());
  return `${resource.origin}${MCP_PROTECTED_RESOURCE_METADATA_PATH}`;
}

export function isAuthEnabled(): boolean {
  return booleanFlag('ENABLE_AUTH', false);
}

/** RFC 9728 protected-resource metadata. */
export function buildProtectedResourceMetadata(): Record<string, unknown> {
  const issuerValue = process.env.KEYCLOAK_ISSUER?.trim();
  if (!issuerValue) {
    throw new Error('KEYCLOAK_ISSUER is not configured');
  }
  const issuer = new URL(issuerValue);
  if (
    !['http:', 'https:'].includes(issuer.protocol) ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error('KEYCLOAK_ISSUER must be a canonical HTTP(S) URL');
  }
  if (issuer.protocol === 'http:' && !isLoopbackHostname(issuer.hostname)) {
    throw new Error('KEYCLOAK_ISSUER must use HTTPS unless it is a loopback URL');
  }

  return {
    resource: getMcpResourceUrl(),
    authorization_servers: [issuer.toString().replace(/\/$/, '')],
    scopes_supported: [...MCP_SCOPES_SUPPORTED],
    bearer_methods_supported: ['header'],
    resource_name: 'Lifecycle MCP',
  };
}
