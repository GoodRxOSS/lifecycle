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

jest.mock('server/services/apiAccessConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

import type { McpToolContext } from '../../../contracts';
import { createGetContextToolDefinition } from '../getContext';

const ApiAccessConfigService = jest.requireMock('server/services/apiAccessConfig').default as {
  getInstance: jest.Mock;
};
const originalAppHost = process.env.APP_HOST;

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

describe('createGetContextToolDefinition defaults', () => {
  beforeAll(() => {
    process.env.APP_HOST = 'http://localhost:3000';
  });

  afterAll(() => {
    if (originalAppHost === undefined) delete process.env.APP_HOST;
    else process.env.APP_HOST = originalAppHost;
  });

  it('loads API-environment and MCP wait policy from the production config seams', async () => {
    const getApiEnvironmentsConfig = jest.fn().mockResolvedValue({
      defaultTtlHours: 72,
      maxTtlHours: 720,
      extensionHours: 24,
    });
    ApiAccessConfigService.getInstance.mockReturnValue({ getApiEnvironmentsConfig });

    const definition = createGetContextToolDefinition();
    const output = await definition.handler({}, context);

    expect(output).toEqual({
      user: { id: 'user-1', displayName: 'user-1' },
      environmentPolicy: { defaultTtlHours: 72, maxTtlHours: 720, extensionHours: 24 },
      limits: { defaultWaitSeconds: 10, maxWaitSeconds: 15 },
    });
    expect(ApiAccessConfigService.getInstance).toHaveBeenCalledTimes(1);
    expect(getApiEnvironmentsConfig).toHaveBeenCalledTimes(1);
  });
});
