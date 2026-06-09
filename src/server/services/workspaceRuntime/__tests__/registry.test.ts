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

const getAllConfigs = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getAllConfigs })),
  },
}));

import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import { assertBackendCapabilities, assertSelectableBackend, listBackends } from '../catalog';
import { OpenSandboxRuntimeService } from '../providers/opensandbox';
import {
  isRemoteWorkspaceBackend,
  resolveRemoteBackendIdForPlan,
  resolveRemoteRuntimeProviderForPlan,
  resolveRemoteRuntimeProviderForSandbox,
} from '../registry';
import { WorkspaceBackendCapabilityError, WorkspaceBackendUnknownError } from '../types';

function buildPlan(provider: 'lifecycle_kubernetes' | 'opensandbox'): WorkspaceRuntimePlan {
  return {
    runtimeConfig: {
      workspaceBackend: {
        provider,
        opensandbox: {
          domain: 'plan.example.test',
          protocol: 'https' as const,
          apiKey: 'plan-key',
          image: 'plan-image:latest',
          timeoutSeconds: 3600,
          useServerProxy: true,
          secureAccess: true,
          resourceLimits: {},
          execdPort: 44772,
          gatewayPort: 13338,
          editorPort: 13337,
        },
      },
    },
  } as unknown as WorkspaceRuntimePlan;
}

beforeEach(() => {
  getAllConfigs.mockReset();
  // Global config selects kubernetes; the opensandbox block stays resolvable for existing rows.
  getAllConfigs.mockResolvedValue({
    agentSessionDefaults: {
      workspaceImage: 'global-workspace:latest',
      workspaceBackend: {
        provider: 'lifecycle_kubernetes',
        opensandbox: {
          domain: 'global.example.test',
          apiKey: 'global-key',
          image: 'global-image:latest',
        },
      },
    },
  });
  delete process.env.AGENT_SESSION_WORKSPACE_BACKEND;
  delete process.env.OPEN_SANDBOX_IMAGE;
  delete process.env.E2B_API_KEY;
  delete process.env.DAYTONA_API_KEY;
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
});

describe('resolveRemoteRuntimeProviderForPlan', () => {
  it('returns null for the native kubernetes backend', () => {
    expect(resolveRemoteRuntimeProviderForPlan(buildPlan('lifecycle_kubernetes'))).toBeNull();
    expect(resolveRemoteBackendIdForPlan(buildPlan('lifecycle_kubernetes'))).toBeNull();
  });

  it('builds the provider from the plan config when the plan selects a remote backend', () => {
    const provider = resolveRemoteRuntimeProviderForPlan(buildPlan('opensandbox'));

    expect(provider).toBeInstanceOf(OpenSandboxRuntimeService);
    expect(provider?.backendId).toBe('opensandbox');
    // Plan-resolved config (not the global block) drives new workspaces.
    expect(
      provider?.resolveGatewayEndpoint({
        sandboxId: 'sb-1',
        lifecycleBaseUrl: 'https://plan.example.test/v1',
        gatewayUrl: 'https://gw.example.test',
      })
    ).toEqual({
      url: 'https://gw.example.test',
      headers: { 'OPEN-SANDBOX-API-KEY': 'plan-key' },
    });
    expect(resolveRemoteBackendIdForPlan(buildPlan('opensandbox'))).toBe('opensandbox');
  });
});

describe('resolveRemoteRuntimeProviderForSandbox', () => {
  it('returns null for kubernetes and missing rows, but raises for an unregistered provider', async () => {
    await expect(resolveRemoteRuntimeProviderForSandbox({ provider: 'lifecycle_kubernetes' })).resolves.toBeNull();
    await expect(resolveRemoteRuntimeProviderForSandbox(null)).resolves.toBeNull();
    // An unknown (non-kubernetes) provider id is a typo/version-skew: fail loudly, never silently route to K8s.
    await expect(resolveRemoteRuntimeProviderForSandbox({ provider: 'unknown-backend' })).rejects.toThrow(
      WorkspaceBackendUnknownError
    );
    expect(getAllConfigs).not.toHaveBeenCalled();
  });

  it("resolves the row's backend from global config even when the active provider differs", async () => {
    // Active provider is kubernetes (see beforeEach); the opensandbox row must stay operable.
    const provider = await resolveRemoteRuntimeProviderForSandbox({ provider: 'opensandbox' });

    expect(provider).toBeInstanceOf(OpenSandboxRuntimeService);
    expect(provider?.backendId).toBe('opensandbox');
    expect(
      provider?.resolveGatewayEndpoint({
        sandboxId: 'sb-1',
        lifecycleBaseUrl: 'https://global.example.test/v1',
        gatewayUrl: 'https://gw.example.test',
      })
    ).toEqual({
      url: 'https://gw.example.test',
      headers: { 'OPEN-SANDBOX-API-KEY': 'global-key' },
    });
  });

  it('prefers an explicitly supplied backend config over global resolution', async () => {
    const provider = await resolveRemoteRuntimeProviderForSandbox(
      { provider: 'opensandbox' },
      {
        backendConfig: buildPlan('opensandbox').runtimeConfig.workspaceBackend,
      }
    );

    expect(provider?.backendId).toBe('opensandbox');
    expect(getAllConfigs).not.toHaveBeenCalled();
  });
});

describe('isRemoteWorkspaceBackend', () => {
  it('flags only backends with a provider implementation', () => {
    expect(isRemoteWorkspaceBackend('opensandbox')).toBe(true);
    expect(isRemoteWorkspaceBackend('lifecycle_kubernetes')).toBe(false);
    expect(isRemoteWorkspaceBackend('e2b')).toBe(true);
    expect(isRemoteWorkspaceBackend('daytona')).toBe(true);
    expect(isRemoteWorkspaceBackend('modal')).toBe(true);
    expect(isRemoteWorkspaceBackend('substrate')).toBe(false);
    expect(isRemoteWorkspaceBackend(null)).toBe(false);
  });
});

describe('catalog', () => {
  it('lists all six backends with computed selectability', async () => {
    const backends = await listBackends();
    const byId = Object.fromEntries(backends.map((entry) => [entry.id, entry]));

    expect(backends).toHaveLength(6);
    expect(byId.lifecycle_kubernetes).toMatchObject({
      status: 'available',
      configured: true,
      selectable: true,
      active: true,
    });
    expect(byId.opensandbox).toMatchObject({
      status: 'available',
      configured: true,
      selectable: true,
      active: false,
    });
    // Available but unconfigured (no credentials/template/snapshot in this config fixture).
    for (const id of ['e2b', 'daytona', 'modal'] as const) {
      expect(byId[id]).toMatchObject({ status: 'available', configured: false, selectable: false, active: false });
    }
    expect(byId.substrate).toMatchObject({
      status: 'coming_soon',
      configured: false,
      selectable: false,
      active: false,
    });
  });

  it('marks modal selectable once both token credentials resolve', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceBackend: {
          provider: 'modal',
          modal: { tokenId: 'ak-1', tokenSecret: 'as-1' },
        },
      },
    });

    const backends = await listBackends();
    const modal = backends.find((entry) => entry.id === 'modal');

    expect(modal).toMatchObject({ status: 'available', configured: true, selectable: true, active: true });
    await expect(assertSelectableBackend('modal')).resolves.toBeUndefined();
  });

  it('keeps modal unconfigured when only one of the two token credentials is set', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceBackend: { modal: { tokenId: 'ak-1' } },
      },
    });

    const backends = await listBackends();
    expect(backends.find((entry) => entry.id === 'modal')).toMatchObject({ configured: false, selectable: false });
  });

  it('marks e2b and daytona selectable once their credentials and image references resolve', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceBackend: {
          provider: 'e2b',
          e2b: { apiKey: 'e2b_key', templateId: 'lifecycle-workspace' },
          daytona: { apiKey: 'dtn_key', snapshot: 'lifecycle-workspace-1.0' },
        },
      },
    });

    const backends = await listBackends();
    const byId = Object.fromEntries(backends.map((entry) => [entry.id, entry]));

    expect(byId.e2b).toMatchObject({ status: 'available', configured: true, selectable: true, active: true });
    expect(byId.daytona).toMatchObject({ status: 'available', configured: true, selectable: true, active: false });
    await expect(assertSelectableBackend('daytona')).resolves.toBeUndefined();
  });

  it('treats env api keys as configured for e2b/daytona only when the image reference is also set', async () => {
    process.env.E2B_API_KEY = 'env-e2b-key';
    process.env.DAYTONA_API_KEY = 'env-daytona-key';
    try {
      getAllConfigs.mockResolvedValue({
        agentSessionDefaults: {
          workspaceBackend: {
            e2b: { templateId: 'lifecycle-workspace' },
            daytona: {},
          },
        },
      });

      const backends = await listBackends();
      const byId = Object.fromEntries(backends.map((entry) => [entry.id, entry]));

      expect(byId.e2b).toMatchObject({ configured: true, selectable: true });
      // No snapshot configured: an env key alone must not make daytona selectable.
      expect(byId.daytona).toMatchObject({ configured: false, selectable: false });
    } finally {
      delete process.env.E2B_API_KEY;
      delete process.env.DAYTONA_API_KEY;
    }
  });

  it('marks opensandbox unconfigured (not selectable) when no image resolves', async () => {
    getAllConfigs.mockResolvedValue({ agentSessionDefaults: {} });

    const backends = await listBackends();
    const opensandbox = backends.find((entry) => entry.id === 'opensandbox');

    expect(opensandbox).toMatchObject({ configured: false, selectable: false });
    await expect(assertSelectableBackend('opensandbox')).rejects.toThrow(
      'The OpenSandbox workspace backend is not configured.'
    );
  });

  it('rejects coming_soon, unconfigured, and unknown backends as selectable', async () => {
    await expect(assertSelectableBackend('substrate')).rejects.toThrow(
      'The Substrate workspace backend is not available yet.'
    );
    await expect(assertSelectableBackend('modal')).rejects.toThrow('The Modal workspace backend is not configured.');
    await expect(assertSelectableBackend('e2b')).rejects.toThrow('The E2B workspace backend is not configured.');
    await expect(assertSelectableBackend('daytona')).rejects.toThrow(
      'The Daytona workspace backend is not configured.'
    );
    await expect(assertSelectableBackend('nope')).rejects.toThrow('Unknown workspace backend: nope');
    await expect(assertSelectableBackend('lifecycle_kubernetes')).resolves.toBeUndefined();
  });

  it('raises a typed capability error carrying the backend and missing capabilities', () => {
    expect(() => assertBackendCapabilities('opensandbox', ['previewPorts'])).not.toThrow();

    let caught: unknown;
    try {
      assertBackendCapabilities('opensandbox', ['environmentSessions', 'developWorkspaces']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkspaceBackendCapabilityError);
    const capabilityError = caught as WorkspaceBackendCapabilityError;
    expect(capabilityError.backendId).toBe('opensandbox');
    expect(capabilityError.missingCapabilities).toEqual(['environmentSessions', 'developWorkspaces']);
    expect(capabilityError.message).toBe(
      'The OpenSandbox workspace backend does not support environment sessions or dev-mode service attachment.'
    );
  });
});
