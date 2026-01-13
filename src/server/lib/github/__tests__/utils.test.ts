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

import { getAppToken, constructOctokitClient, getRefForBranchName } from 'server/lib/github/utils';
import * as client from 'server/lib/github/client';

jest.mock('server/services/globalConfig', () => {
  const RedisMock = {
    hgetall: jest.fn(),
    hset: jest.fn(),
    expire: jest.fn(),
  };
  return {
    getInstance: jest.fn(() => ({
      redis: RedisMock,
    })),
  };
});

jest.mock('server/lib/github/client');

jest.mock('server/lib/rootLogger');

import logger from 'server/lib/rootLogger';

test('getAppToken success', async () => {
  const app = jest.fn().mockResolvedValue({ token: '123' });
  const result = await getAppToken({ installationId: 123, app });
  expect(result).toEqual('123');
});

test('getAppToken failure', async () => {
  const mockError = new Error('error');
  const app = jest.fn().mockRejectedValue(mockError);
  await expect(getAppToken({ installationId: 123, app, logger })).rejects.toThrow('error');
});

test('getRefForBranchName success', async () => {
  jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
    request: jest.fn().mockResolvedValue({ data: 'foo' }),
  });
  const result = await getRefForBranchName('foo', 'bar', 'main', 1, logger);
  expect(result.data).toEqual('foo');
});

test('constructOctokitClient', () => {
  const result = constructOctokitClient({ token: '123' });
  expect(result.request).toBeDefined();
  expect(result.auth).toBeDefined();
  expect(result.log).toBeDefined();
  expect(result.hook).toBeDefined();
});
