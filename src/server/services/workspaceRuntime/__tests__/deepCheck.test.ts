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

const mockGetWorkspaceBackendDescriptor = jest.fn();
const mockListWorkspaceBackendDescriptors = jest.fn();
const mockResolveAgentSessionRuntimeConfig = jest.fn();
const mockResolveAgentSessionControlPlaneConfig = jest.fn();
const mockResolveAgentSessionWorkspaceBackendConfig = jest.fn();
const mockRecordBackendVerification = jest.fn();
const mockMcpConnect = jest.fn();
const mockMcpListTools = jest.fn();
const mockMcpClose = jest.fn();
const mockProvision = jest.fn();
const mockDestroy = jest.fn();
const mockResolveGatewayEndpoint = jest.fn();

jest.mock('../registry', () => ({
  getWorkspaceBackendDescriptor: (...args: unknown[]) => mockGetWorkspaceBackendDescriptor(...args),
  listWorkspaceBackendDescriptors: (...args: unknown[]) => mockListWorkspaceBackendDescriptors(...args),
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionRuntimeConfig: (...args: unknown[]) => mockResolveAgentSessionRuntimeConfig(...args),
  resolveAgentSessionControlPlaneConfig: (...args: unknown[]) => mockResolveAgentSessionControlPlaneConfig(...args),
  resolveAgentSessionWorkspaceBackendConfig: (...args: unknown[]) =>
    mockResolveAgentSessionWorkspaceBackendConfig(...args),
}));

jest.mock('../verificationState', () => ({
  recordBackendVerification: (...args: unknown[]) => mockRecordBackendVerification(...args),
}));

jest.mock('server/services/agentRuntime/mcp/client', () => ({
  McpClientManager: jest.fn(() => ({
    connect: (...args: unknown[]) => mockMcpConnect(...args),
    listTools: (...args: unknown[]) => mockMcpListTools(...args),
    close: (...args: unknown[]) => mockMcpClose(...args),
  })),
}));

import { runWorkspaceBackendDeepCheck } from '../deepCheck';
import { REQUIRED_WORKSPACE_GATEWAY_TOOLS } from '../gatewayContract';

function installDescriptor() {
  const descriptor = {
    id: 'fake',
    displayName: 'Fake',
    status: 'available',
    secretFields: [],
    createProvider: jest.fn(() => ({
      provision: (...args: unknown[]) => mockProvision(...args),
      destroy: (...args: unknown[]) => mockDestroy(...args),
      resolveGatewayEndpoint: (...args: unknown[]) => mockResolveGatewayEndpoint(...args),
    })),
  };
  mockGetWorkspaceBackendDescriptor.mockReturnValue(descriptor);
  mockListWorkspaceBackendDescriptors.mockReturnValue([descriptor]);
}

describe('runWorkspaceBackendDeepCheck', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    installDescriptor();
    mockResolveAgentSessionRuntimeConfig.mockResolvedValue({
      readiness: {},
      workspaceBackend: {
        opensandbox: { gatewayPort: 13338 },
        e2b: { gatewayPort: 13338 },
        daytona: { gatewayPort: 13338 },
        modal: { gatewayPort: 13338 },
      },
    });
    mockResolveAgentSessionControlPlaneConfig.mockResolvedValue({
      workspaceToolDiscoveryTimeoutMs: 250,
    });
    mockResolveAgentSessionWorkspaceBackendConfig.mockResolvedValue({
      provider: 'fake',
    });
    mockProvision.mockResolvedValue({
      providerState: { sandboxId: 'sandbox-1' },
      capabilitySnapshot: { editorAccess: true },
    });
    mockDestroy.mockResolvedValue(undefined);
    mockResolveGatewayEndpoint.mockReturnValue({
      url: 'https://gateway.example.test/base/',
      headers: { 'x-provider-token': 'provider-token' },
    });
    mockMcpConnect.mockResolvedValue(undefined);
    mockMcpClose.mockResolvedValue(undefined);
    (global as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fails the gateway tools stage and skips preview probing when required tools are missing', async () => {
    mockMcpListTools.mockResolvedValue(
      REQUIRED_WORKSPACE_GATEWAY_TOOLS.filter((name) => name !== 'workspace.apply_patch').map((name) => ({ name }))
    );

    const result = await runWorkspaceBackendDeepCheck('fake');

    expect(result.ok).toBe(false);
    expect(result.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Provision & gateway', status: 'passed' }),
        expect.objectContaining({
          name: 'Gateway tools',
          status: 'failed',
          detail: expect.stringContaining('workspace.apply_patch'),
        }),
        expect.objectContaining({
          name: 'Gateway preview proxy',
          status: 'skipped',
          detail: 'Gateway tools check failed.',
        }),
      ])
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('fake', { ok: false, kind: 'deep' });
  });

  it('fails the preview proxy stage when authenticated /preview/:port/health does not return the contract status', async () => {
    mockMcpListTools.mockResolvedValue(REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => ({ name })));
    (global as typeof globalThis & { fetch: jest.Mock }).fetch.mockResolvedValueOnce({ status: 404 });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      const result = await runWorkspaceBackendDeepCheck('fake');

      expect(result.ok).toBe(false);
      expect(result.stages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Gateway tools', status: 'passed' }),
          expect.objectContaining({
            name: 'Gateway preview proxy',
            status: 'failed',
            detail: expect.stringContaining('Received HTTP 404'),
          }),
        ])
      );
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15000);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://gateway.example.test/base/preview/13338/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'x-provider-token': 'provider-token',
            'x-lifecycle-gateway-token': expect.any(String),
          }),
        })
      );
      expect(mockRecordBackendVerification).toHaveBeenCalledWith('fake', { ok: false, kind: 'deep' });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
