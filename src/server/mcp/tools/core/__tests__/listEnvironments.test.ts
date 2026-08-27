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

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn(),
}));

import type { McpToolContext } from '../../../contracts';
import { createListEnvironmentsToolDefinition } from '../listEnvironments';

const MockBuildService = jest.requireMock('server/services/build').default as jest.Mock;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

const context: McpToolContext = {
  principal: {
    kind: 'user',
    authMethod: 'oauth',
    userId: 'user-1',
    actor: 'user-1',
    roles: ['user'],
    scopes: null,
    tokenId: null,
    repositoryAllowlist: null,
    repositoryAllowlistRepoIds: null,
    identity: null,
  },
  requestId: 'request-1',
  signal: new AbortController().signal,
  audit: { annotate: jest.fn() },
};

describe('createListEnvironmentsToolDefinition defaults', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it('lazily reuses BuildService and uses the current clock for continuation cursors', async () => {
    const listEnvironments = jest.fn().mockResolvedValue({
      data: [],
      paginationMetadata: { current: 1, total: 2, items: 0, limit: 25 },
    });
    MockBuildService.mockImplementation(() => ({ listEnvironments }));
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);
    const definition = createListEnvironmentsToolDefinition();

    try {
      const first = await definition.handler({}, context);
      const second = await definition.handler({}, context);

      expect(first).toEqual({ environments: [], nextCursor: expect.any(String) });
      expect(second).toEqual({ environments: [], nextCursor: expect.any(String) });
      expect(MockBuildService).toHaveBeenCalledTimes(1);
      expect(listEnvironments).toHaveBeenCalledTimes(2);
      expect(dateNow).toHaveBeenCalledTimes(2);
    } finally {
      dateNow.mockRestore();
    }
  });
});
