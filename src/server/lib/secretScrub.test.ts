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

  it('redacts Lifecycle key shapes, embedded deny-key assignments, and PEM private keys', () => {
    const lifecycleKey = `lfc_${'a'.repeat(32)}`;
    expect(scrubSecretsFromText(`key=${lifecycleKey}`)).toBe('key=[redacted]');
    expect(scrubSecretsFromText('MY_SERVICE_TOKEN=supersecretvalue123')).toBe('MY_SERVICE_TOKEN=[redacted]');
    expect(scrubSecretsFromText('-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----')).toBe(
      '[redacted]'
    );
    expect(
      scrubSecretsFromText('boom -----BEGIN RSA PRIVATE KEY----- material -----END RSA PRIVATE KEY----- tail')
    ).toBe('boom [redacted] tail');
  });

  it('redacts a private key block that a cut left without its END line', () => {
    expect(scrubSecretsFromText('key: -----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw...')).toBe(
      'key: [redacted]'
    );
    expect(scrubSecretsFromText('key: -----BEGIN RSA PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEF\\nAASCBKcw')).toBe(
      'key: [redacted]'
    );
    expect(scrubSecretsFromText('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\nAASCBKcw…')).toBe(
      '[redacted]'
    );
  });

  it('redacts a key body whose END line is cut, malformed, or followed by other text', () => {
    const body = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgSECRETSECRETSECRETSECRETSECRE';
    expect(scrubSecretsFromText(`x: -----BEGIN PRIVATE KEY----- ${body} privatebytes1234 -----END PRI...`)).toBe(
      'x: [redacted] -----END PRI...'
    );
    expect(
      scrubSecretsFromText(`Invalid value: "-----BEGIN PRIVATE KEY----- ${body} -----END PRIVATE KEY----": failed`)
    ).toBe('Invalid value: "[redacted] -----END PRIVATE KEY----": failed');
    expect(scrubSecretsFromText(`{"m":"-----BEGIN PRIVATE KEY----- ${body}"}`)).toBe('{"m":"[redacted]"}');
    expect(
      scrubSecretsFromText(
        'helm: -----BEGIN RSA PRIVATE KEY----- Proc-Type: 4,ENCRYPTED DEK-Info: AES-128-CBC,5B3A2C1D5B3A2C1D5B3A2C1D5B3A2C1D MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj -----END RSA PRI...'
      )
    ).toBe('helm: [redacted] -----END RSA PRI...');
  });

  it('redacts a short key body wherever a stored status cut lands', () => {
    const lines = [
      'MHcCAQEEIKxZ9vQ2pL7mN3wT8sR1uY6hJ4bF0dC5aE2gV8kQ9zXnoAoGCCqGSM49',
      'AwEHoUQDQgAEt7Uq2sB8nL8bXc2vZ9yR4tE1uW7oI6kJ3hG5fD2sA1qW3eR4tY5u',
      'nL8bXc2vZ9yR4tE1uW7oI6kJ3hG5fD2sA==',
    ];
    for (const separator of ['\n', '\\n', '\\n    ', '\\r\\n ']) {
      const block = `-----BEGIN EC PRIVATE KEY-----${separator}${lines.join(
        separator
      )}${separator}-----END EC PRIVATE KEY-----`;
      for (let cut = 0; cut <= block.length; cut++) {
        const scrubbed = scrubSecretsFromText(`data.tls.key: ${block.slice(0, cut)}...`);
        expect(scrubbed).not.toContain('MHcCAQEEI');
        expect(scrubbed).not.toContain(lines[2]);
      }
    }
  });

  it('keeps the words that follow a key body and redacts an escaped, indented body', () => {
    const line = 'MHcCAQEEIKxZ9vQ2pL7mN3wT8sR1uY6hJ4bF0dC5aE2gV8kQ9zXnoAoGCCqGSM49';
    expect(
      scrubSecretsFromText(`tls.key: -----BEGIN EC PRIVATE KEY----- ${line} ${line} is invalid: expected PKCS8 format`)
    ).toBe('tls.key: [redacted] is invalid: expected PKCS8 format');
    expect(
      scrubSecretsFromText(
        'secret tls has key -----BEGIN PRIVATE KEY----- 0a1b2c3d4e5f60718293a4b5c6d7e8f901234567 which is not a key.'
      )
    ).toBe('secret tls has key [redacted] which is not a key.');
    expect(
      scrubSecretsFromText(
        `{"m":"-----BEGIN EC PRIVATE KEY-----\\n ${line}\\n ${line}\\n nL8bXc2vZ9yR4tE1uW7oI6kJ3hG5fD2sA==\\n"}`
      )
    ).toBe('{"m":"[redacted]\\n"}');
    expect(
      scrubSecretsFromText(
        `{"m":"-----BEGIN EC PRIVATE KEY-----\\n${line}\\n ${line}\\n nL8bXc2vZ9yR4tE1uW7oI6kJ3hG5fD2sA=="}`
      )
    ).toBe('{"m":"[redacted]"}');
  });

  it.each([
    ['Proc-Type', 'Proc-Type: 4,ENCRYPTED'],
    ['DEK-Info', 'Proc-Type: 4,ENCRYPTED\\nDEK-Info: AES-128-CBC,ABCD'],
  ])('scans a %s header followed by escaped newlines in linear time', (_name, header) => {
    const escaped = `-----BEGIN RSA PRIVATE KEY-----\\n${header}${'\\n'.repeat(65_536)}`;
    const started = Date.now();
    expect(scrubSecretsFromText(escaped)).toBe(escaped);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps prose and log lines that follow a private key header with no key', () => {
    const prose =
      'The tls.key value must start with -----BEGIN PRIVATE KEY-----. The secret holds a certificate instead.';
    expect(scrubSecretsFromText(prose)).toBe(prose);
    const log = 'expected -----BEGIN RSA PRIVATE KEY-----\nconnect ECONNREFUSED 10.0.0.5:5432\nexiting with code 1';
    expect(scrubSecretsFromText(log)).toBe(log);
    const grep = './a.key:1:-----BEGIN PRIVATE KEY-----\n./b.key:1:-----BEGIN RSA PRIVATE KEY-----';
    expect(scrubSecretsFromText(grep)).toBe(grep);
  });

  it('keeps long unbroken runs intact and scans them in linear time', () => {
    const run = 'a-'.repeat(50_000);
    const started = Date.now();
    expect(scrubSecretsFromText(`${run} GITHUB_TOKEN=ghp_${'x'.repeat(30)} my-app-api-key: "${'v'.repeat(12)}"`)).toBe(
      `${run} GITHUB_TOKEN=[redacted] my-app-api-key: "[redacted]"`
    );
    expect(Date.now() - started).toBeLessThan(2_000);
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
