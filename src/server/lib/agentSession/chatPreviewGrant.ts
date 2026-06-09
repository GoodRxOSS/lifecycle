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

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';

const GRANT_PREFIX = 'lfcpg_v1';
const GRANT_AAD = Buffer.from('lifecycle.chat-preview-grant.v1', 'utf8');
const DEFAULT_GRANT_TTL_SECONDS = 60 * 60;
const MIN_GRANT_TTL_SECONDS = 60;
const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;

export interface ChatPreviewGrantClaims {
  v: 1;
  sessionId: string;
  port: number;
  userId: string;
  previewHost: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface ChatPreviewGrantExpectedClaims {
  sessionId: string;
  port: number;
  userId: string;
  previewHost: string;
}

export interface CreateChatPreviewGrantOptions extends ChatPreviewGrantExpectedClaims {
  ttlSeconds?: number;
}

function readUsableSecret(): string | null {
  const candidate =
    process.env.CHAT_PREVIEW_GRANT_SECRET ||
    process.env.ENCRYPTION_KEY ||
    process.env.NEXTAUTH_SECRET ||
    process.env.GITHUB_WEBHOOK_SECRET ||
    null;
  const normalized = candidate?.trim();
  if (!normalized || normalized === 'changeme' || normalized === 'not_setup') {
    return null;
  }
  return normalized;
}

function getGrantSecret(): string {
  const secret = readUsableSecret();
  if (secret) {
    return secret;
  }

  if (process.env.ENABLE_AUTH !== 'true') {
    return 'local-dev-chat-preview-grant-secret';
  }

  throw new Error('CHAT_PREVIEW_GRANT_SECRET or ENCRYPTION_KEY must be configured to mint preview grants.');
}

function getKey(): Buffer {
  return createHash('sha256').update(getGrantSecret(), 'utf8').digest();
}

function normalizeTtlSeconds(ttlSeconds?: number): number {
  if (!Number.isFinite(ttlSeconds)) {
    return DEFAULT_GRANT_TTL_SECONDS;
  }

  return Math.min(MAX_GRANT_TTL_SECONDS, Math.max(MIN_GRANT_TTL_SECONDS, Math.floor(ttlSeconds!)));
}

function normalizePreviewHost(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function requirePreviewHost(value: string | null | undefined): string {
  const normalized = normalizePreviewHost(value);
  if (!normalized) {
    throw new Error('previewHost is required to mint a chat preview grant.');
  }
  return normalized;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function createChatPreviewGrant({
  sessionId,
  port,
  userId,
  previewHost,
  ttlSeconds,
}: CreateChatPreviewGrantOptions): {
  grant: string;
  claims: ChatPreviewGrantClaims;
  maxAgeSeconds: number;
} {
  const maxAgeSeconds = normalizeTtlSeconds(ttlSeconds);
  const now = Math.floor(Date.now() / 1000);
  const claims: ChatPreviewGrantClaims = {
    v: 1,
    sessionId,
    port,
    userId,
    previewHost: requirePreviewHost(previewHost),
    iat: now,
    exp: now + maxAgeSeconds,
    jti: randomUUID(),
  };

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  cipher.setAAD(GRANT_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const grant = [
    GRANT_PREFIX,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');

  return { grant, claims, maxAgeSeconds };
}

function isClaimsShape(value: unknown): value is ChatPreviewGrantClaims {
  const claims = value as Partial<ChatPreviewGrantClaims> | null;
  return (
    claims?.v === 1 &&
    typeof claims.sessionId === 'string' &&
    typeof claims.port === 'number' &&
    Number.isInteger(claims.port) &&
    typeof claims.userId === 'string' &&
    typeof claims.previewHost === 'string' &&
    normalizePreviewHost(claims.previewHost) !== null &&
    typeof claims.iat === 'number' &&
    typeof claims.exp === 'number' &&
    typeof claims.jti === 'string'
  );
}

export function readChatPreviewGrantClaims(grant: string | null | undefined): ChatPreviewGrantClaims | null {
  if (!grant) {
    return null;
  }

  const [prefix, rawIv, rawCiphertext, rawTag] = grant.split('.');
  if (prefix !== GRANT_PREFIX || !rawIv || !rawCiphertext || !rawTag) {
    return null;
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', getKey(), decodeBase64Url(rawIv));
    decipher.setAAD(GRANT_AAD);
    decipher.setAuthTag(decodeBase64Url(rawTag));
    const plaintext = Buffer.concat([decipher.update(decodeBase64Url(rawCiphertext)), decipher.final()]);
    const claims = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!isClaimsShape(claims)) {
      return null;
    }
    return {
      ...claims,
      previewHost: requirePreviewHost(claims.previewHost),
    };
  } catch {
    return null;
  }
}

export function getChatPreviewGrantMaxAgeSeconds(grant: string): number | null {
  const claims = readChatPreviewGrantClaims(grant);
  if (!claims) {
    return null;
  }

  return Math.max(Math.floor(claims.exp - Date.now() / 1000), 0);
}

export function verifyChatPreviewGrant(
  grant: string | null | undefined,
  expected: ChatPreviewGrantExpectedClaims
): boolean {
  const claims = readChatPreviewGrantClaims(grant);
  if (!claims) {
    return false;
  }

  const expectedPreviewHost = normalizePreviewHost(expected.previewHost);
  if (!expectedPreviewHost) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    claims.exp > now &&
    claims.sessionId === expected.sessionId &&
    claims.port === expected.port &&
    claims.userId === expected.userId &&
    normalizePreviewHost(claims.previewHost) === expectedPreviewHost
  );
}
