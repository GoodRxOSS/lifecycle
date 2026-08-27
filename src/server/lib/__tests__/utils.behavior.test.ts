/**
 * Copyright 2025 GoodRx, Inc.
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

export {};

const mockExecFilePromise = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockGetLabels = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
let mockEnvironment = 'production';

jest.mock('child_process', () => {
  const { promisify } = jest.requireActual<typeof import('util')>('util');
  const execFile = jest.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: unknown[]) => mockExecFilePromise(...args),
  });
  return { execFile };
});

jest.mock('shared/config', () => ({
  get ENVIRONMENT() {
    return mockEnvironment;
  },
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
      getLabels: (...args: unknown[]) => mockGetLabels(...args),
    }),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  }),
}));

const {
  delay,
  enableKillSwitch,
  exec,
  flattenObject,
  generateDeployTag,
  getDisabledLabel,
  getKeepLabel,
  getStatusCommentLabel,
  hasStatusCommentLabel,
  isDefaultStatusCommentsEnabled,
  isStaging,
  waitUntil,
} = require('../utils') as typeof import('../utils');

const labelsConfig = (overrides: Record<string, unknown> = {}) => ({
  deploy: ['lifecycle-deploy!'],
  disabled: ['lifecycle-disabled!'],
  keep: ['lifecycle-keep!'],
  statusComments: ['lifecycle-status-comments!'],
  defaultStatusComments: { enabled: true, overrides: {} },
  defaultControlComments: { enabled: true, overrides: {} },
  ...overrides,
});

const ignoreConfig = {
  lifecycleIgnores: {
    github: {
      branches: ['release'],
      events: ['deleted'],
      organizations: ['blocked-org'],
    },
  },
};

describe('utils behavior boundaries', () => {
  beforeEach(() => {
    mockEnvironment = 'production';
    mockExecFilePromise.mockReset();
    mockGetAllConfigs.mockReset().mockResolvedValue(ignoreConfig);
    mockGetLabels.mockReset().mockResolvedValue(labelsConfig());
    mockLoggerError.mockReset();
    mockLoggerWarn.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the default promisified execFile adapter without invoking a real process', async () => {
    mockExecFilePromise.mockResolvedValue({ stdout: 'working tree clean\n', stderr: '' });

    await expect(exec('git', ['status', '--short'])).resolves.toBe('working tree clean\n');

    expect(mockExecFilePromise).toHaveBeenCalledWith('git', ['status', '--short']);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('propagates a condition failure from waitUntil without scheduling another poll', async () => {
    const conditionError = new Error('condition failed');
    const condition = jest.fn().mockRejectedValue(conditionError);
    const setTimeoutFn = jest.fn();

    await expect(
      waitUntil(condition, {
        timeoutMs: 1_000,
        intervalMs: 25,
        setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      })
    ).rejects.toBe(conditionError);

    expect(condition).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  it('flattens own nested properties while excluding inherited and null-valued entries', () => {
    const nested = Object.assign(Object.create({ inheritedNested: 'ignored' }), {
      count: 3,
      deep: { enabled: false },
      nullable: null,
    });
    const input = Object.assign(Object.create({ inheritedRoot: 'ignored' }), {
      name: 'api',
      nested,
    });

    expect(flattenObject(input)).toEqual({
      name: 'api',
      'nested.count': 3,
      'nested.deep.enabled': false,
    });
  });

  it('omits the environment hash suffix when the hash is empty', () => {
    expect(generateDeployTag({ sha: 'abc123', envVarsHash: '' })).toBe('lfc-abc123');
  });

  it('rejects an empty deployment SHA', () => {
    expect(() => generateDeployTag({ sha: '', envVarsHash: 'vars123' })).toThrow(
      '[generateDeployTag]: branch and sha are required'
    );
  });

  it('resolves delay only after the requested duration', async () => {
    jest.useFakeTimers();
    let settled = false;
    const delayed = delay(25).then(() => {
      settled = true;
    });

    await (
      jest as typeof jest & { advanceTimersByTimeAsync(milliseconds: number): Promise<void> }
    ).advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);

    await (
      jest as typeof jest & { advanceTimersByTimeAsync(milliseconds: number): Promise<void> }
    ).advanceTimersByTimeAsync(1);
    await expect(delayed).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('stops a closed pull request before loading ignore configuration', async () => {
    await expect(
      enableKillSwitch({
        action: 'closed',
        branch: 'feature/example',
        fullName: 'allowed-org/repository',
        status: 'closed',
      })
    ).resolves.toBe(true);

    expect(mockGetLabels).not.toHaveBeenCalled();
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
  });

  it('stops a disabled-label request before checking deploy labels or ignore configuration', async () => {
    await expect(
      enableKillSwitch({
        action: 'synchronize',
        branch: 'feature/example',
        fullName: 'allowed-org/repository',
        labels: ['lifecycle-disabled!'],
      })
    ).resolves.toBe(true);

    expect(mockGetLabels).toHaveBeenCalledTimes(1);
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
  });

  it('allows an explicit deploy label before loading ignore configuration', async () => {
    await expect(
      enableKillSwitch({
        action: 'synchronize',
        branch: 'release',
        fullName: 'blocked-org/repository',
        labels: ['lifecycle-deploy!'],
      })
    ).resolves.toBe(false);

    expect(mockGetLabels).toHaveBeenCalledTimes(2);
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
  });

  it('fails open and logs when required kill-switch input is absent', async () => {
    await expect(enableKillSwitch({})).resolves.toBe(false);

    expect(mockGetLabels).not.toHaveBeenCalled();
    expect(mockGetAllConfigs).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Killswitch: error checking fullName= branch= error=Error: missing required configs')
    );
  });

  it('fails open and logs when ignore configuration cannot be loaded', async () => {
    const configError = new Error('config unavailable');
    mockGetAllConfigs.mockRejectedValueOnce(configError);

    await expect(
      enableKillSwitch({
        action: 'synchronize',
        branch: 'feature/example',
        fullName: 'allowed-org/repository',
      })
    ).resolves.toBe(false);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `Killswitch: error checking fullName=allowed-org/repository branch=feature/example error=${configError}`
    );
  });

  it('fails open when optional GitHub ignore configuration is absent', async () => {
    mockGetAllConfigs.mockResolvedValueOnce({ lifecycleIgnores: {} });

    await expect(
      enableKillSwitch({
        action: 'synchronize',
        branch: 'feature/example',
        fullName: 'allowed-org/repository',
      })
    ).resolves.toBe(false);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Killswitch: error checking fullName=allowed-org/repository branch=feature/example error=Error: missing required configs'
      )
    );
  });

  it('reports staging only for the exact staging environment', () => {
    mockEnvironment = 'staging';
    expect(isStaging()).toBe(true);

    mockEnvironment = 'production';
    expect(isStaging()).toBe(false);
  });

  it('skips label configuration for an empty status-label list', async () => {
    await expect(hasStatusCommentLabel([])).resolves.toBe(false);

    expect(mockGetLabels).not.toHaveBeenCalled();
  });

  it('returns the configured keep label and falls back for an empty list', async () => {
    mockGetLabels
      .mockResolvedValueOnce(labelsConfig({ keep: ['preserve-environment'] }))
      .mockResolvedValueOnce(labelsConfig({ keep: [] }));

    await expect(getKeepLabel()).resolves.toBe('preserve-environment');
    await expect(getKeepLabel()).resolves.toBe('lifecycle-keep!');
  });

  it('uses fallback disabled and status-comment labels for empty configured lists', async () => {
    mockGetLabels
      .mockResolvedValueOnce(labelsConfig({ disabled: [] }))
      .mockResolvedValueOnce(labelsConfig({ statusComments: [] }));

    await expect(getDisabledLabel()).resolves.toBe('lifecycle-disabled!');
    await expect(getStatusCommentLabel()).resolves.toBe('lifecycle-status-comments!');
  });

  it('propagates default-status configuration failures to its caller', async () => {
    const configError = new Error('labels unavailable');
    mockGetLabels.mockRejectedValueOnce(configError);

    await expect(isDefaultStatusCommentsEnabled('allowed-org/repository')).rejects.toBe(configError);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('uses the global status-comment toggle when optional overrides are absent', async () => {
    mockGetLabels.mockResolvedValueOnce(
      labelsConfig({
        defaultStatusComments: { enabled: false },
      })
    );

    await expect(isDefaultStatusCommentsEnabled('allowed-org/repository')).resolves.toBe(false);
  });
});
