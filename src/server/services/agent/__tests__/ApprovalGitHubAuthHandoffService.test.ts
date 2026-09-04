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
const mockLoggerWarn = jest.fn();
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
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  }),
}));

import { decrypt, encrypt } from 'server/lib/encryption';
import ApprovalGitHubAuthHandoffService from '../ApprovalGitHubAuthHandoffService';

function storedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runUuid: 'run-1',
    actionUuid: 'action-1',
    toolCallId: null,
    approvedByUserId: 'user-1',
    githubUsername: null,
    encryptedGithubToken: 'encrypted:user-token',
    createdAt: '2026-08-27T12:00:00.000Z',
    expiresAt: '2026-08-27T13:00:00.000Z',
    ...overrides,
  });
}

describe('ApprovalGitHubAuthHandoffService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisValues.clear();
    redisSets.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
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

    expect(encrypt).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(mockRedis.sadd).not.toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('encodes key parts, trims an absent tool id, and stores an exact one-hour lifetime', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00.000Z'));

    await ApprovalGitHubAuthHandoffService.store({
      runUuid: 'run/with space',
      actionUuid: 'action:1',
      toolCallId: '   ',
      approvedByUserId: 'user-1',
      auth: {
        githubToken: 'user-token',
        source: 'user',
        writeAuthorized: true,
      },
    });

    const actionKey = 'agent:approval-github-auth:run:run%2Fwith%20space:action:action%3A1';
    const indexKey = 'agent:approval-github-auth:run:run%2Fwith%20space:keys';
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith(actionKey, expect.any(String), 'EX', 3600);
    const payload = JSON.parse(redisValues.get(actionKey) as string);
    expect(payload).toEqual({
      runUuid: 'run/with space',
      actionUuid: 'action:1',
      toolCallId: null,
      approvedByUserId: 'user-1',
      githubUsername: null,
      encryptedGithubToken: 'encrypted:user-token',
      createdAt: '2026-08-27T12:00:00.000Z',
      expiresAt: '2026-08-27T13:00:00.000Z',
    });
    expect(encrypt).toHaveBeenCalledWith('user-token');
    expect(mockRedis.sadd).toHaveBeenCalledWith(indexKey, actionKey);
    expect(mockRedis.expire).toHaveBeenCalledWith(indexKey, 3600);
  });

  it('does not index or expire a handoff when its Redis write fails', async () => {
    const writeError = new Error('Redis write failed');
    mockRedis.set.mockRejectedValueOnce(writeError);

    await expect(
      ApprovalGitHubAuthHandoffService.store({
        runUuid: 'run-1',
        actionUuid: 'action-1',
        approvedByUserId: 'user-1',
        auth: {
          githubToken: 'user-token',
          source: 'user',
          writeAuthorized: true,
        },
      })
    ).rejects.toBe(writeError);

    expect(mockRedis.sadd).not.toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('treats missing, malformed, and structurally incomplete action records as unavailable', async () => {
    const key = 'agent:approval-github-auth:run:run-1:action:action-1';

    await expect(ApprovalGitHubAuthHandoffService.getByAction('run-1', 'action-1')).resolves.toBeNull();
    redisValues.set(key, '{not JSON');
    await expect(ApprovalGitHubAuthHandoffService.getByAction('run-1', 'action-1')).resolves.toBeNull();
    redisValues.set(key, JSON.stringify({ runUuid: 'run-1', actionUuid: 'action-1' }));
    await expect(ApprovalGitHubAuthHandoffService.getByAction('run-1', 'action-1')).resolves.toBeNull();

    expect(decrypt).not.toHaveBeenCalled();
  });

  it('propagates token decryption failures from a valid action record', async () => {
    const decryptError = new Error('could not decrypt token');
    redisValues.set('agent:approval-github-auth:run:run-1:action:action-1', storedPayload());
    (decrypt as jest.MockedFunction<typeof decrypt>).mockImplementationOnce(() => {
      throw decryptError;
    });

    await expect(ApprovalGitHubAuthHandoffService.getByAction('run-1', 'action-1')).rejects.toBe(decryptError);
  });

  it.each([undefined, '   '])(
    'returns null for an absent tool call id (%p) without reading Redis',
    async (toolCallId) => {
      await expect(ApprovalGitHubAuthHandoffService.getByToolCallId('run-1', toolCallId)).resolves.toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
    }
  );

  it('trims and encodes a tool call id before lookup', async () => {
    redisValues.set('agent:approval-github-auth:run:run-1:tool:tool%2F1', storedPayload({ toolCallId: 'tool/1' }));

    await expect(ApprovalGitHubAuthHandoffService.getByToolCallId('run-1', '  tool/1  ')).resolves.toEqual({
      githubToken: 'user-token',
      source: 'user',
      githubUsername: null,
      writeAuthorized: true,
    });
    expect(mockRedis.get).toHaveBeenCalledWith('agent:approval-github-auth:run:run-1:tool:tool%2F1');
  });

  it('returns null when a non-empty tool call id has no stored handoff', async () => {
    await expect(ApprovalGitHubAuthHandoffService.getByToolCallId('run-1', 'missing-tool')).resolves.toBeNull();

    expect(mockRedis.get).toHaveBeenCalledWith('agent:approval-github-auth:run:run-1:tool:missing-tool');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('returns null for an empty run index without issuing record reads', async () => {
    await expect(ApprovalGitHubAuthHandoffService.getFirstForRun('empty-run')).resolves.toBeNull();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('skips stale run-index entries and returns the first valid handoff', async () => {
    const indexKey = 'agent:approval-github-auth:run:run-1:keys';
    const staleKey = 'agent:approval-github-auth:run:run-1:action:stale';
    const validKey = 'agent:approval-github-auth:run:run-1:action:valid';
    redisSets.set(indexKey, new Set([staleKey, validKey]));
    redisValues.set(
      validKey,
      JSON.stringify({
        runUuid: 'run-1',
        actionUuid: 'valid',
        approvedByUserId: 'user-1',
        githubUsername: 'octocat',
        encryptedGithubToken: 'encrypted:user-token',
      })
    );

    await expect(ApprovalGitHubAuthHandoffService.getFirstForRun('run-1')).resolves.toEqual({
      githubToken: 'user-token',
      source: 'user',
      githubUsername: 'octocat',
      writeAuthorized: true,
    });
    expect(mockRedis.get.mock.calls).toEqual([[staleKey], [validKey]]);
  });

  it('deletes action and trimmed tool keys when clearing a handoff', async () => {
    redisValues.set('agent:approval-github-auth:run:run-1:action:action-1', storedPayload());
    redisValues.set('agent:approval-github-auth:run:run-1:tool:tool%2F1', storedPayload());

    await expect(
      ApprovalGitHubAuthHandoffService.clearAction('run-1', 'action-1', '  tool/1  ')
    ).resolves.toBeUndefined();

    expect(mockRedis.del).toHaveBeenCalledWith(
      'agent:approval-github-auth:run:run-1:action:action-1',
      'agent:approval-github-auth:run:run-1:tool:tool%2F1'
    );
    expect(redisValues.size).toBe(0);
  });

  it('clears only the action key when the tool call id is blank', async () => {
    await ApprovalGitHubAuthHandoffService.clearAction('run-1', 'action-1', '  ');

    expect(mockRedis.del).toHaveBeenCalledWith('agent:approval-github-auth:run:run-1:action:action-1');
  });

  it('contains and logs action cleanup failures', async () => {
    const cleanupError = new Error('Redis delete failed');
    mockRedis.del.mockRejectedValueOnce(cleanupError);

    await expect(ApprovalGitHubAuthHandoffService.clearAction('run-1', 'action-1')).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error: cleanupError, runUuid: 'run-1', actionUuid: 'action-1' },
      'AgentApproval: GitHub auth handoff cleanup failed'
    );
  });

  it('clears every indexed handoff key and the run index', async () => {
    const indexKey = 'agent:approval-github-auth:run:run-1:keys';
    const actionKey = 'agent:approval-github-auth:run:run-1:action:action-1';
    const toolKey = 'agent:approval-github-auth:run:run-1:tool:tool-1';
    redisSets.set(indexKey, new Set([actionKey, toolKey]));
    redisValues.set(actionKey, storedPayload());
    redisValues.set(toolKey, storedPayload({ toolCallId: 'tool-1' }));

    await expect(ApprovalGitHubAuthHandoffService.clearRun('run-1')).resolves.toBeUndefined();

    expect(mockRedis.del).toHaveBeenCalledWith(actionKey, toolKey, indexKey);
    expect(redisValues.size).toBe(0);
    expect(redisSets.has(indexKey)).toBe(false);
  });

  it('contains and logs indexed run cleanup failures', async () => {
    const cleanupError = new Error('Redis delete failed');
    redisSets.set(
      'agent:approval-github-auth:run:run-1:keys',
      new Set(['agent:approval-github-auth:run:run-1:action:action-1'])
    );
    mockRedis.del.mockRejectedValueOnce(cleanupError);

    await expect(ApprovalGitHubAuthHandoffService.clearRun('run-1')).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error: cleanupError, runUuid: 'run-1' },
      'AgentApproval: GitHub auth handoff run cleanup failed'
    );
  });

  it('falls back to deleting only the index when reading the run index fails', async () => {
    mockRedis.smembers.mockRejectedValueOnce(new Error('Redis set read failed'));

    await expect(ApprovalGitHubAuthHandoffService.clearRun('run/1')).resolves.toBeUndefined();

    expect(mockRedis.del).toHaveBeenCalledWith('agent:approval-github-auth:run:run%2F1:keys');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('silently contains an empty-index deletion failure', async () => {
    mockRedis.del.mockRejectedValueOnce(new Error('Redis delete failed'));

    await expect(ApprovalGitHubAuthHandoffService.clearRun('run-1')).resolves.toBeUndefined();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});
