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

import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const KEY_PREFIX = 'lfc_';
const SECRET_BYTES = 24; // 24 bytes = 32 chars base64url

export interface GeneratedApiKey {
  fullKey: string;
  keyId: string;
  secret: string;
  secretHash: string;
}

/**
 * Generate base64url-encoded string from random bytes
 */
function generateBase64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * Generate a new API key with the format: lfc_<key_id>_<secret>
 * Returns the full key (shown once to user) and components for storage
 */
export async function generateApiKey(bcryptRounds = 12): Promise<GeneratedApiKey> {
  // Generate key ID (8 chars base64url from 6 bytes)
  const keyIdBytes = crypto.randomBytes(6);
  const keyId = generateBase64Url(keyIdBytes);

  // Generate secret (32 chars base64url from 24 bytes)
  const secretBytes = crypto.randomBytes(SECRET_BYTES);
  const secret = generateBase64Url(secretBytes);

  // Create full key
  const fullKey = `${KEY_PREFIX}${keyId}_${secret}`;

  // Hash the secret portion for storage
  const secretHash = await bcrypt.hash(secret, bcryptRounds);

  return {
    fullKey,
    keyId,
    secret,
    secretHash,
  };
}

/**
 * Parse an API key into its components
 * Returns null if the format is invalid
 */
export function parseApiKey(apiKey: string): { keyId: string; secret: string } | null {
  const regex = /^lfc_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{32})$/;
  const match = apiKey.match(regex);

  if (!match) {
    return null;
  }

  const [, keyId, secret] = match;
  return { keyId, secret };
}

/**
 * Validate an API key secret against a stored hash
 */
export async function validateSecret(secret: string, storedHash: string): Promise<boolean> {
  return bcrypt.compare(secret, storedHash);
}
