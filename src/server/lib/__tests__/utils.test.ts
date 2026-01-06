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
  constructEcrRepoPath,
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
        keep: ['lifecycle-keep!'],
        statusComments: ['lifecycle-status-comments!', 'show-status!'],
        defaultStatusComments: true,
        defaultControlComments: true,
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

describe('constructEcrRepoPath', () => {
  test('returns base repo when no service name provided', () => {
    const result = constructEcrRepoPath('my-repo', undefined, '123456789.dkr.ecr.us-west-2.amazonaws.com');
    expect(result).toBe('my-repo');
  });

  test('returns empty string when no base repo and no service name', () => {
    const result = constructEcrRepoPath('', undefined, '123456789.dkr.ecr.us-west-2.amazonaws.com');
    expect(result).toBe('');
  });

  test('returns empty string when null base repo', () => {
    const result = constructEcrRepoPath(null as any, 'my-service', '123456789.dkr.ecr.us-west-2.amazonaws.com');
    expect(result).toBe('');
  });

  test('does not append service name for AWS ECR domains', () => {
    const result = constructEcrRepoPath(
      'my-repo/my-service/lfc',
      'my-service',
      '123456789.dkr.ecr.us-west-2.amazonaws.com'
    );
    expect(result).toBe('my-repo/my-service/lfc');
  });

  test('does not append service name for AWS ECR domains with different regions', () => {
    const result = constructEcrRepoPath('my-repo', 'my-service', '123456789.dkr.ecr.eu-west-1.amazonaws.com');
    expect(result).toBe('my-repo');
  });

  test('does not append service name for AWS ECR FIPS endpoints', () => {
    const result = constructEcrRepoPath('my-repo', 'my-service', '123456789.dkr.ecr-fips.us-east-1.amazonaws.com');
    expect(result).toBe('my-repo');
  });

  test('appends service name for internal registries', () => {
    const result = constructEcrRepoPath('my-repo/my-service/lfc', 'service-name', 'distribution.example.com');
    expect(result).toBe('my-repo/my-service/lfc/service-name');
  });

  test('appends service name for custom registries', () => {
    const result = constructEcrRepoPath('my-org/my-repo', 'my-service', 'registry.internal.company.com');
    expect(result).toBe('my-org/my-repo/my-service');
  });

  test('does not append service name if already present at the end', () => {
    const result = constructEcrRepoPath(
      'my-repo/my-service/lfc/service-name',
      'service-name',
      'distribution.example.com'
    );
    expect(result).toBe('my-repo/my-service/lfc/service-name');
  });

  test('appends service name even if it exists elsewhere in the path', () => {
    const result = constructEcrRepoPath('service-name/repo', 'service-name', 'distribution.example.com');
    expect(result).toBe('service-name/repo/service-name');
  });

  test('handles empty ECR domain gracefully', () => {
    const result = constructEcrRepoPath('my-repo', 'my-service', '');
    expect(result).toBe('my-repo/my-service');
  });

  test('handles undefined ECR domain gracefully', () => {
    const result = constructEcrRepoPath('my-repo', 'my-service', undefined as any);
    expect(result).toBe('my-repo/my-service');
  });

  test('does not append for public ECR', () => {
    const result = constructEcrRepoPath('my-repo', 'my-service', 'public.ecr.aws');
    expect(result).toBe('my-repo');
  });

  test('handles service name with special characters', () => {
    const result = constructEcrRepoPath('my-repo', 'my-service-v2.1', 'distribution.example.com');
    expect(result).toBe('my-repo/my-service-v2.1');
  });

  test('handles base repo with trailing slash', () => {
    const result = constructEcrRepoPath('my-repo/', 'my-service', 'distribution.example.com');
    expect(result).toBe('my-repo//my-service');
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
      keep: ['lifecycle-keep!'],
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
      keep: ['lifecycle-keep!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
      defaultControlComments: true,
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
      keep: ['lifecycle-keep!'],
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
      keep: ['lifecycle-keep!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
      defaultControlComments: true,
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
      keep: ['lifecycle-keep!'],
      statusComments: ['lifecycle-status-comments!'],
    } as any);
    const result = await isDefaultStatusCommentsEnabled();
    expect(result).toBe(true);
  });
});

describe('isControlCommentsEnabled', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns defaultControlComments setting from configuration', async () => {
    const { isControlCommentsEnabled } = await import('../utils');
    const result = await isControlCommentsEnabled();
    expect(result).toBe(true);
    expect(GlobalConfigService.getInstance().getLabels).toHaveBeenCalled();
  });

  test('returns true when defaultControlComments is missing', async () => {
    const { isControlCommentsEnabled } = await import('../utils');
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockResolvedValueOnce({
      deploy: ['lifecycle-deploy!'],
      disabled: ['lifecycle-disabled!'],
      keep: ['lifecycle-keep!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
    } as any);
    const result = await isControlCommentsEnabled();
    expect(result).toBe(true);
  });

  test('returns false when defaultControlComments is explicitly false', async () => {
    const { isControlCommentsEnabled } = await import('../utils');
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockResolvedValueOnce({
      deploy: ['lifecycle-deploy!'],
      disabled: ['lifecycle-disabled!'],
      keep: ['lifecycle-keep!'],
      statusComments: ['lifecycle-status-comments!'],
      defaultStatusComments: true,
      defaultControlComments: false,
    });
    const result = await isControlCommentsEnabled();
    expect(result).toBe(false);
  });

  test('returns true when getLabels throws an error', async () => {
    const { isControlCommentsEnabled } = await import('../utils');
    const mockService = GlobalConfigService.getInstance() as jest.Mocked<GlobalConfigService>;
    mockService.getLabels.mockRejectedValueOnce(new Error('Database error'));
    const result = await isControlCommentsEnabled();
    expect(result).toBe(true);
  });
});
