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
import { createLogStreamTicket, readLogStreamTicketClaims } from 'server/lib/logStreamTicket';
import {
  createWorkspaceEditorGrant,
  readWorkspaceEditorGrantClaims,
  verifyWorkspaceEditorGrant,
  WORKSPACE_EDITOR_GRANT_TTL_SECONDS,
} from '../workspaceEditorGrant';

const kind = { prefix: 'lfceg_v1', aad: 'lifecycle.workspace-editor-grant.v1' };
const identity = { sessionId: 'session-1', userId: 'user-1' };
const now = Date.parse('2026-10-25T12:00:00Z') / 1000;
const originalSecret = process.env.CHAT_PREVIEW_GRANT_SECRET;

describe('workspace editor grants', () => {
  beforeEach(() => {
    process.env.CHAT_PREVIEW_GRANT_SECRET = 'test-editor-grant-secret';
    jest.useFakeTimers().setSystemTime(now * 1000);
  });
  afterEach(() => {
    jest.useRealTimers();
    if (originalSecret === undefined) delete process.env.CHAT_PREVIEW_GRANT_SECRET;
    else process.env.CHAT_PREVIEW_GRANT_SECRET = originalSecret;
  });

  it.each([1, 30, 59, 300, 7200])('never extends a verified token with %i seconds remaining', (remaining) => {
    const { grant, claims, maxAgeSeconds } = createWorkspaceEditorGrant({
      ...identity,
      tokenExpiresAt: now + remaining,
    });
    expect(maxAgeSeconds).toBe(Math.min(remaining, WORKSPACE_EDITOR_GRANT_TTL_SECONDS));
    expect(claims.exp).toBe(now + maxAgeSeconds);
    expect(grant).toMatch(/^lfceg_v1\./);
    expect(grant).not.toContain('user-1');
    expect(verifyWorkspaceEditorGrant(grant, identity)).toBe(true);
    jest.setSystemTime(claims.exp * 1000);
    expect(verifyWorkspaceEditorGrant(grant, identity)).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, now, now - 1])('rejects an unusable token expiry %s', (tokenExpiresAt) => {
    expect(() => createWorkspaceEditorGrant({ ...identity, tokenExpiresAt })).toThrow('future expiry');
  });

  it('rejects another session or owner, and grants of a different purpose', () => {
    const { grant, claims } = createWorkspaceEditorGrant({ ...identity, tokenExpiresAt: now + 300 });
    expect(verifyWorkspaceEditorGrant(grant, { ...identity, sessionId: 'session-2' })).toBe(false);
    expect(verifyWorkspaceEditorGrant(grant, { ...identity, userId: 'user-2' })).toBe(false);
    expect(readWorkspaceEditorGrantClaims(sealGrant({ ...kind, aad: 'another-purpose' }, claims))).toBeNull();
    expect(readLogStreamTicketClaims(grant)).toBeNull();
    const { ticket } = createLogStreamTicket({
      buildUuid: 'build',
      namespace: 'env',
      podName: 'pod',
      containerName: 'app',
      actor: 'user-1',
    });
    expect(readWorkspaceEditorGrantClaims(ticket)).toBeNull();
  });

  it('cannot authenticate an API bearer request with an editor grant', async () => {
    const previous = {
      KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
      KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
      KEYCLOAK_JWKS_URL: process.env.KEYCLOAK_JWKS_URL,
    };
    process.env.KEYCLOAK_ISSUER = 'https://identity.example.test';
    process.env.KEYCLOAK_CLIENT_ID = 'lifecycle';
    process.env.KEYCLOAK_JWKS_URL = 'http://127.0.0.1:1/unused-jwks';
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network must not be used'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { verifyAuth } = await import('server/lib/auth');
      const { grant } = createWorkspaceEditorGrant({ ...identity, tokenExpiresAt: now + 300 });
      const result = await verifyAuth({ headers: { get: () => `Bearer ${grant}` } });
      expect(result.success).toBe(false);
      expect(result.error?.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects legacy JWTs, extra segments, truncated tags, noncanonical encoding, and tampering', () => {
    const { grant } = createWorkspaceEditorGrant({ ...identity, tokenExpiresAt: now + 300 });
    const [prefix, iv, ciphertext, tag] = grant.split('.');
    const tampered = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
    for (const value of [
      'header.payload.signature',
      `${grant}.extra`,
      `${prefix}.${iv}=.${ciphertext}.${tag}`,
      `${prefix}.${iv}.${tampered}.${tag}`,
      `${prefix}.${iv}.${ciphertext}.${Buffer.from(tag, 'base64url').subarray(0, 12).toString('base64url')}`,
    ])
      expect(readWorkspaceEditorGrantClaims(value)).toBeNull();
  });

  it.each([-60, -1, 0, 1, 60])('accepts an unexpired grant with issuer clock offset %i seconds', (offset) => {
    jest.setSystemTime((now + offset) * 1000);
    const { grant, claims } = createWorkspaceEditorGrant({ ...identity, tokenExpiresAt: now + 300 });
    expect(claims.exp).toBe(now + 300);
    jest.setSystemTime(now * 1000);
    expect(verifyWorkspaceEditorGrant(grant, identity)).toBe(true);
  });

  it('rejects issue times beyond the skew window without relaxing expiration', () => {
    jest.setSystemTime((now + 61) * 1000);
    const future = createWorkspaceEditorGrant({ ...identity, tokenExpiresAt: now + 300 });
    jest.setSystemTime(now * 1000);
    expect(verifyWorkspaceEditorGrant(future.grant, identity)).toBe(false);
    const { claims } = createWorkspaceEditorGrant({ ...identity, tokenExpiresAt: now + 30 });
    expect(verifyWorkspaceEditorGrant(sealGrant(kind, { ...claims, iat: now - 60, exp: now }), identity)).toBe(false);
    expect(verifyWorkspaceEditorGrant(sealGrant(kind, { ...claims, iat: now - 60, exp: now - 1 }), identity)).toBe(
      false
    );
  });

  it.each([
    { purpose: 'other' },
    { sessionId: '' },
    { userId: '' },
    { jti: '' },
    { iat: now + 61 },
    { iat: NaN },
    { exp: now },
    { exp: now + WORKSPACE_EDITOR_GRANT_TTL_SECONDS + 1 },
  ])('rejects authenticated invalid claims %j', (invalid) => {
    const { claims } = createWorkspaceEditorGrant({ ...identity, tokenExpiresAt: now + 300 });
    expect(readWorkspaceEditorGrantClaims(sealGrant(kind, { ...claims, ...invalid }))).toBeNull();
  });
});
