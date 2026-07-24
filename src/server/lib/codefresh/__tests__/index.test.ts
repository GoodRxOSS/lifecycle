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

import { buildImageOptions } from 'server/lib/codefresh/__fixtures__/codefresh';
import * as codefresh from 'server/lib/codefresh';

jest.mock('shelljs');

jest.mock('aws-sdk');

jest.mock('server/lib/shell', () => ({
  shellPromise: jest.fn(),
}));
import * as shellUtils from 'server/lib/shell';

jest.mock('server/lib/codefresh/utils');
import * as utils from 'server/lib/codefresh/utils';

describe('buildImage', () => {
  it('builds an image', async () => {
    const generateCodefreshCmdSpy = jest.spyOn(utils, 'generateCodefreshCmd').mockReturnValue('codefreshCmd');
    const shellPromiseSpy = jest.spyOn(shellUtils, 'shellPromise').mockResolvedValue('Yaml\n672ea2c44b9c09ed7c91a8ef');
    const getCodefreshPipelineIdFromOutputSpy = jest
      .spyOn(utils, 'getCodefreshPipelineIdFromOutput')
      .mockReturnValue('672ea2c44b9c09ed7c91a8ef');
    const result = await codefresh.buildImage(buildImageOptions);
    expect(result).toBe('672ea2c44b9c09ed7c91a8ef');
    expect(generateCodefreshCmdSpy).toHaveBeenCalled();
    expect(shellPromiseSpy).toHaveBeenCalledWith('codefreshCmd');
    expect(getCodefreshPipelineIdFromOutputSpy).toHaveBeenCalledWith('Yaml\n672ea2c44b9c09ed7c91a8ef');
  });
});

test('getRepositoryTag', () => {
  const constructEcrTagSpy = jest
    .spyOn(utils, 'constructEcrTag')
    .mockReturnValue('1234567890.dkr.ecr.us-west-2.amazonaws.com');
  const result = codefresh.getRepositoryTag({
    ecrRepo: 'biz',
    tag: 'foo',
    ecrDomain: '1234567890.dkr.ecr.us-west-2.amazonaws.com',
  });
  expect(result).toBe('1234567890.dkr.ecr.us-west-2.amazonaws.com');
  expect(constructEcrTagSpy).toHaveBeenCalledWith({
    ecrDomain: '1234567890.dkr.ecr.us-west-2.amazonaws.com',
    repo: 'biz',
    tag: 'foo',
  });
});

describe('waitForImage', () => {
  it('returns true if image is ready', async () => {
    const shellPromiseSpy = jest
      .spyOn(shellUtils, 'shellPromise')
      .mockResolvedValueOnce('success')
      .mockResolvedValueOnce('success');
    const result = await codefresh.waitForImage('bar', { timeoutMs: 0, intervalMs: 0 });
    expect(result).toBe(true);
    expect(shellPromiseSpy).toHaveBeenCalled();
  });
  it('returns false if shellPromis rejects', async () => {
    const shellPromiseSpy = jest
      .spyOn(shellUtils, 'shellPromise')
      .mockRejectedValueOnce(new Error('shellPromise command failed'));
    const result = await codefresh.waitForImage('bar', { timeoutMs: 0, intervalMs: 0 });
    expect(result).toBe(false);
    expect(shellPromiseSpy).toHaveBeenCalled();
  });
});

describe('triggerPipeline', () => {
  it('triggers a pipeline', async () => {
    const shellPromiseSpy = jest.spyOn(shellUtils, 'shellPromise').mockResolvedValue('672ea2c44b9c09ed7c91a8ef');
    const result = await codefresh.triggerPipeline('foo', 'bar', { branch: 'baz' });
    expect(result).toBe('672ea2c44b9c09ed7c91a8ef');
    expect(shellPromiseSpy).toHaveBeenCalledWith(
      'codefresh run "foo" -d -b "baz" --trigger "bar"  -v \'branch\'=\'baz\' '
    );
  });

  it('throws an error if branch is not provided', async () => {
    await expect(codefresh.triggerPipeline('foo', 'bar', {})).rejects.toThrow(
      '[triggerPipeline][WEBHOOK foo/bar] webhook error: no "branch" env var.'
    );
  });
});
