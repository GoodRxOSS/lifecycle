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

import { BadRequestError, NotFoundError } from 'server/lib/appError';
import {
  resolveAgentSessionWorkspaceBackendConfig,
  type ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { getWorkspaceBackendDescriptor } from './registry';
import { assertSafeProbeTargets, collectSecretValues, scrubWorkspaceBackendSecrets } from './probeSafety';
import { recordBackendVerification } from './verificationState';
import type { WorkspaceBackendTestConnectionResult, WorkspaceSourceOption } from './types';

export async function runWorkspaceBackendListSources(id: string): Promise<WorkspaceSourceOption[]> {
  const descriptor = getWorkspaceBackendDescriptor(id);
  if (!descriptor) {
    throw new NotFoundError(`Unknown workspace backend: ${id}`, 'workspace_backend_not_found');
  }
  if (descriptor.status !== 'available') {
    throw new BadRequestError(`The ${descriptor.displayName} workspace backend is not available yet.`);
  }
  if (!descriptor.listWorkspaceSources) {
    throw new BadRequestError(`The ${descriptor.displayName} workspace backend does not support source listing.`);
  }

  const config = await resolveAgentSessionWorkspaceBackendConfig();
  assertSafeProbeTargets(descriptor.id, config);
  const secrets = collectSecretValues(config);
  return scrubWorkspaceBackendSecrets(await descriptor.listWorkspaceSources(config), secrets);
}

export async function runWorkspaceBackendTestConnection(id: string): Promise<WorkspaceBackendTestConnectionResult> {
  const descriptor = getWorkspaceBackendDescriptor(id);
  if (!descriptor) {
    throw new NotFoundError(`Unknown workspace backend: ${id}`, 'workspace_backend_not_found');
  }
  if (descriptor.status !== 'available') {
    throw new BadRequestError(`The ${descriptor.displayName} workspace backend is not available yet.`);
  }
  if (!descriptor.testConnection) {
    throw new BadRequestError(`The ${descriptor.displayName} workspace backend does not support connection tests.`);
  }

  // Per-call decryption of the merged stored+env config, for the probe only.
  let config: ResolvedAgentSessionWorkspaceBackendConfig;
  try {
    config = await resolveAgentSessionWorkspaceBackendConfig();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  assertSafeProbeTargets(descriptor.id, config);

  const secrets = collectSecretValues(config);
  let result: WorkspaceBackendTestConnectionResult;
  try {
    result = scrubWorkspaceBackendSecrets(await descriptor.testConnection(config), secrets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = scrubWorkspaceBackendSecrets({ ok: false, message }, secrets);
  }
  await recordBackendVerification(descriptor.id, { ok: result.ok, kind: 'connection' });
  return result;
}
