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

import { BadRequestError } from 'server/lib/appError';
import type { ResolvedAgentSessionWorkspaceBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import { listWorkspaceBackendDescriptors } from './registry';
import type { WorkspaceBackendId } from './types';

/** Admin-configurable probe targets per backend (Modal's endpoint is SDK-managed, not configurable). */
function adminConfiguredProbeUrls(
  id: WorkspaceBackendId,
  config: ResolvedAgentSessionWorkspaceBackendConfig
): string[] {
  switch (id) {
    case 'e2b':
      return [`https://api.${config.e2b.domain}`];
    case 'daytona':
      return [config.daytona.apiUrl];
    case 'opensandbox':
      return [`${config.opensandbox.protocol}://${config.opensandbox.domain}`];
    default:
      return [];
  }
}

function isLinkLocalOrMetadataHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'metadata' || host === 'metadata.google.internal') {
    return true;
  }
  const ipv4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipv4)) {
    const [first, second] = ipv4.split('.').map(Number);
    return first === 169 && second === 254;
  }
  return host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
}

// SSRF hardening: an admin-supplied endpoint must never point probes at the cloud metadata service.
export function assertSafeProbeTargets(
  id: WorkspaceBackendId,
  config: ResolvedAgentSessionWorkspaceBackendConfig
): void {
  for (const url of adminConfiguredProbeUrls(id, config)) {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new BadRequestError(`The configured ${id} endpoint URL is not valid: ${url}`);
    }
    if (isLinkLocalOrMetadataHost(hostname)) {
      throw new BadRequestError(
        `Refusing to test the ${id} backend: the configured endpoint resolves to a link-local/metadata address (${hostname}).`
      );
    }
  }
}

export function collectSecretValues(config: ResolvedAgentSessionWorkspaceBackendConfig): string[] {
  const secrets: string[] = [];
  for (const descriptor of listWorkspaceBackendDescriptors()) {
    const block = (config as unknown as Record<string, Record<string, unknown> | undefined>)[descriptor.id];
    for (const field of descriptor.secretFields) {
      const value = block?.[field];
      if (typeof value === 'string' && value) {
        secrets.push(value);
      }
    }
  }
  return secrets;
}

// Belt-and-braces on top of the providers' own scrubbing: no secret ever leaves the probe layer.
export function scrubWorkspaceBackendSecrets<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) {
    return value;
  }
  const scrubbed = secrets.reduce<string>((acc, secret) => acc.split(secret).join('[redacted]'), JSON.stringify(value));
  return JSON.parse(scrubbed) as T;
}
