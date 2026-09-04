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

import { NextRequest } from 'next/server';

const mockGetEffectiveConfig = jest.fn();

jest.mock('server/lib/createApiHandler', () => ({
  createApiHandler: (handler: (req: NextRequest) => Promise<Response>) => handler,
}));

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args),
    }),
  },
}));

import { GET } from './route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/v2/ai/config/agent-session/effective');
}

describe('GET /api/v2/ai/config/agent-session/effective', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the effective global agent-session configuration', async () => {
    const config = {
      enabled: true,
      defaultDefinitionRef: 'system:default',
      runtime: { maxRunSeconds: 900 },
    };
    mockGetEffectiveConfig.mockResolvedValue(config);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(config);
    expect(mockGetEffectiveConfig).toHaveBeenCalledWith();
  });

  it('propagates a configuration-service failure to the API wrapper', async () => {
    mockGetEffectiveConfig.mockRejectedValue(new Error('configuration store unavailable'));

    await expect(GET(makeRequest())).rejects.toThrow('configuration store unavailable');
  });
});
