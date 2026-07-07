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
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getAllConfigs: async () => ({ api_keys: { maxActivePersonalKeysPerUser: 10 } }) }),
  },
}));
jest.mock('server/services/authAudit', () => ({
  recordAuthAuditEvent: jest.fn(),
  recordAuthAuditEventInTransaction: jest.fn(),
}));

import { createHash } from 'crypto';
import ApiTokenService, { API_TOKEN_PATTERN, isRepositoryAllowed, scopeSatisfies } from 'server/services/apiToken';
import ApiToken from 'server/models/ApiToken';
import { recordAuthAuditEventInTransaction } from 'server/services/authAudit';
import { BadRequestError } from 'server/lib/appError';

const mockRecordInTx = recordAuthAuditEventInTransaction as jest.Mock;
const TRX = { __trx: true, raw: jest.fn() } as any;

const mockQuery = () => {
  const query: any = {
    insertAndFetch: jest.fn(),
    findOne: jest.fn(),
    findById: jest.fn(),
    patch: jest.fn().mockReturnThis(),
    patchAndFetchById: jest.fn(),
    orderBy: jest.fn(),
    forUpdate: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    resultSize: jest.fn().mockResolvedValue(0),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  return query;
};

let query: any;

beforeEach(() => {
  jest.clearAllMocks();
  query = mockQuery();
  (ApiToken.query as jest.Mock) = jest.fn().mockReturnValue(query);
  (ApiToken.transaction as jest.Mock) = jest.fn(async (cb: any) => cb(TRX));
  mockRecordInTx.mockReset();
  mockRecordInTx.mockResolvedValue(undefined);
});

describe('scopeSatisfies', () => {
  it('treats legacy env:admin as satisfying env scopes only', () => {
    expect(scopeSatisfies(['env:admin'], 'env:read')).toBe(true);
    expect(scopeSatisfies(['env:admin'], 'env:write')).toBe(true);
    expect(scopeSatisfies(['env:admin'], 'env:admin')).toBe(true);
    expect(scopeSatisfies(['env:admin'], 'sites:read')).toBe(false);
    expect(scopeSatisfies(['env:admin'], 'sites:write')).toBe(false);
    expect(scopeSatisfies(['env:admin'], 'repos:read')).toBe(false);
    expect(scopeSatisfies(['env:admin'], 'repos:write')).toBe(false);
  });

  it('lets write satisfy read within the same resource', () => {
    expect(scopeSatisfies(['env:write'], 'env:read')).toBe(true);
    expect(scopeSatisfies(['env:write'], 'env:write')).toBe(true);
    expect(scopeSatisfies(['sites:write'], 'sites:read')).toBe(true);
    expect(scopeSatisfies(['repos:write'], 'repos:read')).toBe(true);
    expect(scopeSatisfies(['env:write'], 'env:admin')).toBe(false);
  });

  it('never implies across resources', () => {
    expect(scopeSatisfies(['env:write'], 'sites:read')).toBe(false);
    expect(scopeSatisfies(['sites:write'], 'repos:read')).toBe(false);
    expect(scopeSatisfies(['repos:write'], 'env:read')).toBe(false);
    expect(scopeSatisfies(['env:read', 'env:write', 'env:admin'], 'sites:read')).toBe(false);
  });

  it('rejects read for write endpoints', () => {
    expect(scopeSatisfies(['env:read'], 'env:write')).toBe(false);
    expect(scopeSatisfies(['sites:read'], 'sites:write')).toBe(false);
  });

  it('rejects empty and unknown scope grants', () => {
    expect(scopeSatisfies([], 'env:read')).toBe(false);
    expect(scopeSatisfies(['bogus:write' as any], 'env:read')).toBe(false);
    expect(scopeSatisfies(['bogus:write' as any], 'bogus:read' as any)).toBe(false);
  });
});

describe('isRepositoryAllowed', () => {
  it('allows every repository when no allowlist is set', () => {
    expect(isRepositoryAllowed(null, 'org/repo')).toBe(true);
    expect(isRepositoryAllowed(undefined, 'org/repo')).toBe(true);
  });

  it('fails closed on an explicit empty allowlist', () => {
    expect(isRepositoryAllowed([], 'org/repo')).toBe(false);
  });

  it('matches allowlist entries case-insensitively', () => {
    expect(isRepositoryAllowed(['Org/Repo'], 'org/repo')).toBe(true);
    expect(isRepositoryAllowed(['org/other'], 'org/repo')).toBe(false);
  });
});

describe('issueToken', () => {
  it('stores a sha256 hash and returns the plaintext token once', async () => {
    query.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 7, ...attrs }));

    const { token, record } = await ApiTokenService.issueToken({
      name: 'ci',
      scopes: ['env:write'],
      createdBy: 'user-1',
    });

    expect(token).toMatch(/^lfc_svc_[a-f0-9]{40}$/);
    expect(query.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ci',
        tokenHash: createHash('sha256').update(token).digest('hex'),
        tokenPrefix: token.slice(0, 12),
        scopes: ['env:write'],
        repositoryAllowlist: null,
        expiresAt: null,
        createdBy: 'user-1',
      })
    );
    expect(record.tokenHash).not.toEqual(token);
  });

  it('deduplicates scopes and rejects unknown ones', async () => {
    await expect(
      ApiTokenService.issueToken({ name: 'x', scopes: ['env:root' as any], createdBy: 'u' })
    ).rejects.toThrow(BadRequestError);
    await expect(ApiTokenService.issueToken({ name: 'x', scopes: [] as any, createdBy: 'u' })).rejects.toThrow(
      BadRequestError
    );

    query.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 1, ...attrs }));
    await ApiTokenService.issueToken({ name: 'x', scopes: ['env:read', 'env:read'], createdBy: 'u' });
    expect(query.insertAndFetch).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['env:read'] }));
  });
});

describe('verifyToken', () => {
  const plaintext = `lfc_${'a'.repeat(40)}`;

  it('returns null without querying when the format is wrong', async () => {
    expect(await ApiTokenService.verifyToken('not-a-token')).toBeNull();
    expect(await ApiTokenService.verifyToken('lfc_short')).toBeNull();
    expect(await ApiTokenService.verifyToken('lfc_pat_short')).toBeNull();
    expect(ApiToken.query).not.toHaveBeenCalled();
  });

  it.each([`lfc_pat_${'a'.repeat(40)}`, `lfc_svc_${'a'.repeat(40)}`])(
    'accepts the class-prefixed shape %s on the verification side',
    async (prefixed) => {
      const record = { id: 6, revokedAt: null, expiresAt: null, lastUsedAt: new Date().toISOString() };
      query.findOne.mockResolvedValueOnce(record);

      expect(await ApiTokenService.verifyToken(prefixed)).toBe(record);
      expect(query.findOne).toHaveBeenCalledWith({
        tokenHash: createHash('sha256').update(prefixed).digest('hex'),
      });
    }
  );

  it('returns null for unknown, revoked, or expired tokens', async () => {
    query.findOne.mockResolvedValueOnce(undefined);
    expect(await ApiTokenService.verifyToken(plaintext)).toBeNull();

    query.findOne.mockResolvedValueOnce({ id: 1, revokedAt: new Date().toISOString() });
    expect(await ApiTokenService.verifyToken(plaintext)).toBeNull();

    query.findOne.mockResolvedValueOnce({
      id: 1,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await ApiTokenService.verifyToken(plaintext)).toBeNull();
  });

  it('looks up by hash and returns the live record', async () => {
    const record = { id: 3, revokedAt: null, expiresAt: null, lastUsedAt: new Date().toISOString() };
    query.findOne.mockResolvedValueOnce(record);

    expect(await ApiTokenService.verifyToken(plaintext)).toBe(record);
    expect(query.findOne).toHaveBeenCalledWith({
      tokenHash: createHash('sha256').update(plaintext).digest('hex'),
    });
  });

  it('returns a Personal key only when its authority stays within the Personal-key policy', async () => {
    const createdAt = new Date(Date.now() - 60_000);
    const record = {
      id: 4,
      ownerUserId: 'user-1',
      scopes: ['env:read'],
      repositoryAllowlist: ['org/repo'],
      repositoryAllowlistRepoIds: [42],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      lastUsedAt: new Date().toISOString(),
    };
    query.findOne.mockResolvedValueOnce(record);

    expect(await ApiTokenService.verifyToken(plaintext)).toBe(record);
  });

  it('accepts explicit all-repository access for a non-expiring Personal key', async () => {
    const createdAt = new Date(Date.now() - 60_000);
    const record = {
      id: 5,
      ownerUserId: 'user-1',
      scopes: ['env:read'],
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      createdAt: createdAt.toISOString(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: new Date().toISOString(),
    };
    query.findOne.mockResolvedValueOnce(record);

    expect(await ApiTokenService.verifyToken(plaintext)).toBe(record);
  });

  it.each([
    ['exceeds the 30-day ceiling', { expiresAtOffsetDays: 31 }],
    ['mixes all-repository names with selected repository ids', { repositoryAllowlist: null }],
    ['has an empty id allowlist for selected repositories', { repositoryAllowlistRepoIds: [] }],
    ['contains the reserved admin scope', { scopes: ['env:admin'] }],
  ])('rejects a legacy Personal key that %s', async (_reason, override) => {
    const createdAt = new Date(Date.now() - 60_000);
    const expiresAtOffsetDays = 'expiresAtOffsetDays' in override ? override.expiresAtOffsetDays : 1;
    const record = {
      id: 5,
      ownerUserId: 'user-1',
      scopes: ['env:read'],
      repositoryAllowlist: ['org/repo'],
      repositoryAllowlistRepoIds: [42],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + expiresAtOffsetDays * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      lastUsedAt: new Date().toISOString(),
      ...override,
    };
    delete (record as Record<string, unknown>).expiresAtOffsetDays;
    query.findOne.mockResolvedValueOnce(record);

    expect(await ApiTokenService.verifyToken(plaintext)).toBeNull();
    expect(query.findById).not.toHaveBeenCalled();
  });

  it('never writes lastUsedAt itself, even for a stale record', async () => {
    const stale = { id: 3, revokedAt: null, expiresAt: null, lastUsedAt: new Date(Date.now() - 120_000).toISOString() };
    query.findOne.mockResolvedValueOnce(stale);

    await ApiTokenService.verifyToken(plaintext);

    expect(query.findById).not.toHaveBeenCalled();
    expect(query.patch).not.toHaveBeenCalled();
  });
});

describe('touchLastUsed', () => {
  it('refreshes lastUsedAt only when the previous write is older than a minute', () => {
    ApiTokenService.touchLastUsed({ id: 3, lastUsedAt: new Date().toISOString() } as any);
    expect(query.findById).not.toHaveBeenCalled();

    query.findById.mockReturnValue(query);
    ApiTokenService.touchLastUsed({ id: 3, lastUsedAt: new Date(Date.now() - 120_000).toISOString() } as any);
    expect(query.findById).toHaveBeenCalledWith(3);
    expect(query.patch).toHaveBeenCalledWith({ lastUsedAt: expect.any(String) });
  });
});

describe('revokeToken', () => {
  it('revokes once and is idempotent afterwards', async () => {
    query.findById.mockResolvedValueOnce(undefined);
    expect(await ApiTokenService.revokeToken(9)).toBeNull();

    const revoked = { id: 9, revokedAt: '2026-01-01T00:00:00Z' };
    query.findById.mockResolvedValueOnce(revoked);
    expect(await ApiTokenService.revokeToken(9)).toBe(revoked);
    expect(query.patchAndFetchById).not.toHaveBeenCalled();

    query.findById.mockResolvedValueOnce({ id: 9, revokedAt: null });
    query.patchAndFetchById.mockResolvedValueOnce({ id: 9, revokedAt: 'now' });
    expect(await ApiTokenService.revokeToken(9)).toEqual({ id: 9, revokedAt: 'now' });
    expect(query.patchAndFetchById).toHaveBeenCalledWith(9, { revokedAt: expect.any(String), revokeReason: 'manual' });
    expect(query.forUpdate).toHaveBeenCalledTimes(3);
  });

  it('does not overwrite attribution or audit when the locked row is already revoked', async () => {
    const alreadyRevoked = {
      id: 9,
      kind: 'service',
      scopes: ['env:read'],
      ownerUserId: null,
      revokedAt: '2026-01-01T00:00:00Z',
      revokedBy: 'first-admin',
    };
    query.findById.mockResolvedValueOnce(alreadyRevoked);

    await expect(ApiTokenService.revokeToken(9, 'second-admin')).resolves.toBe(alreadyRevoked);

    expect(query.forUpdate).toHaveBeenCalledTimes(1);
    expect(query.patchAndFetchById).not.toHaveBeenCalled();
    expect(mockRecordInTx).not.toHaveBeenCalled();
  });
});

describe('token generation shapes (§8.1)', () => {
  it('mints service tokens as lfc_svc_<40hex>', () => {
    expect(ApiTokenService.generateServiceToken()).toMatch(/^lfc_svc_[a-f0-9]{40}$/);
  });

  it('mints personal tokens as lfc_pat_<40hex>', () => {
    expect(ApiTokenService.generatePersonalToken()).toMatch(/^lfc_pat_[a-f0-9]{40}$/);
  });

  it('issueUserToken mints a personal lfc_pat_ token', async () => {
    query.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 5, ...attrs }));

    const { token } = await ApiTokenService.issueUserToken({
      name: 'mine',
      scopes: ['env:read'],
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      expiresAt: null,
      owner: {
        userId: 'sub-1',
        githubUsername: 'octo',
        email: 'o@corp.com',
        preferredUsername: 'octo',
        displayName: 'Octo',
        roleAtIssue: 'user',
      },
    });

    expect(token).toMatch(/^lfc_pat_[a-f0-9]{40}$/);
  });

  it('still verifies a legacy lfc_<40hex> token', async () => {
    const legacy = `lfc_${'a'.repeat(40)}`;
    const record = { id: 3, revokedAt: null, expiresAt: null, lastUsedAt: new Date().toISOString() };
    query.findOne.mockResolvedValueOnce(record);

    expect(await ApiTokenService.verifyToken(legacy)).toBe(record);
    expect(API_TOKEN_PATTERN.test(legacy)).toBe(true);
  });
});

describe('durable audit on mint and revoke (D10, same transaction)', () => {
  it('issueToken writes api_token.issued inside the mint transaction', async () => {
    query.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 7, kind: 'service', ...attrs }));

    await ApiTokenService.issueToken({ name: 'ci', scopes: ['env:write'], createdBy: 'u' });

    expect(ApiToken.transaction).toHaveBeenCalledTimes(1);
    expect(mockRecordInTx).toHaveBeenCalledWith(
      TRX,
      expect.objectContaining({
        event: 'api_token.issued',
        principalKind: 'service_key',
        principalId: null,
        actorId: 'u',
        tokenId: 7,
        outcome: 'issued',
        meta: { scopes: ['env:write'], kind: 'service' },
      })
    );
  });

  it('issueUserToken writes api_token.issued with the owner as principal', async () => {
    query.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 8, kind: 'personal', ...attrs }));

    await ApiTokenService.issueUserToken({
      name: 'mine',
      scopes: ['env:read'],
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      expiresAt: null,
      owner: {
        userId: 'sub-9',
        githubUsername: null,
        email: null,
        preferredUsername: null,
        displayName: null,
        roleAtIssue: 'user',
      },
    });

    expect(mockRecordInTx).toHaveBeenCalledWith(
      TRX,
      expect.objectContaining({
        event: 'api_token.issued',
        principalKind: 'personal_key',
        principalId: 'sub-9',
        actorId: 'sub-9',
        tokenId: 8,
        outcome: 'issued',
        meta: { scopes: ['env:read'], kind: 'personal' },
      })
    );
  });

  it('revokeToken writes api_token.revoked inside the revoke transaction', async () => {
    query.findById.mockResolvedValueOnce({
      id: 9,
      kind: 'service',
      scopes: ['env:read'],
      ownerUserId: null,
      revokedAt: null,
    });
    query.patchAndFetchById.mockResolvedValueOnce({ id: 9, revokedAt: 'now' });

    await ApiTokenService.revokeToken(9, 'admin', 'manual');

    expect(mockRecordInTx).toHaveBeenCalledWith(
      TRX,
      expect.objectContaining({
        event: 'api_token.revoked',
        principalKind: 'service_key',
        actorId: 'admin',
        tokenId: 9,
        outcome: 'revoked',
        meta: { scopes: ['env:read'], kind: 'service', reason: 'manual' },
      })
    );
  });

  it('rolls the mint back when the audit insert throws', async () => {
    query.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 7, kind: 'service', ...attrs }));
    mockRecordInTx.mockRejectedValueOnce(new Error('audit boom'));

    await expect(ApiTokenService.issueToken({ name: 'ci', scopes: ['env:write'], createdBy: 'u' })).rejects.toThrow(
      'audit boom'
    );
    expect(query.insertAndFetch).toHaveBeenCalled();
  });
});
