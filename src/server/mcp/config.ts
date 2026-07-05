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

import { LIFECYCLE_MODE } from 'shared/config';

export const MCP_PATH = '/mcp';
export const MCP_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
// RFC 9728 also allows the root well-known location; serve both so clients using either convention succeed.
export const MCP_PROTECTED_RESOURCE_METADATA_ROOT_PATH = '/.well-known/oauth-protected-resource';

// Keycloak has no RFC 8707 resource-indicator support; audience binding is provided by a client
// scope ("mcp") carrying an audience mapper whose value must equal the canonical resource URL.
export const MCP_SCOPE = 'mcp';
// Clients register (DCR) and authorize with exactly this set, so every entry must be an
// assignable realm client scope: Keycloak's registration policy rejects unknown names (incl.
// "openid"), and authorization fails for scopes not assigned to the client. Identity claims
// (username/email/github_username) come from mappers on the `mcp` scope itself, not profile/email.
export const MCP_SCOPES_SUPPORTED = [MCP_SCOPE, 'offline_access'];

export function isMcpServerEnabled(): boolean {
  if (process.env.MCP_SERVER_ENABLED !== 'true') {
    return false;
  }

  // Only web-facing processes serve MCP; job/gateway pods share this entrypoint.
  return LIFECYCLE_MODE !== 'job' && LIFECYCLE_MODE !== 'gateway';
}

/** Canonical MCP resource URL (RFC 8707 style: scheme + host + path, no trailing slash). */
export function getMcpResourceUrl(): string {
  const configured = process.env.MCP_RESOURCE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const port = process.env.PORT || '3000';
  return `http://localhost:${port}${MCP_PATH}`;
}

export function getMcpResourceMetadataUrl(): string {
  const resource = new URL(getMcpResourceUrl());
  return `${resource.origin}${MCP_PROTECTED_RESOURCE_METADATA_PATH}`;
}

export function isAuthEnabled(): boolean {
  return process.env.ENABLE_AUTH === 'true';
}

/** RFC 9728 Protected Resource Metadata document. */
export function buildProtectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: getMcpResourceUrl(),
    authorization_servers: [process.env.KEYCLOAK_ISSUER].filter(Boolean),
    scopes_supported: MCP_SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'Lifecycle MCP',
  };
}
