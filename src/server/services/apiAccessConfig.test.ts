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
const mockRecordInTx = jest.fn();

jest.mock('./globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGetConfig(...args),
      setConfig: (...args: unknown[]) => mockSetConfig(...args),
      invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
    })),
  },
}));
jest.mock('./authAudit', () => ({
  __esModule: true,
  recordAuthAuditEventInTransaction: (...args: unknown[]) => mockRecordInTx(...args),
}));
jest.mock('server/models/AuthAuditEvent');

import AuthAuditEvent from 'server/models/AuthAuditEvent';
import ApiAccessConfigService, { DEFAULT_API_ENVIRONMENTS_CONFIG, DEFAULT_API_KEYS_CONFIG } from './apiAccessConfig';

const TRX = { __trx: true } as any;

describe('ApiAccessConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetConfig.mockResolvedValue(undefined);
    mockInvalidateCache.mockResolvedValue(undefined);
    mockRecordInTx.mockResolvedValue(undefined);
    (AuthAuditEvent.transaction as jest.Mock) = jest.fn(async (cb: any) => cb(TRX));
  });

  it('falls back to fail-closed defaults when the api_keys row is missing', async () => {
    mockGetConfig.mockResolvedValue(undefined);

    const config = await ApiAccessConfigService.getInstance().getApiKeysConfig();

    expect(config).toEqual(DEFAULT_API_KEYS_CONFIG);
    expect(config.issuanceEnabled).toBe(false);
  });

  it('normalizes malformed api_keys values to defaults', async () => {
    mockGetConfig.mockResolvedValue({
      issuanceEnabled: 'yes',
      personalAuthEnabled: true,
      rateLimitPerMinute: -5,
      maxActivePersonalKeysPerUser: 'many',
    });

    const config = await ApiAccessConfigService.getInstance().getApiKeysConfig();

    expect(config).toEqual({
      issuanceEnabled: false,
      personalAuthEnabled: true,
      serviceAuthEnabled: false,
      rateLimitPerMinute: DEFAULT_API_KEYS_CONFIG.rateLimitPerMinute,
      maxActivePersonalKeysPerUser: DEFAULT_API_KEYS_CONFIG.maxActivePersonalKeysPerUser,
    });
  });

  it('writes the normalized api_keys row and its audit row in one transaction', async () => {
    mockGetConfig.mockResolvedValue(undefined);
    const next = {
      issuanceEnabled: true,
      personalAuthEnabled: true,
      serviceAuthEnabled: true,
      rateLimitPerMinute: 120,
      maxActivePersonalKeysPerUser: 3,
    };

    const config = await ApiAccessConfigService.getInstance().setApiKeysConfig(next, 'admin-1');

    expect(config).toEqual(next);
    expect(mockSetConfig).toHaveBeenCalledWith('api_keys', next, TRX);
    expect(mockRecordInTx).toHaveBeenCalledWith(TRX, {
      event: 'api_keys.config_updated',
      principalKind: 'user',
      principalId: 'admin-1',
      actorId: 'admin-1',
      outcome: 'updated',
      meta: { before: DEFAULT_API_KEYS_CONFIG, after: next },
    });
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCache.mock.invocationCallOrder[0]).toBeGreaterThan(
      (AuthAuditEvent.transaction as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it('propagates an audit-insert failure so the api_keys write aborts with it', async () => {
    mockGetConfig.mockResolvedValue(undefined);
    mockRecordInTx.mockRejectedValueOnce(new Error('audit boom'));

    await expect(
      ApiAccessConfigService.getInstance().setApiKeysConfig({ issuanceEnabled: true }, 'admin-1')
    ).rejects.toThrow('audit boom');
    expect(mockInvalidateCache).not.toHaveBeenCalled();
  });

  it('fails the config update response closed when post-commit cache invalidation fails', async () => {
    mockGetConfig.mockResolvedValue(undefined);
    mockInvalidateCache.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      ApiAccessConfigService.getInstance().setApiKeysConfig({ personalAuthEnabled: false }, 'admin-1')
    ).rejects.toThrow('redis unavailable');

    expect(AuthAuditEvent.transaction).toHaveBeenCalledTimes(1);
    expect(mockSetConfig).toHaveBeenCalledWith(
      'api_keys',
      expect.objectContaining({ personalAuthEnabled: false }),
      TRX
    );
  });

  it('does not invalidate the shared cache until the config and audit transaction commits', async () => {
    mockGetConfig.mockResolvedValue(undefined);
    let finishCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    (AuthAuditEvent.transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
      await cb(TRX);
      await commitGate;
    });

    const update = ApiAccessConfigService.getInstance().setApiKeysConfig({ personalAuthEnabled: false }, 'admin-1');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockSetConfig).toHaveBeenCalled();
    expect(mockRecordInTx).toHaveBeenCalled();
    expect(mockInvalidateCache).not.toHaveBeenCalled();

    finishCommit();
    await update;

    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });

  it('falls back to disabled defaults when the api_environments row is missing', async () => {
    mockGetConfig.mockResolvedValue(undefined);

    const config = await ApiAccessConfigService.getInstance().getApiEnvironmentsConfig();

    expect(config).toEqual(DEFAULT_API_ENVIRONMENTS_CONFIG);
    expect(config.enabled).toBe(false);
  });

  it('writes the normalized api_environments row and its audit row in one transaction', async () => {
    mockGetConfig.mockResolvedValue(undefined);
    const next = { enabled: true, defaultTtlHours: 48, maxTtlHours: 168, extensionHours: 12 };

    const config = await ApiAccessConfigService.getInstance().setApiEnvironmentsConfig(next, 'admin-2');

    expect(config).toEqual(next);
    expect(mockSetConfig).toHaveBeenCalledWith('api_environments', next, TRX);
    expect(mockRecordInTx).toHaveBeenCalledWith(TRX, {
      event: 'api_environments.config_updated',
      principalKind: 'user',
      principalId: 'admin-2',
      actorId: 'admin-2',
      outcome: 'updated',
      meta: { before: DEFAULT_API_ENVIRONMENTS_CONFIG, after: next },
    });
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });
});
