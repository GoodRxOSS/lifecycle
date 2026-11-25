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
import { isLocalAuthDisabled } from 'server/lib/serverAccess';

const DEFAULT_GRANT_TTL_SECONDS = 60 * 60;
const MIN_GRANT_TTL_SECONDS = 60;
const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;

/** The AAD binds a sealed grant to one purpose: a grant of one kind never authenticates as another kind. */
export interface OpaqueGrantKind {
  prefix: string;
  aad: string;
  localSecret?: string;
}

export interface GrantEnvelope {
  iat: number;
  exp: number;
  jti: string;
  maxAgeSeconds: number;
}

function readUsableSecret(): string | null {
  const candidate =
    process.env.CHAT_PREVIEW_GRANT_SECRET ||
    process.env.ENCRYPTION_KEY ||
    process.env.NEXTAUTH_SECRET ||
    process.env.GITHUB_WEBHOOK_SECRET ||
    null;
  const normalized = candidate?.trim();
  if (!normalized || ['changeme', 'not_setup', 'your_value_here', 'replace_me'].includes(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}

function getGrantSecret(kind: OpaqueGrantKind): string {
  const secret = readUsableSecret();
  if (secret) {
    return secret;
  }

  if (isLocalAuthDisabled()) {
    return kind.localSecret ?? 'local-dev-grant-secret';
  }

  throw new Error('CHAT_PREVIEW_GRANT_SECRET or ENCRYPTION_KEY must be configured to mint grants.');
}

function getKey(kind: OpaqueGrantKind): Buffer {
  return createHash('sha256').update(getGrantSecret(kind), 'utf8').digest();
}

function normalizeGrantTtlSeconds(ttlSeconds?: number): number {
  if (!Number.isFinite(ttlSeconds)) {
    return DEFAULT_GRANT_TTL_SECONDS;
  }

  return Math.min(MAX_GRANT_TTL_SECONDS, Math.max(MIN_GRANT_TTL_SECONDS, Math.floor(ttlSeconds!)));
}

export function issueGrantEnvelope(ttlSeconds?: number): GrantEnvelope {
  const maxAgeSeconds = normalizeGrantTtlSeconds(ttlSeconds);
  const iat = Math.floor(Date.now() / 1000);
  return { iat, exp: iat + maxAgeSeconds, jti: randomUUID(), maxAgeSeconds };
}

export function secondsUntil(exp: number): number {
  return Math.max(Math.floor(exp - Date.now() / 1000), 0);
}

export function sealGrant(kind: OpaqueGrantKind, claims: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(kind), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(kind.aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  return [
    kind.prefix,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function openGrant(kind: OpaqueGrantKind, grant: string | null | undefined): unknown {
  if (!grant) {
    return null;
  }

  const parts = grant.split('.');
  const [prefix, rawIv, rawCiphertext, rawTag] = parts;
  if (parts.length !== 4 || prefix !== kind.prefix || !rawIv || !rawCiphertext || !rawTag) {
    return null;
  }

  try {
    const encodedParts = [rawIv, rawCiphertext, rawTag];
    if (encodedParts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const [iv, ciphertext, tag] = encodedParts.map((part) => Buffer.from(part, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16) return null;
    if ([iv, ciphertext, tag].some((part, index) => part.toString('base64url') !== encodedParts[index])) return null;
    const decipher = createDecipheriv('aes-256-gcm', getKey(kind), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(kind.aad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
