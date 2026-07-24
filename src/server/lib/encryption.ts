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

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/** True when ENCRYPTION_KEY is set to a usable 64-char hex string (does not throw). */
export function isEncryptionKeyConfigured(): boolean {
  const hex = process.env.ENCRYPTION_KEY;
  return Boolean(hex && hex.length === 64);
}

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). ' +
        'For local development, set secrets.encryptionKey in helm/environments/local/secrets.yaml ' +
        'or export ENCRYPTION_KEY.'
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// Discriminates ciphertext from legacy plaintext config secrets (migrate-on-write).
const CONFIG_SECRET_PREFIX = 'lc-enc:v1:';

export function encryptConfigSecret(plaintext: string): string {
  return CONFIG_SECRET_PREFIX + encrypt(plaintext);
}

export function isEncryptedConfigSecret(value: string): boolean {
  return value.startsWith(CONFIG_SECRET_PREFIX);
}

export function decryptConfigSecret(value: string): string {
  try {
    return decrypt(value.slice(CONFIG_SECRET_PREFIX.length));
  } catch {
    // Never hand a garbled value upstream as a credential.
    throw new Error(
      'Stored credential could not be decrypted; verify ENCRYPTION_KEY matches the key used when it was saved.'
    );
  }
}

export function maskApiKey(key: string): string {
  if (key.length < 10) {
    return '*'.repeat(key.length);
  }
  return key.slice(0, 6) + '...' + key.slice(-4);
}
