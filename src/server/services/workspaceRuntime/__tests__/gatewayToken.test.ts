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

import { decryptSessionSecretEnv, encryptSessionSecretEnv, mintKubernetesGatewayToken } from '../gatewayToken';

const HEX_KEY = 'a01b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b';

describe('mintKubernetesGatewayToken', () => {
  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it('mints and encrypts a token when ENCRYPTION_KEY is configured', () => {
    process.env.ENCRYPTION_KEY = HEX_KEY;
    const { gatewayToken, encryptedGatewayToken } = mintKubernetesGatewayToken();
    expect(gatewayToken).toMatch(/^[0-9a-f]{64}$/);
    expect(encryptedGatewayToken).toEqual(expect.any(String));
    expect(encryptedGatewayToken).not.toBe(gatewayToken);
  });

  it('degrades to no token (no enforcement) when ENCRYPTION_KEY is unset', () => {
    expect(mintKubernetesGatewayToken()).toEqual({});
  });
});

describe('session secret env round-trip', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = HEX_KEY;
  });
  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it('encrypts and decrypts a string env map round-trip', () => {
    const env = { GITHUB_TOKEN: 'ghp_secretvalue123', ANTHROPIC_API_KEY: 'sk-ant-secret' };
    const ciphertext = encryptSessionSecretEnv(env);
    expect(ciphertext).not.toContain('ghp_secretvalue123');
    expect(decryptSessionSecretEnv(ciphertext)).toEqual(env);
  });

  it('raises a clear error rather than handing back a garbled credential', () => {
    expect(() => decryptSessionSecretEnv('not-ciphertext')).toThrow(/could not be decrypted/);
  });
});
