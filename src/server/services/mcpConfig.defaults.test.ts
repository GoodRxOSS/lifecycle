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

const mockGetConfig = jest.fn();
const mockSetConfig = jest.fn();
const mockInvalidateCache = jest.fn();
const mockInspectEnablement = jest.fn();
const mockEnableMcp = jest.fn();
const mockHasSigningKey = jest.fn();
const mockCreateToolDefinitions = jest.fn();
const mockBuildAdminCatalog = jest.fn();
const mockResolveSitesConfig = jest.fn();
const mockTransaction = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock('./globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getConfig: (...args: unknown[]) => mockGetConfig(...args),
      setConfig: (...args: unknown[]) => mockSetConfig(...args),
      invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
    }),
  },
}));

jest.mock('./mcpEnablement', () => ({
  hasMcpApplicationSigningKey: () => mockHasSigningKey(),
  inspectMcpEnablement: (...args: unknown[]) => mockInspectEnablement(...args),
  enableMcp: (...args: unknown[]) => mockEnableMcp(...args),
  McpEnablementError: class McpEnablementError extends Error {},
}));

jest.mock('server/mcp/tools', () => ({
  createLifecycleMcpToolDefinitions: () => mockCreateToolDefinitions(),
}));

jest.mock('server/mcp/registry', () => ({
  buildMcpAdminCatalog: (...args: unknown[]) => mockBuildAdminCatalog(...args),
}));

jest.mock('server/lib/sites/config', () => ({
  resolveSitesConfig: (...args: unknown[]) => mockResolveSitesConfig(...args),
}));

jest.mock('server/models/AuthAuditEvent', () => ({
  __esModule: true,
  default: {
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

jest.mock('./authAudit', () => ({
  recordAuthAuditEventInTransaction: (...args: unknown[]) => mockRecordAudit(...args),
}));

import McpConfigService from './mcpConfig';

describe('McpConfigService default dependencies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockImplementation(async (key: string) =>
      key === 'mcp' ? { enabled: true, allowChanges: true } : { enabled: true }
    );
    mockSetConfig.mockResolvedValue(undefined);
    mockInvalidateCache.mockResolvedValue(undefined);
    mockInspectEnablement.mockReturnValue({ ok: true, endpoint: 'https://lifecycle.example/mcp' });
    mockEnableMcp.mockResolvedValue({ ok: true, endpoint: 'https://lifecycle.example/mcp' });
    mockHasSigningKey.mockReturnValue(true);
    mockCreateToolDefinitions.mockReturnValue([{ name: 'get_environment' }]);
    mockBuildAdminCatalog.mockReturnValue([{ id: 'understand-environments', tools: [] }]);
    mockResolveSitesConfig.mockReturnValue({ enabled: true });
    mockRecordAudit.mockResolvedValue(undefined);

    const query = {
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ config: { enabled: false, allowChanges: false } }),
    };
    const trx = jest.fn(() => query);
    mockTransaction.mockImplementation((callback) => callback(trx));
  });

  it('uses one singleton and wires the production adapters for reads and updates', async () => {
    const service = McpConfigService.getInstance();
    expect(McpConfigService.getInstance()).toBe(service);

    await expect(service.getRuntimePolicy()).resolves.toEqual({
      enabled: true,
      allowChanges: true,
      sitesAvailable: true,
    });
    await expect(service.getSettings()).resolves.toEqual({
      enabled: true,
      allowChanges: true,
      endpoint: 'https://lifecycle.example/mcp',
      issue: null,
      capabilities: [{ id: 'understand-environments', tools: [] }],
    });

    mockGetConfig.mockImplementation(async (key: string) =>
      key === 'mcp' ? { enabled: false, allowChanges: false } : { enabled: true }
    );
    await service.setConfig({ enabled: true, allowChanges: false }, 'admin-1', 'request-1');

    expect(mockGetConfig).toHaveBeenCalledWith('sites');
    expect(mockResolveSitesConfig).toHaveBeenCalledWith({ enabled: true });
    expect(mockHasSigningKey).toHaveBeenCalled();
    expect(mockInspectEnablement).toHaveBeenCalledWith({ requireChanges: false });
    expect(mockCreateToolDefinitions).toHaveBeenCalled();
    expect(mockBuildAdminCatalog).toHaveBeenCalledWith([{ name: 'get_environment' }], { sitesAvailable: true });
    expect(mockEnableMcp).toHaveBeenCalledWith({ requireChanges: false, requestId: 'request-1' });
    expect(mockSetConfig).toHaveBeenCalledWith('mcp', { enabled: true, allowChanges: false }, expect.any(Function));
    expect(mockRecordAudit).toHaveBeenCalled();
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });
});
