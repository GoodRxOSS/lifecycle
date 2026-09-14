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

import { authenticateAccessToken, createShellPorts } from './authenticate';
const verify = jest.fn();
const resolve = jest.fn();
jest.mock('server/lib/auth', () => ({ verifyBearerToken: (token: string) => verify(token) }));
jest.mock('./target', () => ({ resolveTarget: (...args: unknown[]) => resolve(...args) }));
jest.mock('server/services/authAudit', () => ({ recordAuthAuditEvent: jest.fn().mockResolvedValue(undefined) }));
const token = (overrides = {}) => ({
  success: true,
  payload: { sub: 'user-id', exp: Date.now() / 1000 + 3600, realm_access: { roles: ['user'] }, ...overrides },
});
describe('pod shell authentication', () => {
  const original = process.env.ENABLE_AUTH;
  beforeEach(() => {
    process.env.ENABLE_AUTH = 'true';
    verify.mockResolvedValue(token());
  });
  afterAll(() => {
    if (original === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = original;
  });
  test('uses the shared verifier and verified claims', async () => {
    const { principal } = await authenticateAccessToken('existing-token');
    expect(verify).toHaveBeenCalledWith('existing-token');
    expect(principal.userId).toBe('user-id');
    expect(principal.roles).toEqual(['user']);
  });
  test('fails closed when normal authentication is disabled', async () => {
    process.env.ENABLE_AUTH = 'false';
    await expect(authenticateAccessToken('token')).rejects.toMatchObject({ code: 'auth_required' });
    expect(verify).not.toHaveBeenCalled();
  });
  test('rejects an invalid credential', async () => {
    verify.mockResolvedValue({ success: false });
    await expect(authenticateAccessToken('token')).rejects.toMatchObject({ code: 'invalid_credential' });
  });
  test.each([{ sub: '' }, { realm_access: { roles: ['viewer'] } }, { exp: 0 }, { exp: undefined }, { exp: 1e308 }])(
    'rejects invalid subject, role or expiry %j',
    async (overrides) => {
      verify.mockResolvedValue(token(overrides));
      await expect(authenticateAccessToken('token')).rejects.toBeInstanceOf(Error);
    }
  );
  test('rejects a stale selected pod before returning a session', async () => {
    resolve.mockResolvedValue({ podUid: 'replacement', restartCount: 0 });
    const ports = createShellPorts(() => true);
    await expect(
      ports.authorize(
        {
          type: 'auth',
          accessToken: 'token',
          podUid: 'old',
          container: 'app',
          restartCount: 0,
          shell: '/bin/sh',
          cols: 80,
          rows: 24,
        },
        'uuid',
        'pod'
      )
    ).rejects.toMatchObject({ code: 'target_changed' });
  });
});
