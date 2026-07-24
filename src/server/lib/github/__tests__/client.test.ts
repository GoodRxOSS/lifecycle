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

import * as client from 'server/lib/github/client';
import * as utils from 'server/lib/github/utils';

jest.mock('server/services/globalConfig', () => {
  return {
    getInstance: jest.fn().mockReturnValue({
      getGithubClientToken: jest.fn().mockResolvedValue('123'),
    }),
  };
});

jest.mock('server/lib/github/utils');

test('createOctokitClient', async () => {
  const result = await client.createOctokitClient();
  expect(result.accessToken).toEqual('123');
});

test('createOctokitClient with accessToken', async () => {
  jest.spyOn(utils, 'getAppToken');
  const result = await client.createOctokitClient({ accessToken: '123' });
  expect(result.accessToken).toEqual('123');
});
