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

import { scrubSecretsFromText } from './secretScrub';

describe('scrubSecretsFromText', () => {
  it.each([
    ['GitHub PAT', 'ghp_1234567890abcdefghij1234567890ABCDwxyz'],
    ['GitHub OAuth', 'gho_1234567890abcdefghij1234567890ABCD'],
    ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0abcdefghijkl_1234567890ABCD'],
    ['Anthropic key', 'sk-ant-api03-abcDEF1234567890ghIJKL_mnopqrst-uvwx'],
    ['OpenAI key', 'sk-abcDEF1234567890ghIJKL1234567890mnop'],
    ['Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv-Z'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack token', 'xoxb-1234567890-ABCDEFGHIJ-abcdefghij'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
  ])('redacts %s', (_label, secret) => {
    const scrubbed = scrubSecretsFromText(`leaked credential: ${secret} end`);
    expect(scrubbed).toBe('leaked credential: [redacted] end');
    expect(scrubbed).not.toContain(secret);
  });

  it('keeps the auth scheme but redacts the credential', () => {
    expect(scrubSecretsFromText('Authorization: Bearer abcdef0123456789abcdefXYZ')).toBe(
      'Authorization: Bearer [redacted]'
    );
    expect(scrubSecretsFromText('auth = Basic dXNlcjpwYXNzd29yZDEyMzQ=')).toBe('auth = Basic [redacted]');
  });

  it('keeps the key name and operator while redacting the value', () => {
    expect(scrubSecretsFromText('API_KEY=supersecretvalue123')).toBe('API_KEY=[redacted]');
    expect(scrubSecretsFromText('password: hunter2hunter2')).toBe('password: [redacted]');
    expect(scrubSecretsFromText('config has API_KEY="s3cr3tValue123" set')).toBe('config has API_KEY="[redacted]" set');
  });

  it('redacts aws_secret_access_key and the Lifecycle gateway token assignments', () => {
    expect(scrubSecretsFromText('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdefK7MDENGbPxRfiCYEXAMPLE')).toBe(
      'AWS_SECRET_ACCESS_KEY=[redacted]'
    );
    const gatewayToken = 'a'.repeat(64);
    expect(scrubSecretsFromText(`LIFECYCLE_GATEWAY_TOKEN=${gatewayToken}`)).toBe('LIFECYCLE_GATEWAY_TOKEN=[redacted]');
  });

  it('does NOT over-redact ordinary reasoning prose, git SHAs, or file paths', () => {
    const reasoning =
      'While reviewing commit 0a1b2c3d4e5f60718293a4b5c6d7e8f901234567 I traced the token handling bug ' +
      'to src/server/lib/secretScrub.ts and updated the helper. The change looks correct and the password ' +
      'reset flow still works as expected.';
    expect(scrubSecretsFromText(reasoning)).toBe(reasoning);
  });

  it('is a no-op on empty input', () => {
    expect(scrubSecretsFromText('')).toBe('');
  });
});
