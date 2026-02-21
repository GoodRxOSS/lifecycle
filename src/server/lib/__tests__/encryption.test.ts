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

import { encrypt, decrypt, maskApiKey } from 'server/lib/encryption';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a01b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b';
});

afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe('encryption', () => {
  describe('encrypt/decrypt', () => {
    test('round-trips a string', () => {
      const plaintext = 'sk-ant-api03-abcdefghijklmnop';
      const ciphertext = encrypt(plaintext);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    test('round-trips an empty string', () => {
      const plaintext = '';
      const ciphertext = encrypt(plaintext);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    test('round-trips a long string', () => {
      const plaintext = 'x'.repeat(10000);
      const ciphertext = encrypt(plaintext);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    test('produces different ciphertexts for the same input (random IV)', () => {
      const plaintext = 'sk-ant-api03-abcdefghijklmnop';
      const ciphertext1 = encrypt(plaintext);
      const ciphertext2 = encrypt(plaintext);
      expect(ciphertext1).not.toBe(ciphertext2);
    });

    test('throws when ENCRYPTION_KEY is not set', () => {
      const originalKey = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      expect(() => encrypt('test')).toThrow();
      process.env.ENCRYPTION_KEY = originalKey;
    });
  });

  describe('maskApiKey', () => {
    test('masks the middle of a key', () => {
      const key = 'sk-ant-api03-abcdefghijklmnop';
      const masked = maskApiKey(key);
      expect(masked).toBe('sk-ant...mnop');
    });

    test('handles short keys (less than 10 chars)', () => {
      const key = 'abcd';
      const masked = maskApiKey(key);
      expect(masked).toBe('****');
    });

    test('handles keys exactly 10 chars long', () => {
      const key = 'abcdefghij';
      const masked = maskApiKey(key);
      expect(masked).toBe('abcdef...ghij');
    });
  });
});
