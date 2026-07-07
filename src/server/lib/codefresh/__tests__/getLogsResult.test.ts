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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import { EventEmitter } from 'events';

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: jest.fn(),
  execFile: jest.fn(),
  execSync: jest.fn(),
  execFileSync: jest.fn(),
  spawnSync: jest.fn(),
}));

jest.mock('shelljs');
jest.mock('aws-sdk');
jest.mock('server/lib/shell', () => ({
  shellPromise: jest.fn(),
}));
jest.mock('server/lib/codefresh/utils');

import { getLogsResult } from 'server/lib/codefresh';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

function spawnFake(): FakeChild {
  const child = new FakeChild();
  mockSpawn.mockReturnValue(child);
  return child;
}

describe('getLogsResult', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('spawns codefresh with an argument array (no shell interpolation)', async () => {
    const child = spawnFake();
    const promise = getLogsResult('672ea2c44b9c09ed7c91a8ef');
    child.stdout.emit('data', Buffer.from('hello\n'));
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({ ok: true, output: 'hello\n', truncatedAtSource: false });
    expect(mockSpawn).toHaveBeenCalledWith('codefresh', ['logs', '672ea2c44b9c09ed7c91a8ef']);
  });

  it('keeps only the tail of oversized streams and flags source truncation', async () => {
    const child = spawnFake();
    const promise = getLogsResult('672ea2c44b9c09ed7c91a8ef');

    const chunk = Buffer.from('x'.repeat(1024 * 1024));
    for (let i = 0; i < 30; i++) child.stdout.emit('data', chunk);
    child.stdout.emit('data', Buffer.from('THE-END'));
    child.emit('close', 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncatedAtSource).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(25 * 1024 * 1024);
      expect(result.output.endsWith('THE-END')).toBe(true);
    }
  });

  it('reports a non-zero exit with the stderr tail', async () => {
    const child = spawnFake();
    const promise = getLogsResult('672ea2c44b9c09ed7c91a8ef');
    child.stderr.emit('data', Buffer.from('unauthorized: bad api key'));
    child.emit('close', 1);

    const result = await promise;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('unauthorized: bad api key') });
  });

  it('reports spawn errors (binary missing)', async () => {
    const child = spawnFake();
    const promise = getLogsResult('672ea2c44b9c09ed7c91a8ef');
    child.emit('error', new Error('spawn codefresh ENOENT'));

    await expect(promise).resolves.toEqual({ ok: false, reason: 'spawn codefresh ENOENT' });
  });

  it('settles once even if close follows error', async () => {
    const child = spawnFake();
    const promise = getLogsResult('672ea2c44b9c09ed7c91a8ef');
    child.emit('error', new Error('boom'));
    child.emit('close', 1);

    await expect(promise).resolves.toEqual({ ok: false, reason: 'boom' });
  });
});
