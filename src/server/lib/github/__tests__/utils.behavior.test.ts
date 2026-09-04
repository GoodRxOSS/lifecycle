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

const mockCacheRequest = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('server/lib/github/cacheRequest', () => ({
  cacheRequest: (...args: unknown[]) => mockCacheRequest(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ error: mockLoggerError })),
}));

import { constructClientRequestData, getAppToken, getRefForBranchName } from 'server/lib/github/utils';

describe('GitHub utility behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getRefForBranchName', () => {
    it('requests and returns the exact branch ref', async () => {
      const response = { data: { object: { sha: 'abc123' } } };
      mockCacheRequest.mockResolvedValue(response);

      await expect(getRefForBranchName('goodrx', 'lifecycle', 'feature/logging')).resolves.toBe(response);

      expect(mockCacheRequest).toHaveBeenCalledWith('GET /repos/goodrx/lifecycle/git/ref/heads/feature/logging');
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it.each([
      ['the upstream message', new Error('GitHub rate limit exceeded'), 'GitHub rate limit exceeded'],
      ['the stable fallback', new Error(), 'Unable to get ref for Branch Name'],
    ])('logs and normalizes a fetch failure using %s', async (_label, failure, expectedMessage) => {
      mockCacheRequest.mockRejectedValue(failure);

      await expect(getRefForBranchName('goodrx', 'lifecycle', 'main')).rejects.toThrow(expectedMessage);

      expect(mockCacheRequest).toHaveBeenCalledWith('GET /repos/goodrx/lifecycle/git/ref/heads/main');
      expect(mockLoggerError).toHaveBeenCalledWith(
        `GitHub: unable to get ref for branch repo=goodrx/lifecycle branch=main error=${expectedMessage}`
      );
    });
  });

  describe('constructClientRequestData', () => {
    it('maps the request identity, cache validators, and rate-limit headers', () => {
      const result = constructClientRequestData(
        {
          headers: {
            etag: '"response-etag"',
            'last-modified': 'Wed, 26 Aug 2026 12:00:00 GMT',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-used': '27',
            'x-ratelimit-reset': '1787760000',
          },
        },
        'GET /repos/{owner}/{repo}',
        'repository-read'
      );

      expect(result).toEqual({
        caller: 'repository-read',
        path: '/repos/{owner}/{repo}',
        type: 'GET',
        req: 'GET /repos/{owner}/{repo}',
        cache: {
          etag: '"response-etag"',
          lastModified: 'Wed, 26 Aug 2026 12:00:00 GMT',
        },
        rateLimit: {
          limit: '5000',
          used: '27',
          reset: '1787760000',
        },
      });
      expect(mockCacheRequest).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it('keeps absent optional response headers explicit', () => {
      expect(constructClientRequestData({ headers: {} }, 'DELETE /repos/goodrx/lifecycle', '')).toEqual({
        caller: '',
        path: '/repos/goodrx/lifecycle',
        type: 'DELETE',
        req: 'DELETE /repos/goodrx/lifecycle',
        cache: {
          etag: undefined,
          lastModified: undefined,
        },
        rateLimit: {
          limit: undefined,
          used: undefined,
          reset: undefined,
        },
      });
      expect(mockCacheRequest).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });
  });

  it('uses the stable app-token error when authentication rejects without a message', async () => {
    const app = Object.assign(jest.fn().mockRejectedValue(new Error()), { hook: jest.fn() });

    await expect(getAppToken({ installationId: 321, app })).rejects.toThrow('Unable to get App Token');

    expect(app).toHaveBeenCalledWith({ type: 'installation', installationId: 321 });
    expect(mockLoggerError).toHaveBeenCalledWith(
      'GitHub: unable to get app token installationId=321 error=Unable to get App Token'
    );
    expect(mockCacheRequest).not.toHaveBeenCalled();
  });
});
