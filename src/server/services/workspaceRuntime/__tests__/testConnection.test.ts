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

const mockResolveBackendConfig = jest.fn();
const mockGetBackendDescriptor = jest.fn();
const mockListBackendDescriptors = jest.fn();
const mockRecordBackendVerification = jest.fn();

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionWorkspaceBackendConfig: (...args: unknown[]) => mockResolveBackendConfig(...args),
}));

jest.mock('../registry', () => ({
  getWorkspaceBackendDescriptor: (...args: unknown[]) => mockGetBackendDescriptor(...args),
  listWorkspaceBackendDescriptors: (...args: unknown[]) => mockListBackendDescriptors(...args),
}));

jest.mock('../verificationState', () => ({
  recordBackendVerification: (...args: unknown[]) => mockRecordBackendVerification(...args),
}));

import type { ResolvedAgentSessionWorkspaceBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import { BadRequestError, NotFoundError } from 'server/lib/appError';
import { runWorkspaceBackendListSources, runWorkspaceBackendTestConnection } from '../testConnection';
import type { WorkspaceBackendDescriptor } from '../types';

const testConfig = {
  provider: 'modal',
  opensandbox: {
    protocol: 'https',
    domain: 'sandbox.example.test',
    apiKey: 'opensandbox-secret',
  },
  e2b: {
    domain: 'e2b.app',
    apiKey: 'e2b-secret',
  },
  daytona: {
    apiUrl: 'https://api.daytona.example.test',
    apiKey: 'daytona-secret',
  },
  modal: {
    tokenId: 'modal-token-id',
    tokenSecret: 'modal-token-secret',
  },
} as unknown as ResolvedAgentSessionWorkspaceBackendConfig;

function buildDescriptor(
  overrides: Partial<WorkspaceBackendDescriptor> & Pick<WorkspaceBackendDescriptor, 'id'>
): WorkspaceBackendDescriptor {
  const { id, ...descriptorOverrides } = overrides;
  return {
    id,
    displayName: id,
    status: 'available',
    declaredCapabilities: {} as WorkspaceBackendDescriptor['declaredCapabilities'],
    secretFields: [],
    isConfigured: () => true,
    ...descriptorOverrides,
  };
}

function useDescriptor(descriptor: WorkspaceBackendDescriptor) {
  mockGetBackendDescriptor.mockReturnValue(descriptor);
  mockListBackendDescriptors.mockReturnValue([descriptor]);
}

describe('workspace backend connection and source probes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveBackendConfig.mockResolvedValue(testConfig);
    mockRecordBackendVerification.mockResolvedValue(undefined);
  });

  it.each([
    ['source listing', runWorkspaceBackendListSources],
    ['connection testing', runWorkspaceBackendTestConnection],
  ])('rejects an unknown backend before resolving config for %s', async (_label, runProbe) => {
    mockGetBackendDescriptor.mockReturnValue(null);

    await expect(runProbe('missing-backend')).rejects.toEqual(
      expect.objectContaining<Partial<NotFoundError>>({
        message: 'Unknown workspace backend: missing-backend',
        code: 'workspace_backend_not_found',
        httpStatus: 404,
      })
    );
    expect(mockResolveBackendConfig).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it.each([
    ['source listing', runWorkspaceBackendListSources],
    ['connection testing', runWorkspaceBackendTestConnection],
  ])('rejects unavailable backends before resolving config for %s', async (_label, runProbe) => {
    useDescriptor(
      buildDescriptor({
        id: 'substrate',
        displayName: 'Substrate',
        status: 'coming_soon',
      })
    );

    await expect(runProbe('substrate')).rejects.toEqual(
      expect.objectContaining<Partial<BadRequestError>>({
        message: 'The Substrate workspace backend is not available yet.',
        httpStatus: 400,
      })
    );
    expect(mockResolveBackendConfig).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it.each([
    ['source listing', runWorkspaceBackendListSources, 'listWorkspaceSources', 'source listing'],
    ['connection testing', runWorkspaceBackendTestConnection, 'testConnection', 'connection tests'],
  ])('rejects a backend without %s support', async (_label, runProbe, unsupportedMethod, messageSuffix) => {
    useDescriptor(
      buildDescriptor({
        id: 'lifecycle_kubernetes',
        displayName: 'Kubernetes',
        [unsupportedMethod]: undefined,
      })
    );

    await expect(runProbe('lifecycle_kubernetes')).rejects.toThrow(
      `The Kubernetes workspace backend does not support ${messageSuffix}.`
    );
    expect(mockResolveBackendConfig).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it('lists sources with resolved config and scrubs backend credentials from returned fields', async () => {
    const listWorkspaceSources = jest.fn().mockResolvedValue([
      {
        id: 'template-1',
        label: 'Template e2b-secret',
        detail: 'Account credential: e2b-secret',
        ready: true,
      },
    ]);
    useDescriptor(
      buildDescriptor({
        id: 'e2b',
        displayName: 'E2B',
        secretFields: ['apiKey'],
        listWorkspaceSources,
      })
    );

    await expect(runWorkspaceBackendListSources('e2b')).resolves.toEqual([
      {
        id: 'template-1',
        label: 'Template [redacted]',
        detail: 'Account credential: [redacted]',
        ready: true,
      },
    ]);
    expect(mockGetBackendDescriptor).toHaveBeenCalledWith('e2b');
    expect(mockResolveBackendConfig).toHaveBeenCalledTimes(1);
    expect(listWorkspaceSources).toHaveBeenCalledWith(testConfig);
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it('propagates source-list config and backend failures without recording a connection verification', async () => {
    const listWorkspaceSources = jest.fn().mockRejectedValue(new Error('source catalog unavailable'));
    useDescriptor(
      buildDescriptor({
        id: 'e2b',
        displayName: 'E2B',
        listWorkspaceSources,
      })
    );
    mockResolveBackendConfig.mockRejectedValueOnce(new Error('stored workspace config is invalid'));

    await expect(runWorkspaceBackendListSources('e2b')).rejects.toThrow('stored workspace config is invalid');
    expect(listWorkspaceSources).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();

    mockResolveBackendConfig.mockResolvedValueOnce(testConfig);
    await expect(runWorkspaceBackendListSources('e2b')).rejects.toThrow('source catalog unavailable');
    expect(listWorkspaceSources).toHaveBeenCalledWith(testConfig);
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it('returns and records a successful scrubbed connection result', async () => {
    const testConnection = jest.fn().mockResolvedValue({
      ok: true,
      message: 'Authenticated with modal-token-secret',
      details: { credential: 'modal-token-secret', latencyMs: 12 },
    });
    useDescriptor(
      buildDescriptor({
        id: 'modal',
        displayName: 'Modal',
        secretFields: ['tokenId', 'tokenSecret'],
        testConnection,
      })
    );

    await expect(runWorkspaceBackendTestConnection('modal')).resolves.toEqual({
      ok: true,
      message: 'Authenticated with [redacted]',
      details: { credential: '[redacted]', latencyMs: 12 },
    });
    expect(testConnection).toHaveBeenCalledWith(testConfig);
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('modal', {
      ok: true,
      kind: 'connection',
    });
  });

  it('returns config resolution failures without calling or recording the backend probe', async () => {
    const testConnection = jest.fn();
    useDescriptor(
      buildDescriptor({
        id: 'modal',
        displayName: 'Modal',
        testConnection,
      })
    );
    mockResolveBackendConfig.mockRejectedValueOnce(new Error('Unable to decrypt workspace credentials'));

    await expect(runWorkspaceBackendTestConnection('modal')).resolves.toEqual({
      ok: false,
      message: 'Unable to decrypt workspace credentials',
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it('records provider-reported connection failures after scrubbing their details', async () => {
    const testConnection = jest.fn().mockResolvedValue({
      ok: false,
      message: 'Rejected credential modal-token-secret',
      details: { reason: 'modal-token-secret is invalid' },
    });
    useDescriptor(
      buildDescriptor({
        id: 'modal',
        displayName: 'Modal',
        secretFields: ['tokenSecret'],
        testConnection,
      })
    );

    await expect(runWorkspaceBackendTestConnection('modal')).resolves.toEqual({
      ok: false,
      message: 'Rejected credential [redacted]',
      details: { reason: '[redacted] is invalid' },
    });
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('modal', {
      ok: false,
      kind: 'connection',
    });
  });

  it('converts a backend timeout into a scrubbed failed result and records it', async () => {
    const testConnection = jest
      .fn()
      .mockRejectedValue(new Error('Connection timed out while using modal-token-secret'));
    useDescriptor(
      buildDescriptor({
        id: 'modal',
        displayName: 'Modal',
        secretFields: ['tokenSecret'],
        testConnection,
      })
    );

    await expect(runWorkspaceBackendTestConnection('modal')).resolves.toEqual({
      ok: false,
      message: 'Connection timed out while using [redacted]',
    });
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('modal', {
      ok: false,
      kind: 'connection',
    });
  });

  it('blocks unsafe configured endpoints before calling or recording the backend probe', async () => {
    const testConnection = jest.fn();
    const unsafeConfig = {
      ...testConfig,
      daytona: { ...testConfig.daytona, apiUrl: 'http://169.254.169.254/latest/meta-data' },
    };
    mockResolveBackendConfig.mockResolvedValueOnce(unsafeConfig);
    useDescriptor(
      buildDescriptor({
        id: 'daytona',
        displayName: 'Daytona',
        secretFields: ['apiKey'],
        testConnection,
      })
    );

    await expect(runWorkspaceBackendTestConnection('daytona')).rejects.toThrow(
      'Refusing to test the daytona backend: the configured endpoint resolves to a link-local/metadata address'
    );
    expect(testConnection).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });
});
