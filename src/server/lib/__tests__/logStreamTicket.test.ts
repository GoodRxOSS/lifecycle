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

import { sealGrant } from 'server/lib/opaqueGrant';
import {
  LOG_STREAM_TICKET_TTL_SECONDS,
  createLogStreamTicket,
  readLogStreamTicketClaims,
} from 'server/lib/logStreamTicket';

const originalSecret = process.env.CHAT_PREVIEW_GRANT_SECRET;
const originalEnableAuth = process.env.ENABLE_AUTH;
const target = {
  buildUuid: 'build-1',
  namespace: 'env-build-1',
  podName: 'web-0',
  containerName: '[init] clone',
  actor: 'user-1',
};

describe('log stream tickets', () => {
  beforeEach(() => {
    process.env.CHAT_PREVIEW_GRANT_SECRET = 'test-ticket-secret';
    process.env.ENABLE_AUTH = 'true';
    jest.useFakeTimers().setSystemTime(new Date('2026-06-29T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalSecret === undefined) {
      delete process.env.CHAT_PREVIEW_GRANT_SECRET;
    } else {
      process.env.CHAT_PREVIEW_GRANT_SECRET = originalSecret;
    }
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('pins the namespace, pod and container for five minutes', () => {
    const { ticket, maxAgeSeconds } = createLogStreamTicket(target);

    expect(ticket).toMatch(/^lfclt_v1\./);
    expect(ticket).not.toContain('env-build-1');
    expect(maxAgeSeconds).toBe(LOG_STREAM_TICKET_TTL_SECONDS);
    expect(readLogStreamTicketClaims(ticket)).toMatchObject(target);
  });

  it('rejects an expired ticket', () => {
    const { ticket } = createLogStreamTicket(target);

    jest.setSystemTime(new Date('2026-06-29T12:05:01.000Z'));

    expect(readLogStreamTicketClaims(ticket)).toBeNull();
  });

  it('rejects wrong-purpose grants, tampered tickets and garbage without throwing', () => {
    const grant = sealGrant({ prefix: 'lfclt_v1', aad: 'another-purpose' }, { sessionId: 'session-1' });
    const { ticket } = createLogStreamTicket(target);
    const [prefix, iv, ciphertext, tag] = ticket.split('.');
    const flipped = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;

    expect(readLogStreamTicketClaims(grant)).toBeNull();
    expect(readLogStreamTicketClaims(`${prefix}.${iv}.${flipped}.${tag}`)).toBeNull();
    expect(readLogStreamTicketClaims('kube-system')).toBeNull();
    expect(readLogStreamTicketClaims(undefined)).toBeNull();
  });

  it.each([4, 8, 12, 15])('rejects a truncated %i-byte GCM tag', (length) => {
    const { ticket } = createLogStreamTicket(target);
    const [prefix, iv, ciphertext, tag] = ticket.split('.');
    const shortened = Buffer.from(tag, 'base64url').subarray(0, length).toString('base64url');
    expect(readLogStreamTicketClaims(`${prefix}.${iv}.${ciphertext}.${shortened}`)).toBeNull();
  });

  it('rejects extra parts, invalid IV length and noncanonical encoding', () => {
    const { ticket } = createLogStreamTicket(target);
    const [prefix, iv, ciphertext, tag] = ticket.split('.');
    expect(readLogStreamTicketClaims(`${ticket}.extra`)).toBeNull();
    expect(
      readLogStreamTicketClaims(`${prefix}.${Buffer.alloc(11).toString('base64url')}.${ciphertext}.${tag}`)
    ).toBeNull();
    expect(readLogStreamTicketClaims(`${prefix}.${iv}=.${ciphertext}.${tag}`)).toBeNull();
    expect(readLogStreamTicketClaims(`${prefix}.${iv}.${ciphertext}.${tag}!`)).toBeNull();
  });

  it.each([
    { iat: null },
    { exp: null },
    { iat: 0, exp: Number.MAX_SAFE_INTEGER + 1 },
    { iat: 1, exp: 1 },
    { iat: 1, exp: 302 },
    { actor: '' },
    { buildUuid: '' },
    { jti: '' },
  ])('rejects authenticated invalid claim shapes %j', (invalid) => {
    const { claims } = createLogStreamTicket(target);
    const ticket = sealGrant({ prefix: 'lfclt_v1', aad: 'lifecycle.log-stream-ticket.v1' }, { ...claims, ...invalid });
    expect(readLogStreamTicketClaims(ticket)).toBeNull();
  });
});
