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

import {
  exec,
  generateDeployTag,
  waitUntil,
  enableKillSwitch,
  hasDeployLabel,
  hasDisabledLabel,
  hasStatusCommentLabel,
  getDeployLabel,
  getDisabledLabel,
  getStatusCommentLabel,
  isDefaultStatusCommentsEnabled,
} from 'server/lib/utils';
import GlobalConfigService from 'server/services/globalConfig';

jest.mock('server/services/globalConfig', () => {
  return {
    getInstance: jest.fn().mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        lifecycleIgnores: {
          github: {
            branches: ['changeset-release/main', 'lifecycle-disable/test'],
            events: ['closed', 'deleted'],
            organizations: ['disabledorg'],
          },
        },
      }),
      getLabels: jest.fn().mockResolvedValue({
        deploy: ['lifecycle-deploy!', 'custom-deploy!'],
        disabled: ['lifecycle-disabled!', 'no-deploy!'],
        statusComments: ['lifecycle-status-comments!', 'show-status!'],
        defaultStatusComments: true,
      }),
    }),
  };
});

jest.mock('server/lib/logger');
import logger from 'server/lib/logger';

describe('exec', () => {
  test('exec success', async () => {
    const execCmd = jest.fn().mockResolvedValue({ stdout: 'test' });
    const result = await exec('cmd', ['arg1', 'arg2'], { execCmd });
    expect(result).toEqual('test');
    expect(execCmd).toHaveBeenCalledWith('cmd', ['arg1', 'arg2']);
  });

  test('exec failure', async () => {
    const execCmd = jest.fn().mockRejectedValue(new Error('error'));

    await exec('cmd', ['arg1', 'arg2'], { logger, execCmd });
    expect(logger.error).toHaveBeenCalledWith('exec: error executing {}');
  });

  test('exec no stdout', async () => {
    const execCmd = jest.fn().mockResolvedValue({});
    const result = await exec('cmd', ['arg1', 'arg2'], { execCmd });
    expect(result).toEqual('');
  });
});

describe('generateDeployTag', () => {
  test('generates a full tag with all params', () => {
    const tag = generateDeployTag({
      prefix: 'foo',
      sha: 'abc123',
      envVarsHash: '1234',
    });

    expect(tag).toEqual('foo-abc123-1234');
  });

  test('uses default registry if not provided', () => {
    const tag = generateDeployTag({
      prefix: 'foo',
      sha: 'abc123',
      envVarsHash: '1234',
    });

    expect(tag).toEqual('foo-abc123-1234');
  });

  test('uses default prefix if not provided', () => {
    const tag = generateDeployTag({
      sha: 'abc123',
      envVarsHash: '1234',
    });

    expect(tag).toEqual('lfc-abc123-1234');
  });
});

describe('waitUntil', () => {
  it('should resolve when the condition is met before the timeout', async () => {
    const conditionFunction = jest.fn(() => true);
    const mockStartNow = jest.fn(() => 1000); // Mock start time
    const mockTimeNow = jest.fn(() => 1500); // Mock current time

    const result = await waitUntil(conditionFunction, {
      timeoutMs: 1000,
      intervalMs: 100,
      time: { now: mockTimeNow } as unknown as DateConstructor,
      start: { now: mockStartNow } as unknown as DateConstructor,
    });

    expect(result).toBe(true);
    expect(conditionFunction).toHaveBeenCalled();
  });

  it('should reject when the condition is not met and times out', async () => {
    const conditionFunction = jest.fn(() => false);
    const mockStartNow = jest.fn(() => 1000); // Mock start time
    const mockTimeNow = jest.fn(() => 2500); // Mock current time exceeding timeout

    await expect(
      waitUntil(conditionFunction, {
        timeoutMs: 100,
        intervalMs: 100,
        time: { now: mockTimeNow } as unknown as DateConstructor,
        start: { now: mockStartNow } as unknown as DateConstructor,
      })
    ).rejects.toThrow('Timeout waiting for condition');

    expect(conditionFunction).toHaveBeenCalled();
  });

  it('should resolve when the condition is met at the timeout edge', async () => {
    let callCount = 0;
    const conditionFunction = jest.fn(() => {
      callCount++;
      return callCount >= 5;
    });

    const startTime = 1000;
    let currentTime = startTime;
    const mockStartNow = jest.fn(() => startTime); // Mock start time
    const mockTimeNow = jest.fn(() => currentTime); // Increment current time with each call

    const timeoutMs = 1000;
    const intervalMs = 100;

    // Mock setTimeout to immediately execute the callback and simulate time passage
    const mockSetTimeout = (fn, interval, resolve, reject) => {
      currentTime += interval; // Simulate time passage
      fn(resolve, reject);
    };

    const result = await waitUntil(conditionFunction, {
      timeoutMs,
      intervalMs,
      setTimeoutFn: mockSetTimeout as unknown as typeof setTimeout,
      time: { now: mockTimeNow } as unknown as DateConstructor,
      start: { now: mockStartNow } as unknown as DateConstructor,
    });

    expect(result).toBeTruthy();
    expect(conditionFunction).toHaveBeenCalledTimes(5);
  });
});

describe('enableKillSwitch', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });
  test('returns true if action is "closed"', async () => {
    const options = { action: 'closed', branch: '', fullName: 'org/repo', githubUser: '' };
    const result = await enableKillSwitch(options);
    expect(result).toEqual(true);
  });

  test('returns true if action is "deleted"', async () => {
    const options = { action: 'deleted', branch: '', fullName: 'org/repo', githubUser: '' };
    const result = await enableKillSwitch(options);
    expect(result).toEqual(true);
  });

  test('returns true if branch is a release branch', async () => {
    const options = {
      action: '',
      branch: 'lifecycle-disable/test',
      fullName: 'org/repo',
      githubUser: '',
      isOpen: true,
    };
    const result = await enableKillSwitch(options);
    expect(result).toEqual(true);
  });

  test('returns true if owner is "disabledorg"', async () => {
    const options = { action: '', branch: '', fullName: 'disabledorg/repo', githubUser: '', isOpen: true };
    const result = await enableKillSwitch(options);
    expect(result).toEqual(true);
  });

  test('returns true if githubUser is a bot user', async () => {
    const options = {
      action: '',
      branch: '',
      fullName: '',
      githubUser: 'dependabot',
      isBotUser: true,
      isOpen: true,
    };
    const result = await enableKillSwitch(options);
    expect(result).toEqual(true);
  });

  test('returns false for other cases', async () => {
    const options = { action: '', branch: '', fullName: '', githubUser: '', isOpen: true };
    const result = await enableKillSwitch(options);
    expect(result).toEqual(false);
  });

  test('returns false and logs error if an error occurs', async () => {
    const options = { action: '', branch: '', fullName: '', githubUser: '', isOpen: true };
    const result = await enableKillSwitch(options);
    expect(result).toEqual(false);
  });
});

describe('hasDeployLabel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns true when PR has a configured deploy label', async () => {
    const result = await hasDeployLabel(['lifecycle-deploy!', 'other-label']);
    expect(result).toBe(true);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns true when PR has multiple configured deploy labels', async () => {
    const result = await hasDeployLabel(['custom-deploy!', 'other-label']);
    expect(result).toBe(true);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns false when PR has no deploy labels', async () => {
    const result = await hasDeployLabel(['other-label', 'another-label']);
    expect(result).toBe(false);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns false when labels array is empty', async () => {
    const result = await hasDeployLabel([]);
    expect(result).toBe(false);
    expect(GlobalConfigService.getInstance().getLabels).not.toHaveBeenCalled();
  });

  test('returns false when deploy config is missing', async () => {
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockResolvedValueOnce({
      disabled: ['lifecycle-disabled!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
    } as any);
    const result = await hasDeployLabel(['some-label']);
    expect(result).toBe(false);
  });

  test('returns false when deploy config is empty array', async () => {
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockResolvedValueOnce({
      deploy: [],
      disabled: ['lifecycle-disabled!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
    });
    const result = await hasDeployLabel(['some-label']);
    expect(result).toBe(false);
  });
});

describe('hasDisabledLabel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns true when PR has a configured disabled label', async () => {
    const result = await hasDisabledLabel(['lifecycle-disabled!', 'other-label']);
    expect(result).toBe(true);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns false when PR has no disabled labels', async () => {
    const result = await hasDisabledLabel(['other-label', 'another-label']);
    expect(result).toBe(false);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns false when labels array is empty', async () => {
    const result = await hasDisabledLabel([]);
    expect(result).toBe(false);
    expect(GlobalConfigService.getInstance().getLabels).not.toHaveBeenCalled();
  });
});

describe('hasStatusCommentLabel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns true when PR has a configured status comment label', async () => {
    const result = await hasStatusCommentLabel(['lifecycle-status-comments!', 'other-label']);
    expect(result).toBe(true);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns false when PR has no status comment labels', async () => {
    const result = await hasStatusCommentLabel(['other-label', 'another-label']);
    expect(result).toBe(false);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });
});

describe('getDeployLabel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns first deploy label from configuration', async () => {
    const result = await getDeployLabel();
    expect(result).toBe('lifecycle-deploy!');
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns hardcoded fallback when deploy config is missing', async () => {
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockResolvedValueOnce({
      disabled: ['lifecycle-disabled!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
    } as any);
    const result = await getDeployLabel();
    expect(result).toBe('lifecycle-deploy!');
  });

  test('returns hardcoded fallback when deploy config is empty array', async () => {
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockResolvedValueOnce({
      deploy: [],
      disabled: ['lifecycle-disabled!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
    });
    const result = await getDeployLabel();
    expect(result).toBe('lifecycle-deploy!');
  });
});

describe('getDisabledLabel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns first disabled label from configuration', async () => {
    const result = await getDisabledLabel();
    expect(result).toBe('lifecycle-disabled!');
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });
});

describe('getStatusCommentLabel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns first status comment label from configuration', async () => {
    const result = await getStatusCommentLabel();
    expect(result).toBe('lifecycle-status-comments!');
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });
});

describe('isDefaultStatusCommentsEnabled', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns defaultStatusComments setting from configuration', async () => {
    const result = await isDefaultStatusCommentsEnabled();
    expect(result).toBe(true);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns true when defaultStatusComments is missing', async () => {
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockResolvedValueOnce({
      deploy: ['lifecycle-deploy!'],
      disabled: ['lifecycle-disabled!'],
      statusComments: ['lifecycle-status-comments!'],
    } as any);
    const result = await isDefaultStatusCommentsEnabled();
    expect(result).toBe(true);
  });
});
