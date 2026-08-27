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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

const mockLoggerInfo = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
const mockMetricsEvent = jest.fn();
const mockMetricsIncrement = jest.fn(() => ({ event: mockMetricsEvent }));

jest.mock('shelljs');
jest.mock('aws-sdk');
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));
jest.mock('server/lib/metrics', () => ({
  Metrics: jest.fn().mockImplementation(() => ({
    increment: (...args: unknown[]) => mockMetricsIncrement(...args),
  })),
}));
jest.mock('server/lib/shell', () => ({
  shellPromise: jest.fn(),
}));
jest.mock('server/lib/utils', () => ({
  waitUntil: jest.fn(),
}));
jest.mock('server/lib/codefresh/utils');
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

import { buildImageOptions } from 'server/lib/codefresh/__fixtures__/codefresh';
import {
  buildImage,
  checkPipelineStatus,
  getRepositoryTag,
  tagExists,
  triggerPipeline,
  waitForImage,
} from 'server/lib/codefresh';
import * as codefreshUtils from 'server/lib/codefresh/utils';
import { Metrics } from 'server/lib/metrics';
import { shellPromise } from 'server/lib/shell';
import { waitUntil } from 'server/lib/utils';
import GlobalConfigService from 'server/services/globalConfig';

const mockShellPromise = shellPromise as jest.MockedFunction<typeof shellPromise>;
const mockWaitUntil = waitUntil as jest.MockedFunction<typeof waitUntil>;
const mockGenerateCodefreshCmd = codefreshUtils.generateCodefreshCmd as jest.MockedFunction<
  typeof codefreshUtils.generateCodefreshCmd
>;
const mockConstructEcrTag = codefreshUtils.constructEcrTag as jest.MockedFunction<
  typeof codefreshUtils.constructEcrTag
>;
const mockGetCodefreshPipelineIdFromOutput = codefreshUtils.getCodefreshPipelineIdFromOutput as jest.MockedFunction<
  typeof codefreshUtils.getCodefreshPipelineIdFromOutput
>;
const mockGetAllConfigs = jest.fn();

const options = { ...buildImageOptions, uuid: 'environment-123' };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllConfigs.mockReset();
  mockShellPromise.mockReset();
  mockWaitUntil.mockReset();
  mockGenerateCodefreshCmd.mockReset();
  mockConstructEcrTag.mockReset();
  mockGetCodefreshPipelineIdFromOutput.mockReset();
  mockMetricsIncrement.mockImplementation(() => ({ event: mockMetricsEvent }));
  (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({ getAllConfigs: mockGetAllConfigs });
});

describe('tagExists', () => {
  it('checks the configured registry and reports an existing custom repository tag', async () => {
    mockGetAllConfigs.mockResolvedValue({
      lifecycleDefaults: { ecrDomain: '123456789012.dkr.ecr.us-west-2.amazonaws.com' },
    });
    mockShellPromise.mockResolvedValue('');

    await expect(tagExists({ tag: 'sha-123', ecrRepo: 'custom-images', uuid: 'environment-123' })).resolves.toBe(true);

    expect(mockShellPromise).toHaveBeenCalledWith(
      'aws ecr describe-images --repository-name=custom-images --image-ids=imageTag=sha-123 --no-paginate --no-cli-auto-prompt --registry-id 123456789012'
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith('ECR: exists tag=sha-123 repo=custom-images');
    expect(mockLoggerDebug).not.toHaveBeenCalled();
  });

  it('uses the default repository and returns false when ECR does not contain the tag', async () => {
    mockGetAllConfigs.mockResolvedValue({ lifecycleDefaults: {} });
    mockShellPromise.mockRejectedValue(new Error('image not found'));

    await expect(tagExists({ tag: 'missing' })).resolves.toBe(false);

    expect(mockShellPromise).toHaveBeenCalledWith(
      'aws ecr describe-images --repository-name=lifecycle-deployments --image-ids=imageTag=missing --no-paginate --no-cli-auto-prompt --registry-id '
    );
    expect(mockLoggerDebug).toHaveBeenCalledWith('ECR: tag=missing not found in lifecycle-deployments');
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('propagates configuration failures before invoking the ECR CLI', async () => {
    const configError = new Error('configuration unavailable');
    mockGetAllConfigs.mockRejectedValue(configError);

    await expect(tagExists({ tag: 'sha-123' })).rejects.toBe(configError);
    expect(mockShellPromise).not.toHaveBeenCalled();
  });
});

describe('buildImage', () => {
  it('builds an image and records the completed pipeline', async () => {
    mockGenerateCodefreshCmd.mockReturnValue('codefresh run command');
    mockShellPromise.mockResolvedValue('Yaml\n672ea2c44b9c09ed7c91a8ef');
    mockGetCodefreshPipelineIdFromOutput.mockReturnValue('672ea2c44b9c09ed7c91a8ef');

    await expect(buildImage(options)).resolves.toBe('672ea2c44b9c09ed7c91a8ef');

    expect(Metrics).toHaveBeenCalledWith('build.codefresh.image', {
      uuid: 'environment-123',
      repositoryName: options.repo,
      branch: options.branch,
      sha: options.revision,
    });
    expect(mockGenerateCodefreshCmd).toHaveBeenCalledWith(options);
    expect(mockShellPromise).toHaveBeenCalledWith('codefresh run command');
    expect(mockGetCodefreshPipelineIdFromOutput).toHaveBeenCalledWith('Yaml\n672ea2c44b9c09ed7c91a8ef');
    expect(mockMetricsIncrement).toHaveBeenCalledWith('total', {
      error: '',
      result: 'complete',
      codefreshBuildId: '672ea2c44b9c09ed7c91a8ef',
    });
    expect(mockMetricsEvent).toHaveBeenCalledWith(
      'Codefresh Build Image',
      'build for environment-123 with latest has finished for test-org/test-repo/main:abc123'
    );
  });

  it('rejects empty CLI output without attempting to parse a pipeline id', async () => {
    mockGenerateCodefreshCmd.mockReturnValue('codefresh run command');
    mockShellPromise.mockResolvedValue('');

    await expect(buildImage(options)).rejects.toThrow('no output from Codefresh');

    expect(mockGetCodefreshPipelineIdFromOutput).not.toHaveBeenCalled();
    expect(mockMetricsIncrement).toHaveBeenCalledWith('total', {
      error: 'error_with_cli_output',
      result: 'error',
      codefreshBuildId: '',
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      { output: '' },
      'Codefresh: build output missing suffix=test-org/test-repo/main:abc123'
    );
  });

  it('retains the current pipeline result when non-empty output omits the Yaml marker', async () => {
    mockGenerateCodefreshCmd.mockReturnValue('codefresh run command');
    mockShellPromise.mockResolvedValue('672ea2c44b9c09ed7c91a8ef');
    mockGetCodefreshPipelineIdFromOutput.mockReturnValue('672ea2c44b9c09ed7c91a8ef');

    await expect(buildImage(options)).resolves.toBe('672ea2c44b9c09ed7c91a8ef');

    expect(mockMetricsIncrement).toHaveBeenNthCalledWith(1, 'total', {
      error: 'error_with_cli_output',
      result: 'error',
      codefreshBuildId: '',
    });
    expect(mockMetricsIncrement).toHaveBeenNthCalledWith(2, 'total', {
      error: '',
      result: 'complete',
      codefreshBuildId: '672ea2c44b9c09ed7c91a8ef',
    });
  });

  it('rejects output that does not yield a pipeline id', async () => {
    mockGenerateCodefreshCmd.mockReturnValue('codefresh run command');
    mockShellPromise.mockResolvedValue('Yaml\nno pipeline id');
    mockGetCodefreshPipelineIdFromOutput.mockReturnValue('');

    await expect(buildImage(options)).rejects.toThrow('no returned from Codefresh');

    expect(mockMetricsIncrement).toHaveBeenCalledWith('total', {
      error: 'error_with_pipeline',
      result: 'error',
      codefreshBuildId: '',
    });
  });

  it('propagates a CLI failure and does not try to parse its output', async () => {
    const cliError = new Error('Codefresh unavailable');
    mockGenerateCodefreshCmd.mockReturnValue('codefresh run command');
    mockShellPromise.mockRejectedValue(cliError);

    await expect(buildImage(options)).rejects.toBe(cliError);

    expect(mockGetCodefreshPipelineIdFromOutput).not.toHaveBeenCalled();
    expect(mockMetricsIncrement).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: cliError },
      'Codefresh: build failed suffix=test-org/test-repo/main:abc123'
    );
  });
});

it('constructs a repository tag through the Codefresh tag formatter', () => {
  mockConstructEcrTag.mockReturnValue('1234567890.dkr.ecr.us-west-2.amazonaws.com/biz:foo');

  expect(
    getRepositoryTag({
      ecrRepo: 'biz',
      tag: 'foo',
      ecrDomain: '1234567890.dkr.ecr.us-west-2.amazonaws.com',
    })
  ).toBe('1234567890.dkr.ecr.us-west-2.amazonaws.com/biz:foo');
  expect(mockConstructEcrTag).toHaveBeenCalledWith({
    ecrDomain: '1234567890.dkr.ecr.us-west-2.amazonaws.com',
    repo: 'biz',
    tag: 'foo',
  });
});

describe('checkPipelineStatus', () => {
  it('waits for a build and reports a successful status', async () => {
    mockShellPromise.mockResolvedValueOnce('').mockResolvedValueOnce('success');

    await expect(checkPipelineStatus('build-123')()).resolves.toBe(true);

    expect(mockShellPromise.mock.calls).toEqual([
      ['codefresh wait build-123'],
      ['codefresh get build build-123 --output json | jq -r ".status"'],
    ]);
  });

  it('reports false for a non-success status', async () => {
    mockShellPromise.mockResolvedValueOnce('').mockResolvedValueOnce('failed');

    await expect(checkPipelineStatus('build-123')()).resolves.toBe(false);
  });

  it('does not request status when waiting for the build fails', async () => {
    const waitError = new Error('wait failed');
    mockShellPromise.mockRejectedValueOnce(waitError);

    await expect(checkPipelineStatus('build-123')()).rejects.toBe(waitError);
    expect(mockShellPromise).toHaveBeenCalledTimes(1);
  });
});

describe('waitForImage', () => {
  it('passes the default polling boundaries to the waiter', async () => {
    mockWaitUntil.mockResolvedValue(true);

    await expect(waitForImage('build-123')).resolves.toBe(true);

    expect(mockWaitUntil).toHaveBeenCalledWith(expect.any(Function), {
      timeoutMs: 180_000,
      intervalMs: 10_000,
    });
    expect(mockShellPromise).not.toHaveBeenCalled();
  });

  it('passes custom polling boundaries to the waiter', async () => {
    mockWaitUntil.mockResolvedValue('ready');

    await expect(waitForImage('build-123', { timeoutMs: 25, intervalMs: 5 })).resolves.toBe('ready');
    expect(mockWaitUntil).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: 25, intervalMs: 5 });
  });

  it('returns false and logs when polling rejects', async () => {
    const pollingError = new Error('polling failed');
    mockWaitUntil.mockRejectedValue(pollingError);

    await expect(waitForImage('build-123')).resolves.toBe(false);

    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: pollingError },
      'Codefresh: waitForImage failed pipelineId=build-123'
    );
  });
});

describe('triggerPipeline', () => {
  it('maps lowercase branch data and returns the parsed build id', async () => {
    mockShellPromise.mockResolvedValue('Codefresh output');
    mockGetCodefreshPipelineIdFromOutput.mockReturnValue('672ea2c44b9c09ed7c91a8ef');

    await expect(triggerPipeline('pipeline', 'webhook', { branch: 'main' })).resolves.toBe('672ea2c44b9c09ed7c91a8ef');
    expect(mockShellPromise).toHaveBeenCalledWith(
      'codefresh run "pipeline" -d -b "main" --trigger "webhook"  -v \'branch\'=\'main\' '
    );
    expect(mockGetCodefreshPipelineIdFromOutput).toHaveBeenCalledWith('Codefresh output');
  });

  it('accepts the uppercase branch variable and forwards every webhook variable', async () => {
    mockShellPromise.mockResolvedValue('Codefresh output');
    mockGetCodefreshPipelineIdFromOutput.mockReturnValue('build-id');

    await expect(triggerPipeline('pipeline', 'webhook', { BRANCH: 'release', SHA: 'abc123' })).resolves.toBe(
      'build-id'
    );
    expect(mockShellPromise).toHaveBeenCalledWith(
      "codefresh run \"pipeline\" -d -b \"release\" --trigger \"webhook\"  -v 'BRANCH'='release'   -v 'SHA'='abc123' "
    );
  });

  it('rejects missing branch data before invoking Codefresh', async () => {
    await expect(triggerPipeline('pipeline', 'webhook', { SHA: 'abc123' })).rejects.toThrow(
      '[triggerPipeline][WEBHOOK pipeline/webhook] webhook error: no "branch" env var.'
    );
    expect(mockShellPromise).not.toHaveBeenCalled();
    expect(mockGetCodefreshPipelineIdFromOutput).not.toHaveBeenCalled();
  });

  it('propagates CLI failures without parsing a build id', async () => {
    const cliError = new Error('Codefresh unavailable');
    mockShellPromise.mockRejectedValue(cliError);

    await expect(triggerPipeline('pipeline', 'webhook', { branch: 'main' })).rejects.toBe(cliError);
    expect(mockGetCodefreshPipelineIdFromOutput).not.toHaveBeenCalled();
  });
});
