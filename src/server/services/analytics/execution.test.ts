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
import { AppError, toErrorResponseError } from 'server/lib/appError';
import { analyticsTransaction } from './execution';

function database() {
  const raw = jest.fn().mockResolvedValue(undefined);
  const trx = { raw } as unknown as Knex.Transaction;
  const knex = { transaction: jest.fn(async (work) => work(trx)) } as unknown as Knex;
  return { knex, trx, raw };
}

describe('Analytics transaction failures', () => {
  it('keeps a read-only snapshot and statement limit before returning successful data', async () => {
    const { knex, trx, raw } = database();
    const work = jest.fn().mockResolvedValue({ count: 0 });
    await expect(analyticsTransaction(knex, work)).resolves.toEqual({ count: 0 });
    expect(raw.mock.calls).toEqual([
      ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'],
      ["SET LOCAL statement_timeout = '10s'"],
    ]);
    expect(work).toHaveBeenCalledWith(trx);
  });

  it('returns a safe, specific unavailable error for a database statement timeout', async () => {
    const { knex } = database();
    const original = Object.assign(new Error('SELECT private_column -- canceling statement due to statement timeout'), {
      code: '57014',
    });
    const error = await analyticsTransaction(knex, async () => {
      throw original;
    }).catch((failure) => failure);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ httpStatus: 503, code: 'analytics_timeout', retryable: true, cause: original });
    expect(toErrorResponseError(error)).toEqual({
      message: 'Analytics request did not complete before the time limit.',
      code: 'analytics_timeout',
      nextAction: { kind: 'retry', label: 'Try again' },
    });
  });

  it.each([
    Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
    Object.assign(
      new Error("SELECT 'canceling statement due to statement timeout' - canceling statement due to user request"),
      { code: '57014' }
    ),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '55P03' }),
    new Error('canceling statement due to statement timeout'),
    new Error('Connection failed'),
    null,
  ])('preserves failures that do not establish a statement timeout: %p', async (original) => {
    const { knex } = database();
    await expect(
      analyticsTransaction(knex, async () => {
        throw original;
      })
    ).rejects.toBe(original);
  });

  it('does not start work when transaction setup fails', async () => {
    const { knex, raw } = database();
    const original = new Error('Connection failed');
    raw.mockRejectedValueOnce(original);
    const work = jest.fn();
    await expect(analyticsTransaction(knex, work)).rejects.toBe(original);
    expect(work).not.toHaveBeenCalled();
  });
});
