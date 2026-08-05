/**
 * Copyright 2026 Lifecycle contributors
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

import { AuthorityLockLostError, withAuthorityLock } from '../authorityLock';

describe('withAuthorityLock', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('waits through contention and admits the still-current generation once', async () => {
    jest.useFakeTimers();
    const acquired = { extend: jest.fn(), unlock: jest.fn().mockResolvedValue(undefined) };
    const lockWithOptions = jest.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(acquired);
    const action = jest.fn().mockResolvedValue('done');

    const result = withAuthorityLock({
      redlock: { lock: jest.fn(), lockWithOptions } as any,
      resource: 'build-promotion.1',
      ttlMs: 60_000,
      isCurrent: jest.fn().mockResolvedValue(true),
      action,
    });

    await jest.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ admitted: true, value: 'done' });
    expect(lockWithOptions).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(1);
    expect(acquired.unlock).toHaveBeenCalledTimes(1);
  });

  test('leaves without executing when superseded while waiting', async () => {
    jest.useFakeTimers();
    const isCurrent = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const action = jest.fn();
    const result = withAuthorityLock({
      redlock: {
        lock: jest.fn(),
        lockWithOptions: jest.fn().mockRejectedValue(new Error('busy')),
      } as any,
      resource: 'build-promotion.1',
      ttlMs: 60_000,
      isCurrent,
      action,
    });

    await jest.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ admitted: false });
    expect(action).not.toHaveBeenCalled();
  });

  test('reports lost renewal so the generation remains pending for retry', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const action = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const acquired = {
      extend: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      unlock: jest.fn().mockResolvedValue(undefined),
    };
    const result = withAuthorityLock({
      redlock: {
        lock: jest.fn(),
        lockWithOptions: jest.fn().mockResolvedValue(acquired),
      } as any,
      resource: 'build-promotion.1',
      ttlMs: 300,
      isCurrent: jest.fn().mockResolvedValue(true),
      action,
    });

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(100);
    finish();

    await expect(result).rejects.toBeInstanceOf(AuthorityLockLostError);
    expect(acquired.unlock).toHaveBeenCalledTimes(1);
  });

  test('does not publish admission when authority changes during the action', async () => {
    const acquired = {
      extend: jest.fn().mockResolvedValue(undefined),
      unlock: jest.fn().mockResolvedValue(undefined),
    };
    const isCurrent = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const action = jest.fn().mockResolvedValue('stale-value');

    await expect(
      withAuthorityLock({
        redlock: { lock: jest.fn(), lockWithOptions: jest.fn().mockResolvedValue(acquired) } as any,
        resource: 'deploy-external-secrets.1',
        ttlMs: 60_000,
        isCurrent,
        action,
      })
    ).resolves.toEqual({ admitted: false });

    expect(action).toHaveBeenCalledTimes(1);
    expect(acquired.unlock).toHaveBeenCalledTimes(1);
  });
});
