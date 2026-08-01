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

import {
  confirmationStateHash,
  confirmationStateMatches,
  createDestroyConfirmation,
  verifyDestroyConfirmation,
} from '../security/destroyConfirmation';

const originalKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '7'.repeat(64);
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

it('seals a five-minute confirmation to the exact Build id and OAuth user', () => {
  const stateHash = confirmationStateHash({
    status: 'ready',
    services: ['api', 'web'],
    expiresAt: null,
  });
  const token = createDestroyConfirmation({ environmentId: 42, userId: 'user-1', stateHash }, 1_000);
  expect(verifyDestroyConfirmation(token, { environmentId: 42, userId: 'user-1' }, 1_001)).toEqual({
    v: 1,
    action: 'destroy_environment',
    environmentId: 42,
    userId: 'user-1',
    stateHash,
    iat: 1_000,
    exp: 1_300,
  });
});

it.each([
  [{ environmentId: 43, userId: 'user-1' }, 'wrong environment'],
  [{ environmentId: 42, userId: 'user-2' }, 'wrong user'],
])('rejects a confirmation bound to the %s', (expected) => {
  const token = createDestroyConfirmation({ environmentId: 42, userId: 'user-1', stateHash: 'a'.repeat(32) }, 1_000);
  expect(() => verifyDestroyConfirmation(token, expected, 1_001)).toThrow('confirmation is invalid');
});

it('rejects tampering and expiry without a replay store', () => {
  const token = createDestroyConfirmation({ environmentId: 42, userId: 'user-1', stateHash: 'b'.repeat(32) }, 1_000);
  expect(() =>
    verifyDestroyConfirmation(`${token.slice(0, -1)}x`, { environmentId: 42, userId: 'user-1' }, 1_001)
  ).toThrow('confirmation is invalid');
  expect(() => verifyDestroyConfirmation(token, { environmentId: 42, userId: 'user-1' }, 1_300)).toThrow(
    'confirmation expired'
  );
});

it('requires the normal deployment-wide application key', () => {
  delete process.env.ENCRYPTION_KEY;
  expect(() =>
    createDestroyConfirmation({
      environmentId: 42,
      userId: 'user-1',
      stateHash: 'c'.repeat(32),
    })
  ).toThrow('ENCRYPTION_KEY');
});

it('compares locked-state hashes without string short-circuiting', () => {
  expect(confirmationStateMatches('a'.repeat(32), 'a'.repeat(32))).toBe(true);
  expect(confirmationStateMatches('a'.repeat(32), 'b'.repeat(32))).toBe(false);
  expect(confirmationStateMatches('not-a-hash', 'not-a-hash')).toBe(false);
});
