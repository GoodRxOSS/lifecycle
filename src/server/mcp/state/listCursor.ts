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

import { createHmac, timingSafeEqual } from 'crypto';
import { canonicalJson } from 'server/lib/canonicalJson';
import type { McpJsonObject } from '../contracts';
import { McpExecutionError } from '../errors';
import { mcpApplicationKey } from '../security/applicationKey';

const MAX_CURSOR_BYTES = 500;
const TTL_SECONDS = 3600;
const TOKEN_PREFIX = 'lfcmcp_cursor_v1';

export interface ListCursorPayload {
  position: number;
  filters: McpJsonObject;
  limit: number;
}

function invalidCursor(): McpExecutionError {
  return new McpExecutionError('invalid_cursor', 'That list cursor is invalid or expired. Start the list again.');
}

function signature(payload: string): Buffer {
  return createHmac('sha256', mcpApplicationKey()).update(`${TOKEN_PREFIX}.${payload}`, 'utf8').digest();
}

export function encodeListCursor(value: ListCursorPayload, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (
    !Number.isInteger(value.position) ||
    value.position < 0 ||
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    !Number.isInteger(nowSeconds)
  ) {
    throw new Error('List cursor values must be positive integers');
  }
  const payload = Buffer.from(
    JSON.stringify({
      position: value.position,
      filters: value.filters,
      limit: value.limit,
      expiresAt: nowSeconds + TTL_SECONDS,
    }),
    'utf8'
  ).toString('base64url');
  const cursor = `${TOKEN_PREFIX}.${payload}.${signature(payload).toString('base64url')}`;
  if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) {
    throw new Error('List filters do not fit in the cursor limit');
  }
  return cursor;
}

export function decodeListCursor(
  cursor: string,
  expectedFilters: McpJsonObject,
  expectedLimit: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): { position: number } {
  try {
    if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) throw invalidCursor();
    const parts = cursor.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) throw invalidCursor();
    const payload = parts[1];
    const suppliedSignature = Buffer.from(parts[2], 'base64url');
    if (
      suppliedSignature.length !== 32 ||
      suppliedSignature.toString('base64url') !== parts[2] ||
      !timingSafeEqual(signature(payload), suppliedSignature)
    ) {
      throw invalidCursor();
    }
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.toString('base64url') !== payload) throw invalidCursor();
    const parsed = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(parsed).some((key) => !['position', 'filters', 'limit', 'expiresAt'].includes(key)) ||
      !Number.isSafeInteger(parsed.position) ||
      (parsed.position as number) < 0 ||
      parsed.limit !== expectedLimit ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      (parsed.expiresAt as number) <= nowSeconds ||
      !parsed.filters ||
      typeof parsed.filters !== 'object' ||
      Array.isArray(parsed.filters) ||
      canonicalJson(parsed.filters) !== canonicalJson(expectedFilters)
    ) {
      throw invalidCursor();
    }
    return { position: parsed.position as number };
  } catch (error) {
    if (error instanceof McpExecutionError) throw error;
    throw invalidCursor();
  }
}
