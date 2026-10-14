/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Knex } from 'knex';
import { AppError } from 'server/lib/appError';

export const ANALYTICS_CONCURRENCY = 4;
export const ANALYTICS_QUEUE_WAIT_MS = 5000;
let running = 0;
const waiting: Array<() => void> = [];

/** Analytics shares the API's pool: a few extra requests wait briefly for a slot, the rest fail fast. */
function acquire(): Promise<void> {
  if (running < ANALYTICS_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(grant), 1);
      reject(
        new AppError({
          httpStatus: 503,
          code: 'analytics_busy',
          message: 'Analytics is busy. Try again in a moment.',
          nextAction: { kind: 'retry', label: 'Try again' },
          retryable: true,
        })
      );
    }, ANALYTICS_QUEUE_WAIT_MS);
    waiting.push(grant);
  });
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

export async function analyticsTransaction<T>(knex: Knex, work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await trx.raw("SET LOCAL statement_timeout = '10s'");
      // Statements run once; JIT compiling them cost more than a second each on wide windows.
      await trx.raw('SET LOCAL jit = off');
      return work(trx);
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { code?: string }).code === '57014' &&
      error.message.endsWith('canceling statement due to statement timeout')
    ) {
      throw new AppError({
        httpStatus: 503,
        code: 'analytics_timeout',
        message: 'Analytics request did not complete before the time limit.',
        nextAction: { kind: 'retry', label: 'Try again' },
        retryable: true,
        cause: error,
      });
    }
    throw error;
  } finally {
    release();
  }
}
