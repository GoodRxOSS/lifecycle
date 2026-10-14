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

const mockWarn = jest.fn();
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: mockWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  SERVICE_OUTCOME_LIMIT,
  SERVICE_OUTCOME_MESSAGE_LENGTH,
  boundedServiceOutcomes,
  recordBuildEvent,
  recordFirstRollout,
  recordNamespaceCreated,
  recordNamespaceDeleted,
  serviceOutcomeMessage,
  type ServiceRunOutcome,
} from '../buildEvents';

type Builder = Record<string, jest.Mock>;
function knexWith(builders: Record<string, Builder>) {
  const knex = jest.fn((table: string) => builders[table]) as jest.Mock & { raw: jest.Mock };
  knex.raw = jest.fn((sql: string) => ({ sql }));
  return knex;
}
function chain(result: unknown, failWith?: Error): Builder {
  const builder: Builder = {};
  for (const method of ['where', 'whereNull', 'whereRaw', 'update', 'returning', 'insert']) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.then = jest.fn((resolve, reject) =>
    failWith ? Promise.reject(failWith).then(resolve, reject) : Promise.resolve(result).then(resolve, reject)
  );
  return builder;
}

beforeEach(() => jest.clearAllMocks());

describe('recordBuildEvent', () => {
  it('inserts a normalized row with bounded reason and serialized meta', async () => {
    const events = chain([1]);
    const knex = knexWith({ build_events: events });
    await recordBuildEvent(knex, {
      buildId: 7,
      kind: 'deploy_requested',
      runUUID: 'run-1',
      origin: 'push',
      reason: 'x'.repeat(1200),
      meta: { generation: 3 },
    });
    expect(events.insert).toHaveBeenCalledWith({
      buildId: 7,
      deployId: null,
      runUUID: 'run-1',
      kind: 'deploy_requested',
      status: null,
      reason: 'x'.repeat(1000),
      origin: 'push',
      meta: '{"generation":3}',
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('redacts secrets in the reason before it is stored', async () => {
    const events = chain([1]);
    const knex = knexWith({ build_events: events });
    await recordBuildEvent(knex, {
      buildId: 7,
      kind: 'run_finished',
      reason: 'Deploy failed: API_KEY=supersecretvalue123 rejected',
    });
    expect(events.insert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Deploy failed: API_KEY=[redacted] rejected' })
    );
  });

  it('cuts the reason by character, never inside a surrogate pair', async () => {
    const events = chain([1]);
    const knex = knexWith({ build_events: events });
    await recordBuildEvent(knex, {
      buildId: 7,
      kind: 'deploy_requested',
      reason: `${'x'.repeat(999)}\u{1F680}\u{1F680}`,
    });
    expect(events.insert).toHaveBeenCalledWith(expect.objectContaining({ reason: `${'x'.repeat(999)}\u{1F680}` }));
  });

  it('does nothing without a usable knex instance', async () => {
    await expect(recordBuildEvent(undefined, { buildId: 1, kind: 'run_claimed' })).resolves.toBeUndefined();
    await expect(recordBuildEvent({} as never, { buildId: 1, kind: 'run_claimed' })).resolves.toBeUndefined();
  });

  it('logs and swallows insert failures so deployment work never fails on bookkeeping', async () => {
    const knex = knexWith({ build_events: chain(null, new Error('insert failed')) });
    await expect(recordBuildEvent(knex, { buildId: 1, kind: 'run_claimed', reason: null })).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 1, kind: 'run_claimed' }),
      'BuildEvents: insert failed'
    );
  });
});

describe('recordNamespaceCreated', () => {
  it('stamps every namespace creation as a new episode and records the event', async () => {
    const builds = chain([{ id: 9 }]);
    const events = chain([1]);
    const knex = knexWith({ builds, build_events: events });
    await recordNamespaceCreated(knex, 'env-uuid');
    expect(builds.where).toHaveBeenCalledWith({ uuid: 'env-uuid' });
    expect(builds.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(builds.whereRaw).not.toHaveBeenCalled();
    expect(builds.update).toHaveBeenCalledWith({ namespaceCreatedAt: { sql: 'clock_timestamp()' } });
    expect(events.insert).toHaveBeenCalledWith(expect.objectContaining({ buildId: 9, kind: 'namespace_created' }));
  });

  it('accepts scalar returning rows and skips the event when no row was stamped', async () => {
    const stamped = knexWith({ builds: chain([4]), build_events: chain([1]) });
    await recordNamespaceCreated(stamped, 'env-uuid');
    expect(stamped('build_events').insert).toHaveBeenCalledWith(expect.objectContaining({ buildId: 4 }));

    const unchanged = knexWith({ builds: chain([]), build_events: chain([1]) });
    await recordNamespaceCreated(unchanged, 'env-uuid');
    expect(unchanged('build_events').insert).not.toHaveBeenCalled();
  });

  it('ignores an unusable knex and logs update failures', async () => {
    await expect(recordNamespaceCreated(null, 'env-uuid')).resolves.toBeUndefined();
    const knex = knexWith({ builds: chain(null, new Error('update failed')), build_events: chain([1]) });
    await recordNamespaceCreated(knex, 'env-uuid');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ buildUUID: 'env-uuid' }),
      'BuildEvents: namespace stamp failed'
    );
    expect(knex('build_events').insert).not.toHaveBeenCalled();
  });
});

describe('recordNamespaceDeleted', () => {
  it('stamps the deletion and records the event with the teardown run', async () => {
    const builds = chain(1);
    const events = chain([1]);
    const knex = knexWith({ builds, build_events: events });
    await recordNamespaceDeleted(knex, 9, 'teardown-run');
    expect(builds.where).toHaveBeenCalledWith({ id: 9 });
    expect(builds.update).toHaveBeenCalledWith({ namespaceDeletedAt: { sql: 'clock_timestamp()' } });
    expect(events.insert).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 9, kind: 'namespace_deleted', runUUID: 'teardown-run' })
    );
  });

  it('scopes the stamp to the deleted namespace so a late deletion cannot end a newer episode', async () => {
    const builds = chain(0);
    const events = chain([1]);
    const knex = knexWith({ builds, build_events: events });
    await recordNamespaceDeleted(knex, 9, null, 'env-old-name');
    expect(builds.where).toHaveBeenCalledWith({ id: 9 });
    expect(builds.where).toHaveBeenCalledWith({ namespace: 'env-old-name' });
    expect(events.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'namespace_deleted', runUUID: null }));
  });

  it('still records the event when the stamp fails, and ignores an unusable knex', async () => {
    await expect(recordNamespaceDeleted(undefined, 9)).resolves.toBeUndefined();
    const events = chain([1]);
    const knex = knexWith({ builds: chain(null, new Error('update failed')), build_events: events });
    await recordNamespaceDeleted(knex, 9);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 9 }),
      'BuildEvents: namespace stamp failed'
    );
    expect(events.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'namespace_deleted', runUUID: null }));
  });
});

describe('recordFirstRollout', () => {
  it('stamps the first rollout only once and never throws', async () => {
    const builds = chain(1);
    const knex = knexWith({ builds });
    await recordFirstRollout(knex, 9);
    expect(builds.where).toHaveBeenCalledWith({ id: 9 });
    expect(builds.whereNull).toHaveBeenCalledWith('firstRolledOutAt');
    expect(builds.update).toHaveBeenCalledWith({ firstRolledOutAt: { sql: 'clock_timestamp()' } });

    await expect(recordFirstRollout(undefined, 9)).resolves.toBeUndefined();
    await recordFirstRollout(knexWith({ builds: chain(null, new Error('update failed')) }), 9);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ buildId: 9 }), 'BuildEvents: rollout stamp failed');
  });
});

describe('service outcomes', () => {
  it('keeps each message short and single-line', () => {
    expect(serviceOutcomeMessage('  Build failed\n   after 10m  ')).toBe('Build failed after 10m');
    const long = serviceOutcomeMessage('x'.repeat(500));
    expect(long).toHaveLength(SERVICE_OUTCOME_MESSAGE_LENGTH);
    expect(long.endsWith('...')).toBe(true);
    expect(serviceOutcomeMessage('y'.repeat(SERVICE_OUTCOME_MESSAGE_LENGTH))).toBe(
      'y'.repeat(SERVICE_OUTCOME_MESSAGE_LENGTH)
    );
    const emoji = serviceOutcomeMessage(
      `${'z'.repeat(SERVICE_OUTCOME_MESSAGE_LENGTH - 4)}\u{1F680}\u{1F4E6}${'z'.repeat(20)}`
    );
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji)).toBe(false);
    expect(Array.from(emoji)).toHaveLength(SERVICE_OUTCOME_MESSAGE_LENGTH);
    expect(() => JSON.parse(JSON.stringify({ emoji }))).not.toThrow();
  });

  it('redacts secrets in a message before it is cut', () => {
    expect(serviceOutcomeMessage(`helm failed: token=ghp_${'x'.repeat(30)} for app`)).toBe(
      'helm failed: token=[redacted] for app'
    );
    const key = `data.tls.key: -----BEGIN PRIVATE KEY----- ${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw'.repeat(10)}`;
    expect(serviceOutcomeMessage(key)).toBe('data.tls.key: [redacted]');
  });

  it('bounds the number of recorded services and keeps the first entries', () => {
    const outcome = (index: number): ServiceRunOutcome => ({
      name: `service-${index}`,
      type: 'docker',
      status: 'ready',
      outcome: 'ready',
      message: null,
    });
    const few = [outcome(1), outcome(2)];
    expect(boundedServiceOutcomes(few)).toBe(few);
    const many = Array.from({ length: SERVICE_OUTCOME_LIMIT + 5 }, (_, index) => outcome(index));
    const bounded = boundedServiceOutcomes(many);
    expect(bounded).toHaveLength(SERVICE_OUTCOME_LIMIT);
    expect(bounded[0].name).toBe('service-0');
  });
});
