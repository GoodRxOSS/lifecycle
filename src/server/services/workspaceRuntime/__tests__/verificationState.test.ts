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

jest.mock('server/services/globalConfig', () => {
  const getConfig = jest.fn();
  const setConfig = jest.fn();
  const getInstance = jest.fn(() => ({ getConfig, setConfig }));
  return {
    __esModule: true,
    default: { getInstance },
    configMocks: { getConfig, setConfig, getInstance },
  };
});

jest.mock('server/lib/logger', () => {
  const warn = jest.fn();
  return {
    getLogger: jest.fn(() => ({ warn })),
    loggerMocks: { warn },
  };
});

import { clearBackendVerifications, getBackendVerifications, recordBackendVerification } from '../verificationState';

const { configMocks } = jest.requireMock('server/services/globalConfig') as {
  configMocks: {
    getConfig: jest.Mock;
    setConfig: jest.Mock;
    getInstance: jest.Mock;
  };
};
const { loggerMocks } = jest.requireMock('server/lib/logger') as {
  loggerMocks: { warn: jest.Mock };
};
const mockGetConfig = configMocks.getConfig;
const mockSetConfig = configMocks.setConfig;
const mockGetInstance = configMocks.getInstance;
const mockWarn = loggerMocks.warn;

const CONFIG_KEY = 'workspaceBackendVerifications';

describe('workspace runtime verification state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockResolvedValue(undefined);
    mockSetConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getBackendVerifications', () => {
    it('returns only well-formed verification records from persisted configuration', async () => {
      const connectionVerification = {
        ok: true,
        at: '2026-08-27T12:00:00.000Z',
        kind: 'connection',
      };
      mockGetConfig.mockResolvedValue({
        e2b: connectionVerification,
        modal: null,
        daytona: 'legacy-value',
        opensandbox: { ok: 'yes', at: '2026-08-27T12:00:00.000Z', kind: 'deep' },
        substrate: { ok: false, at: 42, kind: 'connection' },
      });

      await expect(getBackendVerifications()).resolves.toEqual({ e2b: connectionVerification });
      expect(mockGetConfig).toHaveBeenCalledWith(CONFIG_KEY);
      expect(mockSetConfig).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it.each([undefined, 'legacy-value'])('treats a non-map persisted value (%p) as empty', async (raw) => {
      mockGetConfig.mockResolvedValue(raw);

      await expect(getBackendVerifications()).resolves.toEqual({});
      expect(mockSetConfig).not.toHaveBeenCalled();
    });

    it('returns an empty map when the configuration store cannot be read', async () => {
      mockGetConfig.mockRejectedValue(new Error('config unavailable'));

      await expect(getBackendVerifications()).resolves.toEqual({});
      expect(mockSetConfig).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('recordBackendVerification', () => {
    it('merges a verification with existing records and stamps the current time', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-27T13:14:15.000Z'));
      const existing = {
        ok: false,
        at: '2026-08-26T00:00:00.000Z',
        kind: 'deep',
      };
      mockGetConfig.mockResolvedValue({ modal: existing });

      await recordBackendVerification('e2b', { ok: true, kind: 'connection' });

      expect(mockSetConfig).toHaveBeenCalledWith(CONFIG_KEY, {
        modal: existing,
        e2b: {
          ok: true,
          kind: 'connection',
          at: '2026-08-27T13:14:15.000Z',
        },
      });
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('still records the new result when reading existing state fails', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-27T13:14:15.000Z'));
      mockGetConfig.mockRejectedValue(new Error('read failed'));

      await recordBackendVerification('daytona', { ok: false, kind: 'deep' });

      expect(mockSetConfig).toHaveBeenCalledWith(CONFIG_KEY, {
        daytona: {
          ok: false,
          kind: 'deep',
          at: '2026-08-27T13:14:15.000Z',
        },
      });
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('warns without rejecting when persisting the result fails', async () => {
      const error = new Error('write failed');
      mockSetConfig.mockRejectedValue(error);

      await expect(recordBackendVerification('opensandbox', { ok: true, kind: 'connection' })).resolves.toBeUndefined();

      expect(mockWarn).toHaveBeenCalledWith(
        { error, id: 'opensandbox' },
        'Workspace verification state: record failed'
      );
    });
  });

  describe('clearBackendVerifications', () => {
    it('does not read or write configuration for an empty backend list', async () => {
      await clearBackendVerifications([]);

      expect(mockGetInstance).not.toHaveBeenCalled();
      expect(mockGetConfig).not.toHaveBeenCalled();
      expect(mockSetConfig).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('removes stored records for requested backends and preserves all others', async () => {
      const e2b = { ok: true, at: '2026-08-27T12:00:00.000Z', kind: 'connection' };
      const modal = { ok: false, at: '2026-08-27T12:01:00.000Z', kind: 'deep' };
      const daytona = { ok: true, at: '2026-08-27T12:02:00.000Z', kind: 'deep' };
      mockGetConfig.mockResolvedValue({ e2b, modal, daytona });

      await clearBackendVerifications(['e2b', 'substrate', 'modal']);

      expect(mockSetConfig).toHaveBeenCalledTimes(1);
      expect(mockSetConfig).toHaveBeenCalledWith(CONFIG_KEY, { daytona });
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('does not write when none of the requested backends has a stored record', async () => {
      mockGetConfig.mockResolvedValue({
        modal: { ok: true, at: '2026-08-27T12:00:00.000Z', kind: 'connection' },
      });

      await clearBackendVerifications(['e2b', 'daytona']);

      expect(mockSetConfig).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('warns without rejecting when persisting the cleared state fails', async () => {
      const error = new Error('write failed');
      mockGetConfig.mockResolvedValue({
        e2b: { ok: true, at: '2026-08-27T12:00:00.000Z', kind: 'connection' },
      });
      mockSetConfig.mockRejectedValue(error);

      await expect(clearBackendVerifications(['e2b'])).resolves.toBeUndefined();

      expect(mockWarn).toHaveBeenCalledWith({ error, ids: ['e2b'] }, 'Workspace verification state: clear failed');
    });
  });
});
