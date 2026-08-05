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

import type Redlock from 'redlock';

export type AuthorityLockResult<T> = { admitted: true; value: T } | { admitted: false };

/** The mutation finished, but lock ownership was not durable enough to publish it as terminal. */
export class AuthorityLockLostError extends Error {
  constructor(resource: string, options: { cause?: unknown } = {}) {
    super(`Authority lock was lost for ${resource}`, options);
    this.name = 'AuthorityLockLostError';
  }
}

interface AuthorityLockOptions<T> {
  redlock: Redlock | null | undefined;
  resource: string;
  ttlMs: number;
  isCurrent: () => Promise<boolean>;
  action: () => Promise<T>;
  onWait?: (error: unknown) => void;
}

/**
 * Wait for a mutation lock only while the caller remains authoritative. Lock
 * contention is not a terminal deployment failure; a newer generation simply
 * makes the waiter leave without being admitted.
 */
export async function withAuthorityLock<T>({
  redlock,
  resource,
  ttlMs,
  isCurrent,
  action,
  onWait,
}: AuthorityLockOptions<T>): Promise<AuthorityLockResult<T>> {
  if (!(await isCurrent())) return { admitted: false };
  if (!redlock?.lock) {
    if (!(await isCurrent())) return { admitted: false };
    const value = await action();
    if (!(await isCurrent())) return { admitted: false };
    return { admitted: true, value };
  }

  const lockWithOptions = (redlock as any).lockWithOptions;
  let lastWaitLog = Date.now();
  let lock: any;

  while (await isCurrent()) {
    try {
      lock =
        typeof lockWithOptions === 'function'
          ? await lockWithOptions.call(redlock, resource, ttlMs, {
              retryCount: 4,
              retryDelay: 1000,
              retryJitter: 200,
            })
          : await redlock.lock(resource, ttlMs);
      break;
    } catch (error) {
      if (Date.now() - lastWaitLog >= 60_000) {
        onWait?.(error);
        lastWaitLog = Date.now();
      }
      // Production Redlock already waited between attempts. This prevents a
      // hot loop in tests or alternate implementations that fail immediately.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!lock) return { admitted: false };

  let renewalError: unknown;
  let renewal = Promise.resolve();
  const renewalTimer = setInterval(() => {
    renewal = renewal
      .then(async () => {
        lock = await lock.extend(ttlMs);
      })
      .catch((error) => {
        renewalError = error;
      });
  }, ttlMs / 3);

  try {
    if (!(await isCurrent())) return { admitted: false };
    const value = await action();
    // Stop scheduling extensions before inspecting the final renewal. Without
    // this ordering, the timer can enqueue one more extension after the check
    // and make a lost lock look successful.
    clearInterval(renewalTimer);
    await renewal;
    if (renewalError) throw new AuthorityLockLostError(resource, { cause: renewalError });
    if (!(await isCurrent())) return { admitted: false };
    return { admitted: true, value };
  } finally {
    clearInterval(renewalTimer);
    await renewal;
    await lock.unlock().catch(() => undefined);
  }
}
