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

import {
  resolveAgentSessionWorkspaceBackendConfig,
  type ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { getWorkspaceBackendDescriptor, listWorkspaceBackendDescriptors } from './registry';
import { getBackendVerifications, type BackendVerification } from './verificationState';
import {
  WorkspaceBackendCapabilityError,
  type WorkspaceBackendCapabilities,
  type WorkspaceBackendCapabilityKey,
  type WorkspaceBackendDescriptor,
  type WorkspaceBackendId,
  type WorkspaceBackendStatus,
} from './types';

export interface WorkspaceBackendCatalogEntry {
  id: WorkspaceBackendId;
  displayName: string;
  status: WorkspaceBackendStatus;
  capabilities: WorkspaceBackendCapabilities;
  configured: boolean;
  selectable: boolean;
  active: boolean;
  /** Last verification outcome (test-connection or deep check); absent until first verified. */
  lastVerifiedAt?: string;
  lastVerifyOk?: boolean;
  lastVerifyKind?: 'connection' | 'deep';
}

/** Minimum capabilities a backend must declare to be selectable as the global provider. */
const SELECTABLE_CAPABILITY_FLOOR: WorkspaceBackendCapabilityKey[] = ['newChatWorkspaces', 'sandboxSessions'];

const CAPABILITY_LABELS: Record<WorkspaceBackendCapabilityKey, string> = {
  newChatWorkspaces: 'chat workspaces',
  developWorkspaces: 'dev-mode service attachment',
  environmentSessions: 'environment sessions',
  sandboxSessions: 'sandbox sessions',
  editor: 'the workspace editor',
  previewPorts: 'preview ports',
  hibernateResume: 'hibernate/resume',
  prewarm: 'workspace prewarm',
};

function missingCapabilities(
  descriptor: WorkspaceBackendDescriptor,
  required: WorkspaceBackendCapabilityKey[]
): WorkspaceBackendCapabilityKey[] {
  return required.filter((key) => !descriptor.declaredCapabilities[key]?.supported);
}

function buildEntry(
  descriptor: WorkspaceBackendDescriptor,
  config: ResolvedAgentSessionWorkspaceBackendConfig,
  verification?: BackendVerification
): WorkspaceBackendCatalogEntry {
  const configured = descriptor.isConfigured(config);
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    status: descriptor.status,
    capabilities: descriptor.declaredCapabilities,
    configured,
    selectable:
      descriptor.status === 'available' &&
      configured &&
      missingCapabilities(descriptor, SELECTABLE_CAPABILITY_FLOOR).length === 0,
    active: descriptor.id === config.provider,
    ...(verification
      ? { lastVerifiedAt: verification.at, lastVerifyOk: verification.ok, lastVerifyKind: verification.kind }
      : {}),
  };
}

export async function listBackends(
  config?: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<WorkspaceBackendCatalogEntry[]> {
  // Presence-only resolution: catalog flags never require (or fail on) secret decryption.
  const resolved = config ?? (await resolveAgentSessionWorkspaceBackendConfig({ decryptSecrets: false }));
  const verifications = await getBackendVerifications();
  return listWorkspaceBackendDescriptors().map((descriptor) =>
    buildEntry(descriptor, resolved, verifications[descriptor.id])
  );
}

export async function assertSelectableBackend(
  id: string,
  config?: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<void> {
  const descriptor = getWorkspaceBackendDescriptor(id);
  if (!descriptor) {
    throw new Error(`Unknown workspace backend: ${id}`);
  }

  const resolved = config ?? (await resolveAgentSessionWorkspaceBackendConfig({ decryptSecrets: false }));
  const entry = buildEntry(descriptor, resolved);
  if (entry.selectable) {
    return;
  }
  if (descriptor.status !== 'available') {
    throw new Error(`The ${descriptor.displayName} workspace backend is not available yet.`);
  }
  if (!entry.configured) {
    throw new Error(`The ${descriptor.displayName} workspace backend is not configured.`);
  }
  assertBackendCapabilities(descriptor.id, SELECTABLE_CAPABILITY_FLOOR);
}

export function assertBackendCapabilities(id: string, required: WorkspaceBackendCapabilityKey[]): void {
  const descriptor = getWorkspaceBackendDescriptor(id);
  if (!descriptor) {
    throw new Error(`Unknown workspace backend: ${id}`);
  }

  const missing = missingCapabilities(descriptor, required);
  if (missing.length === 0) {
    return;
  }

  const labels = missing.map((key) => CAPABILITY_LABELS[key]).join(' or ');
  throw new WorkspaceBackendCapabilityError(
    descriptor.id,
    missing,
    `The ${descriptor.displayName} workspace backend does not support ${labels}.`
  );
}
