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

jest.mock('server/models/ApiToken');
jest.mock('server/models/Repository');
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/services/globalConfig', () => {
  const getConfig = jest.fn();
  return { __esModule: true, default: { getInstance: () => ({ getConfig }) }, __getConfig: getConfig };
});
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import ApiToken from 'server/models/ApiToken';
import { resolvePrincipal } from '../principal';

const mockGetConfig = (jest.requireMock('server/services/globalConfig') as any).__getConfig as jest.Mock;

const LEGACY_TOKEN = `lfc_${'a'.repeat(40)}`;
const PAT_TOKEN = `lfc_pat_${'b'.repeat(40)}`;
const SVC_TOKEN = `lfc_svc_${'c'.repeat(40)}`;

const encodeUser = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const request = (headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/v2/environments', { headers });

const keyRequest = (token: string, extra: Record<string, string> = {}) =>
  request({ authorization: `Bearer ${token}`, ...extra });

const personalRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 9,
  name: 'mine',
  kind: 'personal',
  scopes: ['env:read', 'env:write'],
  repositoryAllowlist: ['org/repo'],
  repositoryAllowlistRepoIds: [42],
  ownerUserId: 'sub-1',
  ownerGithubUsername: 'octo',
  ownerEmail: 'owner@corp.com',
  ownerPreferredUsername: 'octo-pref',
  ownerDisplayName: 'Octo Cat',
  createdAt: new Date().toISOString(),
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: new Date().toISOString(),
  ...overrides,
});

const serviceRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 3,
  name: 'ci',
  kind: 'service',
  scopes: ['env:write'],
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  ownerUserId: null,
  createdAt: new Date().toISOString(),
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: new Date().toISOString(),
  ...overrides,
});

let query: any;
const originalEnableAuth = process.env.ENABLE_AUTH;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  query = {
    findOne: jest.fn(),
    findById: jest.fn().mockReturnThis(),
    patch: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  (ApiToken.query as jest.Mock) = jest.fn(() => query);
  mockGetConfig.mockResolvedValue({ personalAuthEnabled: true, serviceAuthEnabled: true });
});

afterAll(() => {
  if (originalEnableAuth === undefined) {
    delete process.env.ENABLE_AUTH;
  } else {
    process.env.ENABLE_AUTH = originalEnableAuth;
  }
});

describe('resolvePrincipal with API keys', () => {
  it('resolves a valid personal key to a personal_key principal acting as the owner', async () => {
    query.findOne.mockResolvedValue(personalRecord());

    const principal = await resolvePrincipal(keyRequest(PAT_TOKEN));

    expect(principal).toEqual({
      kind: 'personal_key',
      authMethod: 'api_key',
      userId: 'sub-1',
      actor: 'sub-1',
      roles: [],
      scopes: ['env:read', 'env:write'],
      tokenId: 9,
      repositoryAllowlist: ['org/repo'],
      repositoryAllowlistRepoIds: [42],
      identity: {
        userId: 'sub-1',
        githubUsername: 'octo',
        preferredUsername: 'octo-pref',
        email: 'owner@corp.com',
        firstName: null,
        lastName: null,
        displayName: 'Octo Cat',
        gitUserName: 'Octo Cat',
        gitUserEmail: 'owner@corp.com',
        roles: [],
      },
    });
  });

  it('rebuilds the display name through the snapshot chain and falls back to the sub', async () => {
    query.findOne.mockResolvedValueOnce(personalRecord({ ownerDisplayName: null }));
    expect((await resolvePrincipal(keyRequest(LEGACY_TOKEN))).identity?.displayName).toBe('octo');

    query.findOne.mockResolvedValueOnce(personalRecord({ ownerDisplayName: null, ownerGithubUsername: null }));
    expect((await resolvePrincipal(keyRequest(LEGACY_TOKEN))).identity?.displayName).toBe('octo-pref');

    query.findOne.mockResolvedValueOnce(
      personalRecord({ ownerDisplayName: null, ownerGithubUsername: null, ownerPreferredUsername: null })
    );
    const principal = await resolvePrincipal(keyRequest(LEGACY_TOKEN));
    expect(principal.identity?.displayName).toBe('sub-1');
    expect(principal.identity?.gitUserName).toBe('sub-1');
  });

  it('derives gitUserEmail from the owner email snapshot, empty when absent', async () => {
    query.findOne.mockResolvedValueOnce(personalRecord());
    expect((await resolvePrincipal(keyRequest(LEGACY_TOKEN))).identity?.gitUserEmail).toBe('owner@corp.com');

    query.findOne.mockResolvedValueOnce(personalRecord({ ownerEmail: null }));
    const principal = await resolvePrincipal(keyRequest(LEGACY_TOKEN));
    expect(principal.identity?.email).toBeNull();
    expect(principal.identity?.gitUserEmail).toBe('');
  });

  it('resolves a valid service key to a service_key principal with no identity', async () => {
    query.findOne.mockResolvedValue(serviceRecord());

    const principal = await resolvePrincipal(keyRequest(SVC_TOKEN));

    expect(principal).toEqual({
      kind: 'service_key',
      authMethod: 'api_key',
      userId: null,
      actor: 'token:ci',
      roles: [],
      scopes: ['env:write'],
      tokenId: 3,
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      identity: null,
    });
  });

  it('prefers the key over a present x-user header', async () => {
    query.findOne.mockResolvedValue(serviceRecord());

    const principal = await resolvePrincipal(
      keyRequest(LEGACY_TOKEN, { 'x-user': encodeUser({ sub: 'u-1', realm_access: { roles: ['admin'] } }) })
    );

    expect(principal.kind).toBe('service_key');
  });

  it('401s invalid_credential for unknown, revoked, and expired keys', async () => {
    query.findOne.mockResolvedValueOnce(undefined);
    await expect(resolvePrincipal(keyRequest(LEGACY_TOKEN))).rejects.toMatchObject({
      httpStatus: 401,
      code: 'invalid_credential',
    });

    query.findOne.mockResolvedValueOnce(personalRecord({ revokedAt: new Date().toISOString() }));
    await expect(resolvePrincipal(keyRequest(PAT_TOKEN))).rejects.toMatchObject({
      httpStatus: 401,
      code: 'invalid_credential',
    });

    query.findOne.mockResolvedValueOnce(personalRecord({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await expect(resolvePrincipal(keyRequest(PAT_TOKEN))).rejects.toMatchObject({
      httpStatus: 401,
      code: 'invalid_credential',
    });
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it('403s api_keys_disabled for personal keys when personalAuthEnabled is off', async () => {
    mockGetConfig.mockResolvedValue({ personalAuthEnabled: false, serviceAuthEnabled: true });

    query.findOne.mockResolvedValueOnce(personalRecord());
    await expect(resolvePrincipal(keyRequest(PAT_TOKEN))).rejects.toMatchObject({
      httpStatus: 403,
      code: 'api_keys_disabled',
    });

    query.findOne.mockResolvedValueOnce(serviceRecord());
    await expect(resolvePrincipal(keyRequest(SVC_TOKEN))).resolves.toMatchObject({ kind: 'service_key' });
  });

  it('403s api_keys_disabled for service keys when serviceAuthEnabled is off', async () => {
    mockGetConfig.mockResolvedValue({ personalAuthEnabled: true, serviceAuthEnabled: false });

    query.findOne.mockResolvedValueOnce(serviceRecord());
    await expect(resolvePrincipal(keyRequest(SVC_TOKEN))).rejects.toMatchObject({
      httpStatus: 403,
      code: 'api_keys_disabled',
    });

    query.findOne.mockResolvedValueOnce(personalRecord());
    await expect(resolvePrincipal(keyRequest(PAT_TOKEN))).resolves.toMatchObject({ kind: 'personal_key' });
  });

  it('does not refresh lastUsedAt when the kill switch denies the key', async () => {
    mockGetConfig.mockResolvedValue({ personalAuthEnabled: false, serviceAuthEnabled: true });
    query.findOne.mockResolvedValueOnce(personalRecord({ lastUsedAt: new Date(Date.now() - 120_000).toISOString() }));

    await expect(resolvePrincipal(keyRequest(PAT_TOKEN))).rejects.toMatchObject({ code: 'api_keys_disabled' });

    expect(query.findById).not.toHaveBeenCalled();
    expect(query.patch).not.toHaveBeenCalled();
  });

  it('refreshes a stale lastUsedAt once the key fully authenticates', async () => {
    query.findOne.mockResolvedValueOnce(serviceRecord({ lastUsedAt: new Date(Date.now() - 120_000).toISOString() }));

    await resolvePrincipal(keyRequest(SVC_TOKEN));

    expect(query.findById).toHaveBeenCalledWith(3);
    expect(query.patch).toHaveBeenCalledWith({ lastUsedAt: expect.any(String) });
  });

  it('fails closed when the api_keys config row is absent', async () => {
    mockGetConfig.mockResolvedValue(undefined);
    query.findOne.mockResolvedValue(serviceRecord());

    await expect(resolvePrincipal(keyRequest(SVC_TOKEN))).rejects.toMatchObject({
      httpStatus: 403,
      code: 'api_keys_disabled',
    });
  });

  it('refuses keys before any DB lookup while ENABLE_AUTH is off', async () => {
    process.env.ENABLE_AUTH = 'false';

    await expect(resolvePrincipal(keyRequest(LEGACY_TOKEN))).rejects.toMatchObject({
      httpStatus: 401,
      code: 'invalid_credential',
    });
    expect(ApiToken.query).not.toHaveBeenCalled();
    expect(mockGetConfig).not.toHaveBeenCalled();
  });
});

describe('resolvePrincipal with sessions', () => {
  it('resolves a middleware-verified x-user to an unscoped user principal', async () => {
    const principal = await resolvePrincipal(
      request({
        'x-user': encodeUser({
          sub: 'u-1',
          email: 'alice@corp.com',
          name: 'Alice Doe',
          realm_access: { roles: ['user'] },
        }),
      })
    );

    expect(principal).toMatchObject({
      kind: 'user',
      authMethod: 'session',
      userId: 'u-1',
      actor: 'u-1',
      roles: ['user'],
      scopes: null,
      tokenId: null,
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
    });
    expect(principal.identity).toMatchObject({ userId: 'u-1', displayName: 'Alice Doe', email: 'alice@corp.com' });
  });

  it('throws authentication_required with no credential while auth is on', async () => {
    await expect(resolvePrincipal(request())).rejects.toMatchObject({
      httpStatus: 401,
      code: 'authentication_required',
    });
  });

  it('falls open to the local-dev admin principal while auth is off', async () => {
    process.env.ENABLE_AUTH = 'false';

    const principal = await resolvePrincipal(request());

    expect(principal).toMatchObject({
      kind: 'user',
      authMethod: 'session',
      userId: 'local-dev-user',
      actor: 'local-dev-user',
      roles: ['admin'],
      scopes: null,
      tokenId: null,
    });
    expect(principal.identity?.displayName).toBe('local-dev-user');
  });
});
