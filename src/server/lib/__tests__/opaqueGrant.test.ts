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

import { openGrant, sealGrant } from '../opaqueGrant';

const originalEnv = { ...process.env };
const kind = { prefix: 'test_v1', aad: 'lifecycle.test' };
const secretNames = ['CHAT_PREVIEW_GRANT_SECRET', 'ENCRYPTION_KEY', 'NEXTAUTH_SECRET', 'GITHUB_WEBHOOK_SECRET'];

beforeEach(() => {
  for (const name of secretNames) delete process.env[name];
  process.env.ENABLE_AUTH = 'true';
  process.env.APP_ENV = 'production';
});
afterEach(() => {
  process.env = { ...originalEnv };
});

it.each(secretNames)('can seal and open grants using the configured %s', (name) => {
  process.env[name] = 'test-grant-secret';
  const grant = sealGrant(kind, { value: 'payload' });
  expect(openGrant(kind, grant)).toEqual({ value: 'payload' });
  expect(openGrant({ ...kind, aad: 'lifecycle.other' }, grant)).toBeNull();
});

it.each(['changeme', 'not_setup', 'YOUR_VALUE_HERE', 'replace_me', 'REPLACE_ME', '   '])(
  'rejects the placeholder secret %s',
  (secret) => {
    process.env.CHAT_PREVIEW_GRANT_SECRET = secret;
    expect(() => sealGrant(kind, {})).toThrow('must be configured');
  }
);

it('does not use a weaker fallback when a configured preferred secret is invalid', () => {
  process.env.CHAT_PREVIEW_GRANT_SECRET = 'YOUR_VALUE_HERE';
  process.env.ENCRYPTION_KEY = 'valid-fallback';
  expect(() => sealGrant(kind, {})).toThrow('must be configured');
});

it.each(['production', 'staging', undefined])('does not use a development key with APP_ENV=%s', (environment) => {
  delete process.env.ENABLE_AUTH;
  if (environment === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = environment;
  expect(() => sealGrant(kind, {})).toThrow('must be configured');
});

it.each(['dev', 'development'])(
  'permits a development key only with explicit %s and disabled authentication',
  (environment) => {
    process.env.APP_ENV = environment;
    delete process.env.ENABLE_AUTH;
    const grant = sealGrant(kind, { value: 'payload' });
    expect(openGrant(kind, grant)).toEqual({ value: 'payload' });
    process.env.ENABLE_AUTH = 'true';
    expect(openGrant(kind, grant)).toBeNull();
    expect(() => sealGrant(kind, {})).toThrow('must be configured');
  }
);

it('rejects tickets after the shared key changes', () => {
  process.env.CHAT_PREVIEW_GRANT_SECRET = 'first-test-key';
  const grant = sealGrant(kind, {});
  process.env.CHAT_PREVIEW_GRANT_SECRET = 'second-test-key';
  expect(openGrant(kind, grant)).toBeNull();
});
