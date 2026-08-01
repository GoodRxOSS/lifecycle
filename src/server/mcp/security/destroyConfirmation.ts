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

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { canonicalJson } from 'server/lib/canonicalJson';
import type { McpJsonValue } from '../contracts';
import { McpExecutionError } from '../errors';
import { mcpApplicationKey } from './applicationKey';

export const DESTROY_CONFIRMATION_TOKEN_PREFIX = 'lfcmcp_destroy_v1';
const TOKEN_AAD = Buffer.from('lifecycle.mcp.destroy-confirmation.v1', 'utf8');
const IV_BYTES = 12;
const MAX_TOKEN_BYTES = 4096;
export const DESTROY_CONFIRMATION_TTL_SECONDS = 300;

export interface DestroyConfirmationClaims {
  v: 1;
  action: 'destroy_environment';
  environmentId: number;
  userId: string;
  stateHash: string;
  iat: number;
  exp: number;
}

export interface CreateDestroyConfirmationInput {
  environmentId: number;
  userId: string;
  stateHash: string;
}

export interface ExpectedDestroyConfirmation {
  environmentId: number;
  userId: string;
}

export function confirmationStateHash(state: McpJsonValue): string {
  return createHash('sha256').update(canonicalJson(state), 'utf8').digest('hex').slice(0, 32);
}

export function confirmationStateMatches(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(expected) || !/^[0-9a-f]{32}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function invalidConfirmation(): McpExecutionError {
  return new McpExecutionError(
    'confirm_token_invalid',
    'That confirmation is invalid. Preview the action again before continuing.'
  );
}

function expiredConfirmation(): McpExecutionError {
  return new McpExecutionError(
    'confirm_token_expired',
    'That confirmation expired. Preview the action again before continuing.'
  );
}

function validInput(input: CreateDestroyConfirmationInput): boolean {
  return (
    Number.isSafeInteger(input.environmentId) &&
    input.environmentId > 0 &&
    typeof input.userId === 'string' &&
    input.userId.length > 0 &&
    Buffer.byteLength(input.userId, 'utf8') <= 255 &&
    /^[0-9a-f]{32}$/.test(input.stateHash)
  );
}

export function createDestroyConfirmation(
  input: CreateDestroyConfirmationInput,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (!validInput(input) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error('Destroy confirmation claims are invalid');
  }
  const claims: DestroyConfirmationClaims = {
    v: 1,
    action: 'destroy_environment',
    ...input,
    iat: nowSeconds,
    exp: nowSeconds + DESTROY_CONFIRMATION_TTL_SECONDS,
  };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', mcpApplicationKey(), iv);
  cipher.setAAD(TOKEN_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const token = [
    DESTROY_CONFIRMATION_TOKEN_PREFIX,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw new Error('Destroy confirmation exceeds the token-size limit');
  }
  return token;
}

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalidConfirmation();
  return decoded;
}

function isClaims(value: unknown): value is DestroyConfirmationClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Partial<DestroyConfirmationClaims>;
  const keys = ['v', 'action', 'environmentId', 'userId', 'stateHash', 'iat', 'exp'];
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key)) &&
    claims.v === 1 &&
    claims.action === 'destroy_environment' &&
    Number.isSafeInteger(claims.environmentId) &&
    Number(claims.environmentId) > 0 &&
    typeof claims.userId === 'string' &&
    claims.userId.length > 0 &&
    Buffer.byteLength(claims.userId, 'utf8') <= 255 &&
    typeof claims.stateHash === 'string' &&
    /^[0-9a-f]{32}$/.test(claims.stateHash) &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp)
  );
}

export function verifyDestroyConfirmation(
  token: string,
  expected: ExpectedDestroyConfirmation,
  nowSeconds = Math.floor(Date.now() / 1000)
): DestroyConfirmationClaims {
  try {
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      throw invalidConfirmation();
    }
    const [prefix, rawIv, rawCiphertext, rawTag, extra] = token.split('.');
    if (prefix !== DESTROY_CONFIRMATION_TOKEN_PREFIX || !rawIv || !rawCiphertext || !rawTag || extra) {
      throw invalidConfirmation();
    }
    const iv = decodeBase64Url(rawIv);
    const ciphertext = decodeBase64Url(rawCiphertext);
    const tag = decodeBase64Url(rawTag);
    if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length > 2048) {
      throw invalidConfirmation();
    }

    const decipher = createDecipheriv('aes-256-gcm', mcpApplicationKey(), iv);
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const claims = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!isClaims(claims)) throw invalidConfirmation();
    if (
      claims.iat > nowSeconds + 30 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > DESTROY_CONFIRMATION_TTL_SECONDS
    ) {
      throw invalidConfirmation();
    }
    if (claims.exp <= nowSeconds) throw expiredConfirmation();
    if (claims.environmentId !== expected.environmentId || claims.userId !== expected.userId) {
      throw invalidConfirmation();
    }
    return claims;
  } catch (error) {
    if (error instanceof McpExecutionError) throw error;
    throw invalidConfirmation();
  }
}
