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

import { createHmac } from 'crypto';
import { decodeListCursor, encodeListCursor } from '../state/listCursor';

const NOW = 1_700_000_000;
const FILTERS = { mode: 'list', q: 'api' };
const ENCRYPTION_KEY = '7'.repeat(64);
const TOKEN_PREFIX = 'lfcmcp_cursor_v1';
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterAll(() => {
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

function tamper(cursor: string, mutate: (payload: Record<string, unknown>) => Record<string, unknown>): string {
  const [prefix, payload, cursorSignature] = cursor.split('.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  const tamperedPayload = Buffer.from(JSON.stringify(mutate(parsed)), 'utf8').toString('base64url');
  return [prefix, tamperedPayload, cursorSignature].join('.');
}

function signedRawPayload(value: string): string {
  const payload = Buffer.from(value, 'utf8').toString('base64url');
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const cursorSignature = createHmac('sha256', key).update(`${TOKEN_PREFIX}.${payload}`, 'utf8').digest('base64url');
  return `${TOKEN_PREFIX}.${payload}.${cursorSignature}`;
}

it('round-trips a position under the same filters and limit', () => {
  const cursor = encodeListCursor({ position: 3, filters: FILTERS, limit: 25 }, NOW);

  expect(decodeListCursor(cursor, FILTERS, 25, NOW + 10)).toEqual({ position: 3 });
});

it('accepts filters whose keys were rebuilt in a different order', () => {
  const cursor = encodeListCursor({ position: 1, filters: { q: 'api', mode: 'list' }, limit: 25 }, NOW);

  expect(decodeListCursor(cursor, { mode: 'list', q: 'api' }, 25, NOW + 10)).toEqual({ position: 1 });
});

it('rejects encoding invalid positions, limits, and clocks', () => {
  expect(() => encodeListCursor({ position: -1, filters: FILTERS, limit: 25 }, NOW)).toThrow('positive integers');
  expect(() => encodeListCursor({ position: 0.5, filters: FILTERS, limit: 25 }, NOW)).toThrow('positive integers');
  expect(() => encodeListCursor({ position: 0, filters: FILTERS, limit: 0 }, NOW)).toThrow('positive integers');
  expect(() => encodeListCursor({ position: 0, filters: FILTERS, limit: 25 }, 1.5)).toThrow('positive integers');
});

it('rejects filters too large for the cursor limit', () => {
  expect(() => encodeListCursor({ position: 0, filters: { q: 'x'.repeat(600) }, limit: 25 }, NOW)).toThrow(
    'cursor limit'
  );
});

it('rejects an oversized cursor before decoding it', () => {
  expect(() => decodeListCursor('A'.repeat(501), FILTERS, 25, NOW)).toThrow('invalid or expired');
});

it('rejects text that is not canonical base64url', () => {
  expect(() => decodeListCursor('not base64url!!', FILTERS, 25, NOW)).toThrow('invalid or expired');
});

it('rejects payloads that are not valid JSON objects', () => {
  expect(() => decodeListCursor(signedRawPayload('garbage'), FILTERS, 25, NOW)).toThrow('invalid or expired');
});

it('rejects payloads carrying unknown keys', () => {
  const cursor = tamper(encodeListCursor({ position: 1, filters: FILTERS, limit: 25 }, NOW), (payload) => ({
    ...payload,
    extra: true,
  }));

  expect(() => decodeListCursor(cursor, FILTERS, 25, NOW)).toThrow('invalid or expired');
});

it('rejects a tampered but otherwise valid position', () => {
  const cursor = tamper(encodeListCursor({ position: 1, filters: FILTERS, limit: 25 }, NOW), (payload) => ({
    ...payload,
    position: 200,
  }));

  expect(() => decodeListCursor(cursor, FILTERS, 25, NOW)).toThrow('invalid or expired');
});

it('rejects a client-extended expiry', () => {
  const cursor = tamper(encodeListCursor({ position: 1, filters: FILTERS, limit: 25 }, NOW), (payload) => ({
    ...payload,
    expiresAt: NOW + 86_400,
  }));

  expect(() => decodeListCursor(cursor, FILTERS, 25, NOW)).toThrow('invalid or expired');
});

it('rejects a cursor issued for a different limit', () => {
  const cursor = encodeListCursor({ position: 1, filters: FILTERS, limit: 25 }, NOW);

  expect(() => decodeListCursor(cursor, FILTERS, 50, NOW)).toThrow('invalid or expired');
});

it('rejects a cursor issued for different filters', () => {
  const cursor = encodeListCursor({ position: 1, filters: FILTERS, limit: 25 }, NOW);

  expect(() => decodeListCursor(cursor, { mode: 'list', q: 'other' }, 25, NOW)).toThrow('invalid or expired');
});

it('rejects an expired cursor and accepts one inside its lifetime', () => {
  const cursor = encodeListCursor({ position: 1, filters: FILTERS, limit: 25 }, NOW);

  expect(decodeListCursor(cursor, FILTERS, 25, NOW + 3599)).toEqual({ position: 1 });
  expect(() => decodeListCursor(cursor, FILTERS, 25, NOW + 3600)).toThrow('invalid or expired');
});
