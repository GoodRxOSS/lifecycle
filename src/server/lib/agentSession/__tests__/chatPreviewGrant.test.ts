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

const originalSecret = process.env.CHAT_PREVIEW_GRANT_SECRET;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalEnableAuth = process.env.ENABLE_AUTH;
const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;
const originalGithubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const PREVIEW_HOST = '3000--abcdef1234567890.preview.lifecycle.dev';

describe('chat preview grants', () => {
  beforeEach(() => {
    process.env.CHAT_PREVIEW_GRANT_SECRET = 'test-preview-secret';
    delete process.env.ENCRYPTION_KEY;
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
