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

import type { Transaction } from 'objection';
import type { McpCapabilityId, McpToolAccess, McpToolDefinition } from 'server/mcp/contracts';
import McpConfigService, { exactMcpConfig, normalizeMcpConfig, type McpConfigServiceDependencies } from './mcpConfig';
import { McpEnablementError, type McpEnablementResult } from './mcpEnablement';

const inputSchema = { type: 'object' as const, properties: {}, additionalProperties: false as const };
const outputSchema = { type: 'object' as const, properties: {}, additionalProperties: false as const };

function tool(name: string, capabilityId: McpCapabilityId, access: McpToolAccess): McpToolDefinition {
  return {
    name,
    title: name,
    description: `${name} description`,
    capabilityId,
    access,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: access === 'read' },
    handler: async () => ({}),
  };
}

function ready(): McpEnablementResult {
  return { ok: true, endpoint: 'https://lifecycle.example.test/mcp' };
}

function blocked(): McpEnablementResult {
  return {
    ok: false,
    endpoint: 'https://lifecycle.example.test/mcp',
    issue: {
      code: 'mcp_oauth_not_configured',
      message: 'Configure Lifecycle OAuth before turning on MCP.',
    },
  };
}

function setup(
  initial: unknown = { enabled: false, allowChanges: false },
  options: {
    inspection?: McpEnablementResult;
    enablement?: McpEnablementResult;
    sitesAvailable?: boolean;
    hasApplicationSigningKey?: boolean;
  } = {}
): {
  service: McpConfigService;
  dependencies: McpConfigServiceDependencies;
  readStored: () => unknown;
} {
  let stored = initial;
  const query = {
    where: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    first: jest.fn(async () => ({ config: stored })),
  };
  const trx = Object.assign(
    jest.fn(() => query),
    {}
  ) as unknown as Transaction;
  const globalConfig = {
    getConfig: jest.fn(async (key: string) => (key === 'mcp' ? stored : { enabled: true })),
    setConfig: jest.fn(async (_key: string, value: unknown) => {
      stored = value;
    }),
    invalidateCache: jest.fn(async () => undefined),
  };
  const dependencies: McpConfigServiceDependencies = {
    globalConfig,
    inspectEnablement: jest.fn(() => options.inspection ?? ready()),
    enableMcp: jest.fn(async () => options.enablement ?? ready()),
    loadToolDefinitions: () => [
      tool('get_environment', 'understand-environments', 'read'),
      tool('diagnose_environment', 'diagnose-environments', 'read'),
      tool('deploy_environment', 'manage-environments', 'change'),
      tool('get_site', 'view-hosted-sites', 'read'),
    ],
    loadSitesAvailable: jest.fn(async () => options.sitesAvailable ?? true),
    hasApplicationSigningKey: jest.fn(() => options.hasApplicationSigningKey ?? true),
    transact: jest.fn(async (callback) => callback(trx)),
    recordAudit: jest.fn(async () => undefined),
  };
  return {
    service: new McpConfigService(dependencies),
    dependencies,
    readStored: () => stored,
  };
}

it('normalizes legacy stored config and requires an exact two-boolean update', () => {
  expect(
    normalizeMcpConfig({
      enabled: true,
      allowChanges: true,
      apiKeysEnabled: true,
      diagnosticsEnabled: true,
    })
  ).toEqual({ enabled: true, allowChanges: true });
  expect(normalizeMcpConfig(undefined)).toEqual({ enabled: false, allowChanges: false });
  expect(exactMcpConfig({ enabled: true, allowChanges: false })).toEqual({
    enabled: true,
    allowChanges: false,
  });
  expect(() => exactMcpConfig({ enabled: true, allowChanges: false, extra: true })).toThrow(
    'exactly enabled and allowChanges'
  );
});

it('returns the small local settings view without attempting enablement', async () => {
  const { service, dependencies } = setup();
  const settings = await service.getSettings();

  expect(settings).toEqual(
    expect.objectContaining({
      enabled: false,
      allowChanges: false,
      endpoint: 'https://lifecycle.example.test/mcp',
      issue: null,
    })
  );
  expect(settings.capabilities).toHaveLength(4);
  expect(settings.capabilities.flatMap(({ tools }) => tools)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'get_environment', access: 'read' }),
      expect.objectContaining({ name: 'deploy_environment', access: 'change' }),
    ])
  );
  expect(dependencies.inspectEnablement).toHaveBeenCalledTimes(1);
  expect(dependencies.enableMcp).not.toHaveBeenCalled();
});

it('keeps the catalog stable across enabled and allowChanges state', async () => {
  const disabled = await setup({ enabled: false, allowChanges: false }).service.getSettings();
  const readOnly = await setup({ enabled: true, allowChanges: false }).service.getSettings();
  const changes = await setup({ enabled: true, allowChanges: true }).service.getSettings();

  expect(readOnly.capabilities).toEqual(disabled.capabilities);
  expect(changes.capabilities).toEqual(disabled.capabilities);
});

it('omits the entire Sites capability when Sites is unavailable', async () => {
  const settings = await setup(undefined, { sitesAvailable: false }).service.getSettings();
  expect(settings.capabilities.map(({ id }) => id)).not.toContain('view-hosted-sites');
});

it('does not persist a failed off-to-on transition', async () => {
  const { service, dependencies, readStored } = setup(undefined, { enablement: blocked() });

  await expect(
    service.setConfig({ enabled: true, allowChanges: false }, 'admin-1', 'request-1')
  ).rejects.toBeInstanceOf(McpEnablementError);
  expect(dependencies.globalConfig.setConfig).not.toHaveBeenCalled();
  expect(dependencies.recordAudit).not.toHaveBeenCalled();
  expect(readStored()).toEqual({ enabled: false, allowChanges: false });
});

it('enables before committing config and audit together', async () => {
  const { service, dependencies, readStored } = setup();
  const settings = await service.setConfig({ enabled: true, allowChanges: true }, 'admin-1', 'request-1');

  expect(settings).toEqual(expect.objectContaining({ enabled: true, allowChanges: true }));
  expect(readStored()).toEqual({ enabled: true, allowChanges: true });
  expect(dependencies.enableMcp).toHaveBeenCalledWith({
    requireChanges: true,
    requestId: 'request-1',
  });
  expect(dependencies.recordAudit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      event: 'mcp.config_updated',
      actorId: 'admin-1',
      requestId: 'request-1',
      meta: {
        before: { enabled: false, allowChanges: false },
        after: { enabled: true, allowChanges: true },
      },
    })
  );
});

it.each([
  [
    { enabled: true, allowChanges: true },
    { enabled: false, allowChanges: true },
  ],
  [
    { enabled: true, allowChanges: false },
    { enabled: true, allowChanges: true },
  ],
  [
    { enabled: true, allowChanges: true },
    { enabled: true, allowChanges: false },
  ],
] as const)('keeps non-enable updates local: %j -> %j', async (initial, next) => {
  const { service, dependencies } = setup(initial);
  await service.setConfig(next, 'admin-1', 'request-1');
  expect(dependencies.enableMcp).not.toHaveBeenCalled();
});

it('rejects turning changes on locally when the signing key is missing', async () => {
  const { service, dependencies } = setup({ enabled: true, allowChanges: false }, { hasApplicationSigningKey: false });

  await expect(service.setConfig({ enabled: true, allowChanges: true }, 'admin-1', 'request-1')).rejects.toMatchObject({
    code: 'mcp_change_confirmation_unavailable',
  });
  expect(dependencies.enableMcp).not.toHaveBeenCalled();
  expect(dependencies.globalConfig.setConfig).not.toHaveBeenCalled();
});

it('fails runtime changes closed when the application key disappears', async () => {
  const { service } = setup({ enabled: true, allowChanges: true }, { hasApplicationSigningKey: false });
  await expect(service.getRuntimePolicy()).resolves.toEqual({
    enabled: true,
    allowChanges: false,
    sitesAvailable: true,
  });
});
