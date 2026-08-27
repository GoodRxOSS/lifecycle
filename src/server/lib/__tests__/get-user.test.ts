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

import type { NextRequest } from 'next/server';

import { UnauthorizedError } from '../appError';
import {
  getIdentityFromClaims,
  getRequestUserIdentity,
  getRequestUserSub,
  getUser,
  requireRequestUserIdentity,
} from '../get-user';

function makeRequest(userClaims?: Record<string, unknown>): NextRequest {
  const headers = new Headers();
  if (userClaims) {
    headers.set('x-user', Buffer.from(JSON.stringify(userClaims), 'utf8').toString('base64url'));
  }

  return { headers } as unknown as NextRequest;
}

describe('get-user helpers', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;
  const originalLocalDevUserId = process.env.LOCAL_DEV_USER_ID;

  const restoreEnv = () => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }

    if (originalLocalDevUserId === undefined) {
      delete process.env.LOCAL_DEV_USER_ID;
    } else {
      process.env.LOCAL_DEV_USER_ID = originalLocalDevUserId;
    }
  };

  afterEach(() => {
    restoreEnv();
  });

  it('decodes x-user payloads', () => {
    const payload = getUser(makeRequest({ sub: 'user-123', github_username: 'sample-user' }));
    expect(payload?.sub).toBe('user-123');
    expect(payload?.github_username).toBe('sample-user');
  });

  it('returns null for an x-user header that is not valid JSON', () => {
    const request = makeRequest();
    request.headers.set('x-user', Buffer.from('{invalid-json', 'utf8').toString('base64url'));

    expect(getUser(request)).toBeNull();
  });

  it('trims a request subject and rejects a blank subject when auth is enabled', () => {
    process.env.ENABLE_AUTH = 'true';

    expect(getRequestUserSub(makeRequest({ sub: '  user-123  ' }))).toBe('user-123');
    expect(getRequestUserSub(makeRequest({ sub: '   ' }))).toBeNull();
  });

  it('returns null when auth is enabled and no user is present', () => {
    process.env.ENABLE_AUTH = 'true';

    expect(getRequestUserSub(makeRequest())).toBeNull();
  });

  it('returns a stable local dev user when auth is disabled', () => {
    process.env.ENABLE_AUTH = 'false';

    expect(getRequestUserSub(makeRequest())).toBe('local-dev-user');
  });

  it('uses LOCAL_DEV_USER_ID when configured', () => {
    process.env.ENABLE_AUTH = 'false';
    process.env.LOCAL_DEV_USER_ID = 'vm-local';

    expect(getRequestUserSub(makeRequest())).toBe('vm-local');
  });

  it('builds a rich request user identity from token claims', () => {
    const identity = getRequestUserIdentity(
      makeRequest({
        sub: 'user-123',
        github_username: 'sample-user',
        given_name: 'Sample',
        family_name: 'User',
        email: 'sample-user@example.com',
        realm_access: { roles: ['user', 'admin', 'offline_access'] },
      })
    );

    expect(identity).toEqual(
      expect.objectContaining({
        userId: 'user-123',
        githubUsername: 'sample-user',
        email: 'sample-user@example.com',
        displayName: 'Sample User',
        gitUserName: 'Sample User',
        gitUserEmail: 'sample-user@example.com',
        roles: ['user', 'admin'],
      })
    );
  });

  it('falls back to local-dev identity when auth is disabled', () => {
    process.env.ENABLE_AUTH = 'false';

    expect(getRequestUserIdentity(makeRequest())).toEqual(
      expect.objectContaining({
        userId: 'local-dev-user',
        displayName: 'local-dev-user',
        gitUserName: 'local-dev-user',
        gitUserEmail: 'local-dev-user@users.noreply.github.com',
        roles: ['admin'],
      })
    );
  });

  it('builds an identity directly from verified claims', () => {
    expect(
      getIdentityFromClaims({
        sub: 'claims-user',
        name: 'Claims User',
        email: 'claims-user@example.com',
        realm_access: { roles: ['user'] },
      })
    ).toEqual(
      expect.objectContaining({
        userId: 'claims-user',
        displayName: 'Claims User',
        gitUserEmail: 'claims-user@example.com',
        roles: ['user'],
      })
    );
  });

  it.each([
    ['developer/one', 'developer-one@local.lifecycle'],
    ['***', '-@local.lifecycle'],
  ])('builds the local Git fallback email for configured identifier %p', (userId, gitUserEmail) => {
    process.env.ENABLE_AUTH = 'false';
    process.env.LOCAL_DEV_USER_ID = userId;

    expect(getIdentityFromClaims(null)).toEqual(
      expect.objectContaining({
        userId,
        displayName: userId,
        gitUserEmail,
        roles: ['admin'],
      })
    );
  });

  it('returns null from claims when authentication is required and no subject exists', () => {
    process.env.ENABLE_AUTH = 'true';

    expect(getIdentityFromClaims(null)).toBeNull();
  });

  it('requires an authenticated identity and exposes the coded unauthorized error', () => {
    process.env.ENABLE_AUTH = 'true';
    let failure: unknown;

    try {
      requireRequestUserIdentity(makeRequest());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UnauthorizedError);
    expect(failure).toMatchObject({
      httpStatus: 401,
      code: 'unauthorized',
      message: 'Authentication is required.',
    });
  });

  it('returns the required identity when a valid subject is present', () => {
    process.env.ENABLE_AUTH = 'true';

    expect(requireRequestUserIdentity(makeRequest({ sub: 'required-user', name: 'Required User' }))).toEqual(
      expect.objectContaining({
        userId: 'required-user',
        displayName: 'Required User',
      })
    );
  });
});
