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

import type { JWTPayload } from 'jose';

const MAX_USER_IDENTIFIER_LENGTH = 255;

const CANDIDATE_KEYS = [
  'github_username',
  'githubUsername',
  'preferred_username',
  'preferredUsername',
  'email',
  'upn',
  'name',
  'sub',
] as const;

function clampIdentifier(value: string): string {
  const graphemes = Array.from(value);
  if (graphemes.length <= MAX_USER_IDENTIFIER_LENGTH) {
    return value;
  }
  return graphemes.slice(0, MAX_USER_IDENTIFIER_LENGTH).join('');
}

function normalizeClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return clampIdentifier(normalized);
}

export function resolveUserIdentifierFromPayload(payload: JWTPayload | null): string | undefined {
  if (!payload) {
    return undefined;
  }

  for (const key of CANDIDATE_KEYS) {
    const candidate = normalizeClaim((payload as Record<string, unknown>)[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}
