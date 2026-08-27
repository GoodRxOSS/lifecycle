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

import TelemetryService, { type TelemetryEventInput } from '../telemetry';

type QueryBuilder = Record<string, jest.Mock> & {
  then: <TResult1 = unknown, TResult2 = never>(
    onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) => Promise<TResult1 | TResult2>;
};

function resolvedBuilder(value: unknown): QueryBuilder {
  const builder = {} as QueryBuilder;
  for (const method of [
    'select',
    'where',
    'whereBetween',
    'groupBy',
    'groupByRaw',
    'orderBy',
    'orderByRaw',
    'limit',
    'first',
  ]) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.then = (onFulfilled, onRejected) => Promise.resolve(value).then(onFulfilled, onRejected);
  return builder;
}

const baseEvent: TelemetryEventInput = {
  source: 'cli',
  clientId: 'client-1',
  event: 'builds list',
  status: 'success',
  clientVersion: '1.2.3',
};

describe('TelemetryService', () => {
  it.each([
    ['defaults omitted attributes', baseEvent, {}],
    ['preserves supplied attributes', { ...baseEvent, attributes: { format: 'json' } }, { format: 'json' }],
  ])('%s when inserting an event', async (_name, event, expectedAttributes) => {
    const inserted = { id: 17, ...event, attributes: expectedAttributes };
    const returning = jest.fn().mockResolvedValue(inserted);
    const insert = jest.fn().mockReturnValue({ returning });
    const query = jest.fn().mockReturnValue({ insert });
    const service = new TelemetryService({ models: { TelemetryEvent: { query } } } as any);

    await expect(service.insertEvent(event as TelemetryEventInput)).resolves.toBe(inserted);
    expect(insert).toHaveBeenCalledWith({ ...event, attributes: expectedAttributes });
    expect(returning).toHaveBeenCalledWith('*');
  });

  it('returns normalized usage, error, client, version, and platform statistics', async () => {
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-08T00:00:00.000Z');
    const bucketDate = new Date('2026-08-01T00:00:00.000Z');
    const builders = [
      resolvedBuilder([
        { bucket: bucketDate, count: '3' },
        { bucket: '2026-08-02T00:00:00Z', count: 'not-a-number' },
      ]),
      resolvedBuilder([
        { event: 'builds list', count: '4', errorCount: '1', p50DurationMs: '12.5', p95DurationMs: 30 },
        { event: 'builds get', count: 0, errorCount: undefined, p50DurationMs: null, p95DurationMs: undefined },
      ]),
      resolvedBuilder({ count: '2' }),
      resolvedBuilder([{ bucket: bucketDate, count: 2 }]),
      resolvedBuilder([{ clientVersion: '1.2.3', count: '2' }]),
      resolvedBuilder([
        { platform: 'darwin', count: 2 },
        { platform: undefined, count: 1 },
      ]),
    ];
    const pendingBuilders = [...builders];
    const knex = jest.fn(() => pendingBuilders.shift()) as jest.Mock & { raw: jest.Mock };
    knex.raw = jest.fn((sql: string, bindings?: unknown[]) => ({ sql, bindings }));
    const service = new TelemetryService({ knex } as any);

    const result = await service.getStats({ source: 'cli', from, to, interval: 'day' });

    expect(result).toEqual({
      usageOverTime: [
        { bucket: '2026-08-01T00:00:00.000Z', count: 3 },
        { bucket: '2026-08-02T00:00:00Z', count: 0 },
      ],
      topEvents: [
        {
          event: 'builds list',
          count: 4,
          errorCount: 1,
          errorRate: 0.25,
          p50DurationMs: 12.5,
          p95DurationMs: 30,
        },
        {
          event: 'builds get',
          count: 0,
          errorCount: 0,
          errorRate: 0,
          p50DurationMs: null,
          p95DurationMs: null,
        },
      ],
      activeClients: {
        total: 2,
        overTime: [{ bucket: '2026-08-01T00:00:00.000Z', count: 2 }],
      },
      versions: [{ clientVersion: '1.2.3', count: 2 }],
      platforms: [
        { platform: 'darwin', count: 2 },
        { platform: null, count: 1 },
      ],
    });
    expect(knex).toHaveBeenCalledTimes(6);
    expect(knex).toHaveBeenCalledWith('telemetry_events');
    for (const builder of builders) {
      expect(builder.where).toHaveBeenCalledWith('source', 'cli');
      expect(builder.whereBetween).toHaveBeenCalledWith('createdAt', [from.toISOString(), to.toISOString()]);
    }
  });

  it('returns empty statistics when the database has no matching rows', async () => {
    const builders = [
      resolvedBuilder([]),
      resolvedBuilder([]),
      resolvedBuilder(undefined),
      resolvedBuilder([]),
      resolvedBuilder([]),
      resolvedBuilder([]),
    ];
    const knex = jest.fn(() => builders.shift()) as jest.Mock & { raw: jest.Mock };
    knex.raw = jest.fn((sql: string) => sql);
    const service = new TelemetryService({ knex } as any);

    const result = await service.getStats({
      source: 'ui',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-02T00:00:00.000Z'),
      interval: 'week',
    });

    expect(result).toEqual({
      usageOverTime: [],
      topEvents: [],
      activeClients: { total: 0, overTime: [] },
      versions: [],
      platforms: [],
    });
  });
});
