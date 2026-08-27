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

jest.mock('../providers/opensandbox', () => ({
  OPEN_SANDBOX_DECLARED_CAPABILITIES: {},
  createOpenSandboxRuntimeService: jest.fn(),
  testOpenSandboxConnection: jest.fn(),
}));

jest.mock('../providers/e2b', () => ({
  E2B_DECLARED_CAPABILITIES: {},
  createE2bRuntimeService: jest.fn(),
  listE2bWorkspaceSources: jest.fn(),
  testE2bConnection: jest.fn(),
}));

jest.mock('../providers/modal', () => ({
  MODAL_DECLARED_CAPABILITIES: {},
  createModalRuntimeService: jest.fn(),
  testModalConnection: jest.fn(),
}));

jest.mock('../providers/daytona', () => ({
  DAYTONA_DECLARED_CAPABILITIES: {},
  createDaytonaRuntimeService: jest.fn(),
  listDaytonaWorkspaceSources: jest.fn(),
  testDaytonaConnection: jest.fn(),
}));

import type { ResolvedAgentSessionWorkspaceBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import { getWorkspaceBackendDescriptor } from '../registry';

const { testOpenSandboxConnection } = jest.requireMock('../providers/opensandbox') as {
  testOpenSandboxConnection: jest.Mock;
};
const { createE2bRuntimeService, listE2bWorkspaceSources, testE2bConnection } = jest.requireMock(
  '../providers/e2b'
) as {
  createE2bRuntimeService: jest.Mock;
  listE2bWorkspaceSources: jest.Mock;
  testE2bConnection: jest.Mock;
};
const { createModalRuntimeService, testModalConnection } = jest.requireMock('../providers/modal') as {
  createModalRuntimeService: jest.Mock;
  testModalConnection: jest.Mock;
};
const { createDaytonaRuntimeService, listDaytonaWorkspaceSources, testDaytonaConnection } = jest.requireMock(
  '../providers/daytona'
) as {
  createDaytonaRuntimeService: jest.Mock;
  listDaytonaWorkspaceSources: jest.Mock;
  testDaytonaConnection: jest.Mock;
};

const backendConfig = {
  opensandbox: { image: 'workspace:latest' },
  e2b: { apiKey: 'e2b-key', templateId: 'template-1' },
  modal: { tokenId: 'token-id', tokenSecret: 'token-secret', image: 'workspace:latest' },
  daytona: { apiKey: 'daytona-key', snapshot: 'snapshot-1' },
} as ResolvedAgentSessionWorkspaceBackendConfig;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('workspace backend descriptor delegation', () => {
  it('passes the resolved backend config to OpenSandbox connection checks', async () => {
    const result = { ok: true };
    testOpenSandboxConnection.mockResolvedValue(result);

    await expect(getWorkspaceBackendDescriptor('opensandbox')?.testConnection?.(backendConfig)).resolves.toBe(result);
    expect(testOpenSandboxConnection).toHaveBeenCalledWith(backendConfig);
  });

  it('routes E2B connection, source-listing, and provider creation to their correct config scopes', async () => {
    const connectionResult = { ok: true };
    const sources = [{ id: 'template-1' }];
    const provider = { backendId: 'e2b' };
    testE2bConnection.mockResolvedValue(connectionResult);
    listE2bWorkspaceSources.mockResolvedValue(sources);
    createE2bRuntimeService.mockReturnValue(provider);

    const descriptor = getWorkspaceBackendDescriptor('e2b');

    await expect(descriptor?.testConnection?.(backendConfig)).resolves.toBe(connectionResult);
    await expect(descriptor?.listWorkspaceSources?.(backendConfig)).resolves.toBe(sources);
    expect(descriptor?.createProvider?.(backendConfig)).toBe(provider);
    expect(testE2bConnection).toHaveBeenCalledWith(backendConfig);
    expect(listE2bWorkspaceSources).toHaveBeenCalledWith(backendConfig);
    expect(createE2bRuntimeService).toHaveBeenCalledWith(backendConfig.e2b);
  });

  it('routes Modal connection checks and provider creation to their correct config scopes', async () => {
    const connectionResult = { ok: true };
    const provider = { backendId: 'modal' };
    testModalConnection.mockResolvedValue(connectionResult);
    createModalRuntimeService.mockReturnValue(provider);

    const descriptor = getWorkspaceBackendDescriptor('modal');

    await expect(descriptor?.testConnection?.(backendConfig)).resolves.toBe(connectionResult);
    expect(descriptor?.createProvider?.(backendConfig)).toBe(provider);
    expect(testModalConnection).toHaveBeenCalledWith(backendConfig);
    expect(createModalRuntimeService).toHaveBeenCalledWith(backendConfig.modal);
  });

  it('routes Daytona connection, source-listing, and provider creation to their correct config scopes', async () => {
    const connectionResult = { ok: true };
    const sources = [{ id: 'snapshot-1' }];
    const provider = { backendId: 'daytona' };
    testDaytonaConnection.mockResolvedValue(connectionResult);
    listDaytonaWorkspaceSources.mockResolvedValue(sources);
    createDaytonaRuntimeService.mockReturnValue(provider);

    const descriptor = getWorkspaceBackendDescriptor('daytona');

    await expect(descriptor?.testConnection?.(backendConfig)).resolves.toBe(connectionResult);
    await expect(descriptor?.listWorkspaceSources?.(backendConfig)).resolves.toBe(sources);
    expect(descriptor?.createProvider?.(backendConfig)).toBe(provider);
    expect(testDaytonaConnection).toHaveBeenCalledWith(backendConfig);
    expect(listDaytonaWorkspaceSources).toHaveBeenCalledWith(backendConfig);
    expect(createDaytonaRuntimeService).toHaveBeenCalledWith(backendConfig.daytona);
  });
});
