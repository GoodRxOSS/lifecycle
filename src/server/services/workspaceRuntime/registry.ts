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
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import {
  DAYTONA_DECLARED_CAPABILITIES,
  createDaytonaRuntimeService,
  listDaytonaWorkspaceSources,
  testDaytonaConnection,
} from './providers/daytona';
import {
  E2B_DECLARED_CAPABILITIES,
  createE2bRuntimeService,
  listE2bWorkspaceSources,
  testE2bConnection,
} from './providers/e2b';
import { MODAL_DECLARED_CAPABILITIES, createModalRuntimeService, testModalConnection } from './providers/modal';
import {
  OPEN_SANDBOX_DECLARED_CAPABILITIES,
  createOpenSandboxRuntimeService,
  testOpenSandboxConnection,
} from './providers/opensandbox';
import {
  WORKSPACE_BACKEND_CAPABILITY_KEYS,
  WorkspaceBackendUnknownError,
  type RemoteWorkspaceRuntimeProvider,
  type WorkspaceBackendCapabilities,
  type WorkspaceBackendCapabilityEntry,
  type WorkspaceBackendCapabilityKey,
  type WorkspaceBackendDescriptor,
  type WorkspaceBackendId,
} from './types';

function buildCapabilities(
  supported: Partial<Record<WorkspaceBackendCapabilityKey, boolean | WorkspaceBackendCapabilityEntry>>
): WorkspaceBackendCapabilities {
  return Object.fromEntries(
    WORKSPACE_BACKEND_CAPABILITY_KEYS.map((key) => {
      const value = supported[key] ?? false;
      return [key, typeof value === 'boolean' ? { supported: value } : value];
    })
  ) as WorkspaceBackendCapabilities;
}

type ResolvedBackendConfig = Parameters<WorkspaceBackendDescriptor['isConfigured']>[0];

function missingFieldReporter(
  fields: Record<string, (config: ResolvedBackendConfig) => unknown>
): (config: ResolvedBackendConfig) => string[] {
  return (config) =>
    Object.entries(fields)
      .filter(([, read]) => !read(config))
      .map(([field]) => field);
}

const OPEN_SANDBOX_MISSING_FIELDS = missingFieldReporter({ image: (config) => config.opensandbox.image });
const E2B_MISSING_FIELDS = missingFieldReporter({
  apiKey: (config) => config.e2b?.apiKey,
  templateId: (config) => config.e2b?.templateId,
});
const MODAL_MISSING_FIELDS = missingFieldReporter({
  tokenId: (config) => config.modal?.tokenId,
  tokenSecret: (config) => config.modal?.tokenSecret,
  image: (config) => config.modal?.image,
});
const DAYTONA_MISSING_FIELDS = missingFieldReporter({
  apiKey: (config) => config.daytona?.apiKey,
  snapshot: (config) => config.daytona?.snapshot,
});

const WORKSPACE_BACKEND_DESCRIPTORS: Record<WorkspaceBackendId, WorkspaceBackendDescriptor> = {
  lifecycle_kubernetes: {
    id: 'lifecycle_kubernetes',
    displayName: 'Kubernetes',
    status: 'available',
    declaredCapabilities: buildCapabilities({
      newChatWorkspaces: true,
      developWorkspaces: true,
      environmentSessions: true,
      sandboxSessions: true,
      editor: true,
      previewPorts: true,
      hibernateResume: true,
      prewarm: true,
    }),
    secretFields: [],
    // Native path: provisions with the cluster's own credentials.
    isConfigured: () => true,
  },
  opensandbox: {
    id: 'opensandbox',
    displayName: 'OpenSandbox',
    status: 'available',
    declaredCapabilities: OPEN_SANDBOX_DECLARED_CAPABILITIES,
    secretFields: ['apiKey'],
    isConfigured: (config) => OPEN_SANDBOX_MISSING_FIELDS(config).length === 0,
    missingConfigFields: OPEN_SANDBOX_MISSING_FIELDS,
    testConnection: (config) => testOpenSandboxConnection(config),
    createProvider: (config) => createOpenSandboxRuntimeService(config.opensandbox),
  },
  e2b: {
    id: 'e2b',
    displayName: 'E2B',
    status: 'available',
    declaredCapabilities: E2B_DECLARED_CAPABILITIES,
    secretFields: ['apiKey'],
    isConfigured: (config) => E2B_MISSING_FIELDS(config).length === 0,
    missingConfigFields: E2B_MISSING_FIELDS,
    testConnection: (config) => testE2bConnection(config),
    listWorkspaceSources: (config) => listE2bWorkspaceSources(config),
    createProvider: (config) => createE2bRuntimeService(config.e2b),
  },
  modal: {
    id: 'modal',
    displayName: 'Modal',
    status: 'available',
    declaredCapabilities: MODAL_DECLARED_CAPABILITIES,
    secretFields: ['tokenId', 'tokenSecret'],
    isConfigured: (config) => MODAL_MISSING_FIELDS(config).length === 0,
    missingConfigFields: MODAL_MISSING_FIELDS,
    testConnection: (config) => testModalConnection(config),
    createProvider: (config) => createModalRuntimeService(config.modal),
  },
  daytona: {
    id: 'daytona',
    displayName: 'Daytona',
    status: 'available',
    declaredCapabilities: DAYTONA_DECLARED_CAPABILITIES,
    secretFields: ['apiKey'],
    isConfigured: (config) => DAYTONA_MISSING_FIELDS(config).length === 0,
    missingConfigFields: DAYTONA_MISSING_FIELDS,
    testConnection: (config) => testDaytonaConnection(config),
    listWorkspaceSources: (config) => listDaytonaWorkspaceSources(config),
    createProvider: (config) => createDaytonaRuntimeService(config.daytona),
  },
  substrate: {
    id: 'substrate',
    displayName: 'Substrate',
    status: 'coming_soon',
    declaredCapabilities: buildCapabilities({}),
    secretFields: [],
    isConfigured: () => false,
  },
};

export function getWorkspaceBackendDescriptor(id: string | null | undefined): WorkspaceBackendDescriptor | null {
  return id && Object.prototype.hasOwnProperty.call(WORKSPACE_BACKEND_DESCRIPTORS, id)
    ? WORKSPACE_BACKEND_DESCRIPTORS[id as WorkspaceBackendId]
    : null;
}

export function listWorkspaceBackendDescriptors(): WorkspaceBackendDescriptor[] {
  return Object.values(WORKSPACE_BACKEND_DESCRIPTORS);
}

export function isRemoteWorkspaceBackend(provider: string | null | undefined): boolean {
  return Boolean(getWorkspaceBackendDescriptor(provider)?.createProvider);
}

/** Backend ids that run on a remote provider (have createProvider); for SQL filtering of sandbox rows. */
export function listRemoteWorkspaceBackendIds(): WorkspaceBackendId[] {
  return listWorkspaceBackendDescriptors()
    .filter((descriptor) => descriptor.createProvider)
    .map((descriptor) => descriptor.id);
}

export function resolveRemoteBackendIdForPlan(plan: WorkspaceRuntimePlan): WorkspaceBackendId | null {
  const descriptor = getWorkspaceBackendDescriptor(plan.runtimeConfig.workspaceBackend.provider);
  return descriptor?.createProvider ? descriptor.id : null;
}

/** New workspaces only: the configured provider on the resolved plan decides the backend. */
export function resolveRemoteRuntimeProviderForPlan(plan: WorkspaceRuntimePlan): RemoteWorkspaceRuntimeProvider | null {
  const backendConfig = plan.runtimeConfig.workspaceBackend;
  const descriptor = getWorkspaceBackendDescriptor(backendConfig.provider);
  return descriptor?.createProvider ? descriptor.createProvider(backendConfig) : null;
}

/**
 * Existing-row operations (suspend/resume/destroy/endpoints/leases): the backend comes from the
 * row's provider column and its config block from global config + env fallback, independent of
 * the currently selected provider — flipping the global backend must never strand a sandbox.
 */
export async function resolveRemoteRuntimeProviderForSandbox(
  sandbox: { provider?: string | null } | null | undefined,
  opts: { backendConfig?: ResolvedAgentSessionWorkspaceBackendConfig } = {}
): Promise<RemoteWorkspaceRuntimeProvider | null> {
  const provider = sandbox?.provider;
  const descriptor = getWorkspaceBackendDescriptor(provider);
  if (!descriptor) {
    // null/empty = native K8s (no row or legacy); a non-empty unregistered id is a typo/version-skew —
    // fail loudly instead of silently routing it to the K8s pod path where it dies with pod-not-found.
    if (provider) {
      throw new WorkspaceBackendUnknownError(provider);
    }
    return null;
  }
  if (!descriptor.createProvider) {
    return null;
  }

  const backendConfig = opts.backendConfig ?? (await resolveAgentSessionWorkspaceBackendConfig());
  return descriptor.createProvider(backendConfig);
}
