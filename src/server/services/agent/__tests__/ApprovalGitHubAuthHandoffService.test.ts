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

const redisValues = new Map<string, string>();
const redisSets = new Map<string, Set<string>>();
const mockRedis = {
  set: jest.fn(async (key: string, value: string) => {
    redisValues.set(key, value);
  }),
  get: jest.fn(async (key: string) => redisValues.get(key) || null),
  sadd: jest.fn(async (key: string, ...members: string[]) => {
    const set = redisSets.get(key) || new Set<string>();
    for (const member of members) {
      set.add(member);
    }
    redisSets.set(key, set);
  }),
  expire: jest.fn(async () => 1),
  smembers: jest.fn(async (key: string) => [...(redisSets.get(key) || new Set<string>())]),
  del: jest.fn(async (...keys: string[]) => {
    for (const key of keys) {
      redisValues.delete(key);
      redisSets.delete(key);
    }
  }),
};

jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getRedis: () => mockRedis,
    })),
  },
}));

jest.mock('server/lib/encryption', () => ({
  encrypt: jest.fn((value: string) => `encrypted:${value}`),
  decrypt: jest.fn((value: string) => value.replace(/^encrypted:/, '')),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: jest.fn(),
  }),
}));

import ApprovalGitHubAuthHandoffService from '../ApprovalGitHubAuthHandoffService';

describe('ApprovalGitHubAuthHandoffService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisValues.clear();
    redisSets.clear();
  });

  it('stores encrypted approver auth and resolves it by action, tool call, and run index', async () => {
    await ApprovalGitHubAuthHandoffService.store({
      runUuid: 'run-1',
      actionUuid: 'action-1',
      toolCallId: 'tool-1',
      approvedByUserId: 'user-1',
      auth: {
        githubToken: 'user-token',
        source: 'user',
        githubUsername: 'octocat',
        writeAuthorized: true,
      },
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining(':action:action-1'),
      expect.stringContaining('"encryptedGithubToken":"encrypted:user-token"'),
      'EX',
      expect.any(Number)
    );
    await expect(ApprovalGitHubAuthHandoffService.getByAction('run-1', 'action-1')).resolves.toEqual({
      githubToken: 'user-token',
      source: 'user',
      githubUsername: 'octocat',
      writeAuthorized: true,
    });
    await expect(ApprovalGitHubAuthHandoffService.getByToolCallId('run-1', 'tool-1')).resolves.toEqual({
      githubToken: 'user-token',
      source: 'user',
      githubUsername: 'octocat',
      writeAuthorized: true,
    });
    await expect(ApprovalGitHubAuthHandoffService.getFirstForRun('run-1')).resolves.toEqual({
      githubToken: 'user-token',
      source: 'user',
      githubUsername: 'octocat',
      writeAuthorized: true,
    });
  });

  it('rejects non-user or non-write-authorized auth', async () => {
    await expect(
      ApprovalGitHubAuthHandoffService.store({
        runUuid: 'run-1',
        actionUuid: 'action-1',
        approvedByUserId: 'user-1',
        auth: {
          githubToken: 'app-token',
          source: 'app',
          writeAuthorized: true,
        },
      })
    ).rejects.toThrow('write-authorized user token');

    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});
