/**
 * Copyright 2025 GoodRx, Inc.
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

import type { NextRequest } from 'next/server';
import type { JWTPayload } from 'jose';

const decode = <T = JWTPayload>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url' as BufferEncoding).toString('utf8')) as T;
  } catch {
    return null;
  }
};

export function getUser(req: NextRequest): JWTPayload | null {
  const raw = req.headers.get('x-user');
  return decode<JWTPayload>(raw);
}

function normalizeClaim(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function getLocalDevUserId(): string {
  const configured = process.env.LOCAL_DEV_USER_ID?.trim();
  return configured || 'local-dev-user';
}

function buildGitFallbackEmail(identifier: string): string {
  if (/^[A-Za-z0-9-]+$/.test(identifier)) {
    return `${identifier}@users.noreply.github.com`;
  }

  return `${identifier.replace(/[^A-Za-z0-9._-]+/g, '-') || 'local-dev-user'}@local.lifecycle`;
}

export interface RequestUserIdentity {
  userId: string;
  githubUsername: string | null;
  preferredUsername: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  gitUserName: string;
  gitUserEmail: string;
}

function buildUserIdentity(payload: JWTPayload | null, userId: string): RequestUserIdentity {
  const claims = (payload || {}) as Record<string, unknown>;
  const githubUsername = normalizeClaim(claims.github_username) || normalizeClaim(claims.githubUsername);
  const preferredUsername = normalizeClaim(claims.preferred_username) || normalizeClaim(claims.preferredUsername);
  const email = normalizeClaim(claims.email);
  const firstName = normalizeClaim(claims.given_name) || normalizeClaim(claims.firstName);
  const lastName = normalizeClaim(claims.family_name) || normalizeClaim(claims.lastName);
  const explicitName = normalizeClaim(claims.name);
  const displayName =
    explicitName ||
    [firstName, lastName].filter(Boolean).join(' ').trim() ||
    githubUsername ||
    preferredUsername ||
    userId;
  const gitUserName = displayName;
  const gitUserEmail = email || buildGitFallbackEmail(githubUsername || preferredUsername || userId);

  return {
    userId,
    githubUsername,
    preferredUsername,
    email,
    firstName,
    lastName,
    displayName,
    gitUserName,
    gitUserEmail,
  };
}

export function getRequestUserSub(req: NextRequest): string | null {
  const sub = normalizeClaim(getUser(req)?.sub);
  if (sub) {
    return sub;
  }

  if (process.env.ENABLE_AUTH === 'true') {
    return null;
  }

  return getLocalDevUserId();
}

export function getRequestUserIdentity(req: NextRequest): RequestUserIdentity | null {
  const payload = getUser(req);
  const sub = normalizeClaim(payload?.sub);
  if (sub) {
    return buildUserIdentity(payload, sub);
  }

  if (process.env.ENABLE_AUTH === 'true') {
    return null;
  }

  return buildUserIdentity(null, getLocalDevUserId());
}
