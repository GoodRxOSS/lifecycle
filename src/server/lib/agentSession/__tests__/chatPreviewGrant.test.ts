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
  createChatPreviewGrant,
  getChatPreviewGrantMaxAgeSeconds,
  readChatPreviewGrantClaims,
  verifyChatPreviewGrant,
} from 'server/lib/agentSession/chatPreviewGrant';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import mainGrantFixtures from '../__fixtures__/mainChatPreviewGrants';

const originalSecret = process.env.CHAT_PREVIEW_GRANT_SECRET;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalEnableAuth = process.env.ENABLE_AUTH;
const originalAppEnv = process.env.APP_ENV;
const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;
const originalGithubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const PREVIEW_HOST = '3000--abcdef1234567890.preview.lifecycle.dev';

function mintRawGrant(claims: unknown): string {
  const iv = randomBytes(12);
  const key = createHash('sha256').update('test-preview-secret', 'utf8').digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('lifecycle.chat-preview-grant.v1', 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);

  return [
    'lfcpg_v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

describe('chat preview grants', () => {
  beforeEach(() => {
    process.env.CHAT_PREVIEW_GRANT_SECRET = 'test-preview-secret';
    delete process.env.ENCRYPTION_KEY;
    process.env.ENABLE_AUTH = 'true';
    process.env.APP_ENV = 'development';
    jest.useFakeTimers().setSystemTime(new Date('2026-06-29T12:00:00.000Z'));
  });

  afterEach(() => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    jest.useRealTimers();
    if (originalSecret === undefined) {
      delete process.env.CHAT_PREVIEW_GRANT_SECRET;
    } else {
      process.env.CHAT_PREVIEW_GRANT_SECRET = originalSecret;
    }
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
    if (originalNextAuthSecret === undefined) {
      delete process.env.NEXTAUTH_SECRET;
    } else {
      process.env.NEXTAUTH_SECRET = originalNextAuthSecret;
    }
    if (originalGithubWebhookSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = originalGithubWebhookSecret;
    }
  });

  it('creates an opaque grant scoped to a session, port, and user', () => {
    const { grant, claims, maxAgeSeconds } = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
    });

    expect(grant).toMatch(/^lfcpg_v1\./);
    expect(grant).not.toContain('session-123');
    expect(maxAgeSeconds).toBe(3600);
    expect(readChatPreviewGrantClaims(grant)).toMatchObject({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
      exp: claims.exp,
    });
    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: PREVIEW_HOST,
      })
    ).toBe(true);
  });

  it('uses the local development secret only when authentication is disabled', () => {
    delete process.env.CHAT_PREVIEW_GRANT_SECRET;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    process.env.ENABLE_AUTH = 'false';

    const { grant } = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
    });

    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: PREVIEW_HOST,
      })
    ).toBe(true);
  });

  it.each(mainGrantFixtures)(
    'reads the pinned main grant with $name key selection',
    ({ environment, grant, claims, maxAgeSeconds }) => {
      for (const key of ['CHAT_PREVIEW_GRANT_SECRET', 'ENCRYPTION_KEY', 'NEXTAUTH_SECRET', 'GITHUB_WEBHOOK_SECRET'])
        delete process.env[key];
      Object.assign(process.env, environment);
      expect(readChatPreviewGrantClaims(grant)).toEqual(claims);
      expect(
        verifyChatPreviewGrant(grant, {
          sessionId: claims.sessionId,
          port: claims.port,
          userId: claims.userId,
          previewHost: claims.previewHost,
        })
      ).toBe(true);
      expect(getChatPreviewGrantMaxAgeSeconds(grant)).toBe(maxAgeSeconds);
    }
  );

  it.each(['dev', 'development'])('keeps the original preview local key in %s', (environment) => {
    for (const key of ['CHAT_PREVIEW_GRANT_SECRET', 'ENCRYPTION_KEY', 'NEXTAUTH_SECRET', 'GITHUB_WEBHOOK_SECRET'])
      delete process.env[key];
    process.env.ENABLE_AUTH = 'false';
    process.env.APP_ENV = environment;
    const fixture = mainGrantFixtures.find(({ name }) => name === 'local')!;
    expect(readChatPreviewGrantClaims(fixture.grant)).toEqual(fixture.claims);
  });

  it('refuses the main fixed local key outside explicit local development', () => {
    for (const key of ['CHAT_PREVIEW_GRANT_SECRET', 'ENCRYPTION_KEY', 'NEXTAUTH_SECRET', 'GITHUB_WEBHOOK_SECRET'])
      delete process.env[key];
    process.env.ENABLE_AUTH = 'false';
    process.env.APP_ENV = 'production';
    const fixture = mainGrantFixtures.find(({ name }) => name === 'local')!;
    expect(readChatPreviewGrantClaims(fixture.grant)).toBeNull();
    expect(() =>
      createChatPreviewGrant({ sessionId: 's', userId: 'u', port: 3000, previewHost: PREVIEW_HOST })
    ).toThrow(/must be configured/);
  });

  it('rejects truncated tags, extra segments, padding, and noncanonical encodings on main-format grants', () => {
    const fixture = mainGrantFixtures[0];
    process.env.CHAT_PREVIEW_GRANT_SECRET = fixture.environment.CHAT_PREVIEW_GRANT_SECRET;
    const [prefix, iv, ciphertext, tag] = fixture.grant.split('.');
    for (const length of [4, 8, 12, 13, 14, 15]) {
      const truncatedTag = Buffer.from(tag, 'base64url').subarray(0, length).toString('base64url');
      expect(readChatPreviewGrantClaims([prefix, iv, ciphertext, truncatedTag].join('.'))).toBeNull();
    }
    expect(readChatPreviewGrantClaims(`${fixture.grant}.extra`)).toBeNull();
    expect(readChatPreviewGrantClaims(`${fixture.grant}=`)).toBeNull();
    expect(readChatPreviewGrantClaims([prefix, iv + '=', ciphertext, tag].join('.'))).toBeNull();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const noncanonicalTag = tag.slice(0, -1) + alphabet[alphabet.indexOf(tag.slice(-1)) + 1];
    expect(Buffer.from(noncanonicalTag, 'base64url')).toEqual(Buffer.from(tag, 'base64url'));
    expect(readChatPreviewGrantClaims([prefix, iv, ciphertext, noncanonicalTag].join('.'))).toBeNull();
  });

  it('rejects a blank preview host before minting a grant', () => {
    expect(() =>
      createChatPreviewGrant({
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: '   ',
      })
    ).toThrow('previewHost is required to mint a chat preview grant.');
  });

  it('rejects grants replayed onto another preview target', () => {
    const { grant } = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
    });

    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3001,
        userId: 'user-123',
        previewHost: PREVIEW_HOST,
      })
    ).toBe(false);
    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'other-user',
        previewHost: PREVIEW_HOST,
      })
    ).toBe(false);
    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: '3000--different.preview.lifecycle.dev',
      })
    ).toBe(false);
  });

  it('binds host preview grants to the exact preview host', () => {
    const { grant } = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: '3000--ABCDEF1234567890.preview.lifecycle.dev',
    });

    expect(readChatPreviewGrantClaims(grant)).toMatchObject({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: '3000--abcdef1234567890.preview.lifecycle.dev',
    });
    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: '3000--abcdef1234567890.preview.lifecycle.dev',
      })
    ).toBe(true);
    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: '3000--different.preview.lifecycle.dev',
      })
    ).toBe(false);
    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
      } as any)
    ).toBe(false);
  });

  it('rejects expired grants', () => {
    const { grant } = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
      ttlSeconds: 60,
    });

    jest.setSystemTime(new Date('2026-06-29T12:01:01.000Z'));
    expect(
      verifyChatPreviewGrant(grant, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: PREVIEW_HOST,
      })
    ).toBe(false);
  });

  it('rejects malformed and tampered grants without throwing', () => {
    const { grant } = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
    });
    const [prefix, iv, ciphertext, tag] = grant.split('.');
    const tamperedTag = `${tag.startsWith('A') ? 'B' : 'A'}${tag.slice(1)}`;
    const tampered = [prefix, iv, ciphertext, tamperedTag].join('.');

    expect(readChatPreviewGrantClaims('not-a-grant')).toBeNull();
    expect(readChatPreviewGrantClaims(null)).toBeNull();
    expect(readChatPreviewGrantClaims('lfcpg_v1.bad.bad.bad')).toBeNull();
    expect(readChatPreviewGrantClaims(tampered)).toBeNull();
    expect(
      verifyChatPreviewGrant(tampered, {
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: PREVIEW_HOST,
      })
    ).toBe(false);
    expect(getChatPreviewGrantMaxAgeSeconds('not-a-grant')).toBeNull();
  });

  it('rejects an authentic grant whose decrypted claims violate the grant contract', () => {
    const malformedGrant = mintRawGrant({
      v: 1,
      sessionId: 'session-123',
      port: '3000',
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
      iat: 1782734400,
      exp: 1782738000,
      jti: 'grant-1',
    });

    expect(readChatPreviewGrantClaims(malformedGrant)).toBeNull();
    expect(readChatPreviewGrantClaims(mintRawGrant(null))).toBeNull();
  });

  it('clamps grant ttl to the supported range', () => {
    const short = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
      ttlSeconds: 1,
    });
    const long = createChatPreviewGrant({
      sessionId: 'session-123',
      port: 3000,
      userId: 'user-123',
      previewHost: PREVIEW_HOST,
      ttlSeconds: 999999,
    });

    expect(short.maxAgeSeconds).toBe(60);
    expect(long.maxAgeSeconds).toBe(24 * 60 * 60);
    expect(getChatPreviewGrantMaxAgeSeconds(short.grant)).toBe(60);
  });

  it('fails closed when auth is enabled and no usable secret exists', () => {
    delete process.env.CHAT_PREVIEW_GRANT_SECRET;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    process.env.ENABLE_AUTH = 'true';

    expect(() =>
      createChatPreviewGrant({
        sessionId: 'session-123',
        port: 3000,
        userId: 'user-123',
        previewHost: PREVIEW_HOST,
      })
    ).toThrow(/CHAT_PREVIEW_GRANT_SECRET/);
  });
});
