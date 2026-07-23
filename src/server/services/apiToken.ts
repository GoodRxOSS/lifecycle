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

import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type { Transaction } from 'objection';
import ApiToken, { ApiTokenScope } from 'server/models/ApiToken';
import Repository from 'server/models/Repository';
import GlobalConfigService from 'server/services/globalConfig';
import { recordAuthAuditEventInTransaction } from 'server/services/authAudit';
import { AppError, BadRequestError } from 'server/lib/appError';
import { API_TOKEN_PATTERN } from 'server/lib/apiTokenShape';
import { getLogger } from 'server/lib/logger';
import { GITHUB_APP_INSTALLATION_ID } from 'shared/config';
import { paginate, type PaginationMetadata, type PaginationParams } from 'server/lib/paginate';

export const API_TOKEN_SCOPES: ApiTokenScope[] = [
  'env:read',
  'env:write',
  'env:admin',
  'sites:read',
  'sites:write',
  'repos:read',
  'repos:write',
];
export { API_TOKEN_PATTERN };

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const HOUR_MS = 3_600_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const ISO_DATETIME = z.iso.datetime({ offset: true });

// A Personal key's effective ceiling is fixed, NOT a literal intersection with resolveMachineAuth's map
// (which sends admin -> ['env:admin']); env:admin is reserved to legacy admin-minted org tokens.
export const USER_TOKEN_CEILING: ApiTokenScope[] = [
  'env:read',
  'env:write',
  'sites:read',
  'sites:write',
  'repos:read',
  'repos:write',
];
export const PERSONAL_TOKEN_DEFAULT_TTL_HOURS = 168;
export const PERSONAL_TOKEN_MAX_TTL_HOURS = 720;
const DEFAULT_MAX_ACTIVE_PERSONAL_KEYS = 10;
export const TOKEN_ALLOWLIST_MAX_ENTRIES = 50;
const TOKEN_ALLOWLIST_MAX_ENTRY_LENGTH = 255;

export type ApiTokenKind = 'service' | 'personal';
export type ApiTokenStatus = 'active' | 'expired' | 'revoked';

export interface ListTokensFilters {
  kind?: ApiTokenKind | null;
  status?: ApiTokenStatus | null;
  search?: string | null;
}

export interface RequestedExpiryPolicy {
  maxTtlHours?: number;
}

export interface RepositoryAccessPolicy {
  allowAll?: boolean;
}

export interface IssueTokenInput {
  name: string;
  scopes: ApiTokenScope[];
  repositoryAllowlist?: string[] | null;
  repositoryAllowlistRepoIds?: number[] | null;
  expiresAt?: string | null;
  createdBy: string;
}

export interface UserTokenOwner {
  userId: string;
  githubUsername: string | null;
  email: string | null;
  preferredUsername: string | null;
  displayName: string | null;
  roleAtIssue: string;
}

export interface IssueUserTokenInput {
  name: string;
  scopes: ApiTokenScope[];
  repositoryAllowlist: string[] | null;
  repositoryAllowlistRepoIds: number[] | null;
  expiresAt: string | null;
  owner: UserTokenOwner;
}

export type OwnerSelectorField = 'ownerUserId' | 'ownerEmail' | 'ownerPreferredUsername';

/** write ⊃ read within one resource; legacy env:admin covers env:* only; never cross-resource. */
export function scopeSatisfies(granted: ApiTokenScope[], required: ApiTokenScope): boolean {
  return granted.some((scope) => {
    if (!API_TOKEN_SCOPES.includes(scope)) return false;
    if (scope === required) return true;
    if (scope === 'env:admin') return required === 'env:read' || required === 'env:write';
    const [resource, action] = scope.split(':');
    return action === 'write' && required === `${resource}:read`;
  });
}

/** SECURITY: only a null/undefined allowlist is unrestricted; an explicit empty one fails closed. */
export function isRepositoryAllowed(allowlist: string[] | null | undefined, fullName: string): boolean {
  if (!allowlist) return true;
  const target = fullName.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === target);
}

/** Id-bound allowlist for newly issued keys; null preserves unrestricted and legacy name-bound Service keys, [] fails closed. */
export function isRepositoryAllowedById(
  repoIds: number[] | null | undefined,
  githubRepositoryId: number | null | undefined
): boolean {
  if (!repoIds) return true;
  if (githubRepositoryId == null) return false;
  return repoIds.map(Number).includes(Number(githubRepositoryId));
}

function principalKindForToken(kind: ApiTokenKind): string {
  return kind === 'personal' ? 'personal_key' : 'service_key';
}

export default class ApiTokenService {
  /** SECURITY: minting durable machine credentials must never ride the ENABLE_AUTH fail-open admin identity. */
  static assertManagementAllowed(): void {
    if (process.env.ENABLE_AUTH !== 'true') {
      throw new AppError({
        httpStatus: 403,
        code: 'auth_required',
        message:
          'API token management requires ENABLE_AUTH=true with a verified identity; it is disabled while authentication is off.',
      });
    }
  }

  static tokenKind(record: Pick<ApiToken, 'kind'>): ApiTokenKind {
    return record.kind;
  }

  static tokenStatus(record: Pick<ApiToken, 'revokedAt' | 'expiresAt'>): ApiTokenStatus {
    if (record.revokedAt) return 'revoked';
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return 'expired';
    return 'active';
  }

  /** Fail closed when a persisted Personal key exceeds its scope, expiry, or repository policy. */
  private static satisfiesPersonalTokenPolicy(record: ApiToken): boolean {
    if (!record.ownerUserId) return true;

    const hasAllRepositoryAccess = record.repositoryAllowlist == null && record.repositoryAllowlistRepoIds == null;
    const hasSelectedRepositoryAccess =
      Array.isArray(record.repositoryAllowlist) &&
      record.repositoryAllowlist.length > 0 &&
      Array.isArray(record.repositoryAllowlistRepoIds) &&
      record.repositoryAllowlistRepoIds.length > 0;

    if (
      !Array.isArray(record.scopes) ||
      record.scopes.length === 0 ||
      record.scopes.some((scope) => !USER_TOKEN_CEILING.includes(scope)) ||
      (!hasAllRepositoryAccess && !hasSelectedRepositoryAccess)
    ) {
      return false;
    }

    if (record.expiresAt == null) return true;
    if (record.createdAt == null) return false;

    const createdAtMs = new Date(record.createdAt).getTime();
    const expiresAtMs = new Date(record.expiresAt).getTime();
    return (
      Number.isFinite(createdAtMs) &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > createdAtMs &&
      expiresAtMs <= createdAtMs + PERSONAL_TOKEN_MAX_TTL_HOURS * HOUR_MS
    );
  }

  /** Strict id parsing shared by revoke routes: ASCII digits only, positive, within safe-integer range. */
  static parseTokenId(raw: string): number {
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
      throw new BadRequestError('Token id must be a positive integer.', 'invalid_token_id');
    }
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BadRequestError('Token id must be a positive integer.', 'invalid_token_id');
    }
    return id;
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static generateServiceToken(): string {
    return `lfc_svc_${randomBytes(20).toString('hex')}`;
  }

  static generatePersonalToken(): string {
    return `lfc_pat_${randomBytes(20).toString('hex')}`;
  }

  static validateScopes(scopes: unknown): ApiTokenScope[] {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new BadRequestError('scopes must be a non-empty array', 'invalid_scopes');
    }
    const allowed = new Set<string>(API_TOKEN_SCOPES);
    for (const scope of scopes) {
      if (typeof scope !== 'string' || !allowed.has(scope)) {
        throw new BadRequestError(`Unknown scope: ${String(scope)}`, 'invalid_scopes');
      }
    }
    return [...new Set(scopes)] as ApiTokenScope[];
  }

  /** New service tokens may not carry env:admin until an endpoint defines it; legacy grants are grandfathered. */
  static assertServiceTokenScopes(requested: unknown): ApiTokenScope[] {
    const validated = this.validateScopes(requested);
    if (validated.includes('env:admin')) {
      throw new AppError({
        httpStatus: 403,
        code: 'forbidden_scope',
        message: `env:admin is reserved; new service keys may request ${USER_TOKEN_CEILING.join(', ')}.`,
      });
    }
    return validated;
  }

  static async issueToken(input: IssueTokenInput): Promise<{ token: string; record: ApiToken }> {
    const scopes = this.validateScopes(input.scopes);
    const token = this.generateServiceToken();

    const record = await ApiToken.transaction(async (trx) => {
      const inserted = await ApiToken.query(trx).insertAndFetch({
        name: input.name,
        tokenHash: this.hashToken(token),
        tokenPrefix: token.slice(0, 12),
        kind: 'service',
        scopes,
        repositoryAllowlist: input.repositoryAllowlist ?? null,
        repositoryAllowlistRepoIds: input.repositoryAllowlistRepoIds ?? null,
        expiresAt: input.expiresAt ?? null,
        createdBy: input.createdBy,
      });
      await recordAuthAuditEventInTransaction(trx, {
        event: 'api_token.issued',
        principalKind: 'service_key',
        principalId: null,
        actorId: input.createdBy,
        tokenId: inserted.id,
        outcome: 'issued',
        meta: { scopes, kind: 'service' },
      });
      return inserted;
    });

    getLogger().info(
      { event: 'api_token.mint', tokenId: record.id, kind: 'service', createdBy: input.createdBy, scopes },
      'ApiToken: service token minted'
    );
    return { token, record };
  }

  static async verifyToken(token: string): Promise<ApiToken | null> {
    if (!API_TOKEN_PATTERN.test(token)) return null;

    const record = await ApiToken.query().findOne({ tokenHash: this.hashToken(token) });
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;
    if (!this.satisfiesPersonalTokenPolicy(record)) return null;

    return record;
  }

  /** Called only after every auth policy check passes, so denied attempts never look recently active. */
  static touchLastUsed(record: ApiToken): void {
    const lastUsed = record.lastUsedAt ? new Date(record.lastUsedAt).getTime() : 0;
    if (Date.now() - lastUsed < LAST_USED_WRITE_INTERVAL_MS) return;

    ApiToken.query()
      .findById(record.id)
      .patch({ lastUsedAt: new Date().toISOString() })
      .execute()
      .catch((error) => getLogger().warn({ error }, 'ApiToken: lastUsedAt update failed'));
  }

  private static listQuery(filters: ListTokensFilters) {
    const query = ApiToken.query().orderBy('createdAt', 'desc');
    if (filters.kind === 'service') query.whereNull('ownerUserId');
    if (filters.kind === 'personal') query.whereNotNull('ownerUserId');
    if (filters.status === 'revoked') query.whereNotNull('revokedAt');
    if (filters.status === 'expired') {
      query.whereNull('revokedAt').whereNotNull('expiresAt').where('expiresAt', '<=', new Date().toISOString());
    }
    if (filters.status === 'active') {
      query.whereNull('revokedAt').where((w) => {
        w.whereNull('expiresAt').orWhere('expiresAt', '>', new Date().toISOString());
      });
    }
    const term = (filters.search ?? '').trim().toLowerCase();
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
      query.where((w) => {
        w.whereRaw('LOWER("name") LIKE ?', [like])
          .orWhereRaw('LOWER("tokenPrefix") LIKE ?', [like])
          .orWhereRaw('LOWER(COALESCE("ownerEmail", \'\')) LIKE ?', [like])
          .orWhereRaw('LOWER(COALESCE("ownerPreferredUsername", \'\')) LIKE ?', [like]);
      });
    }
    return query;
  }

  static async listTokens(filters: ListTokensFilters = {}): Promise<ApiToken[]> {
    return this.listQuery(filters);
  }

  static async listTokensPaginated(
    filters: ListTokensFilters,
    pagination: PaginationParams
  ): Promise<{ data: ApiToken[]; metadata: PaginationMetadata }> {
    return paginate<ApiToken>(this.listQuery(filters), pagination);
  }

  static async revokeToken(id: number, revokedBy?: string | null, reason = 'manual'): Promise<ApiToken | null> {
    const result = await ApiToken.transaction(async (trx) => {
      // Serialize the terminal transition so concurrent revokers cannot overwrite attribution or double-audit it.
      const record = await ApiToken.query(trx).forUpdate().findById(id);
      if (!record || record.revokedAt) return { record: record ?? null, changed: false };
      const patch: Partial<ApiToken> = { revokedAt: new Date().toISOString(), revokeReason: reason };
      if (revokedBy != null) patch.revokedBy = revokedBy;
      const updated = await ApiToken.query(trx).patchAndFetchById(id, patch);
      await recordAuthAuditEventInTransaction(trx, {
        event: 'api_token.revoked',
        principalKind: principalKindForToken(record.kind),
        principalId: record.ownerUserId ?? null,
        actorId: revokedBy ?? null,
        tokenId: id,
        outcome: 'revoked',
        meta: { scopes: record.scopes, kind: record.kind, reason },
      });
      return { record: updated, changed: true };
    });
    if (result.changed) {
      getLogger().info(
        { event: 'api_token.revoke', tokenId: id, revokedBy: revokedBy ?? null, reason },
        'ApiToken: token revoked'
      );
    }
    return result.record;
  }

  /**
   * Eligibility follows resolveMachineAuth (caller must hold user/admin), but the Personal-key effective
   * ceiling is a fixed {env:read, env:write} — never a literal intersection with the admin->env:admin map.
   */
  static assertUserTokenScopes(requested: unknown, roles: readonly string[]): ApiTokenScope[] {
    if (!roles.includes('admin') && !roles.includes('user')) {
      throw new AppError({
        httpStatus: 403,
        code: 'forbidden_scope',
        message: 'Minting a token requires the user or admin role.',
      });
    }
    const validated = this.validateScopes(requested);
    const ceiling = new Set<ApiTokenScope>(USER_TOKEN_CEILING);
    for (const scope of validated) {
      if (!ceiling.has(scope)) {
        throw new AppError({
          httpStatus: 403,
          code: 'forbidden_scope',
          message: `Personal keys may not request ${scope}; allowed scopes are ${USER_TOKEN_CEILING.join(', ')}.`,
        });
      }
    }
    return validated;
  }

  static resolveRequestedExpiry(
    body: { expiresAt?: unknown; ttlHours?: unknown },
    policy: RequestedExpiryPolicy = {}
  ): string | null {
    const now = Date.now();
    const hasTtl = body.ttlHours != null;
    const hasAbsoluteExpiry = body.expiresAt != null;
    if (hasTtl && hasAbsoluteExpiry) {
      throw new BadRequestError('Provide either ttlHours or expiresAt, not both.', 'invalid_expiry');
    }
    if (!hasTtl && !hasAbsoluteExpiry) {
      return null;
    }

    if (hasTtl) {
      const ttl = body.ttlHours;
      if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0) {
        throw new BadRequestError('ttlHours must be a positive integer.', 'invalid_expiry');
      }
      if (policy.maxTtlHours != null && ttl > policy.maxTtlHours) {
        throw new BadRequestError(`Expiry may not exceed ${policy.maxTtlHours} hours.`, 'invalid_expiry');
      }
      const expiresAtMs = now + ttl * HOUR_MS;
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs > MAX_DATE_MS) {
        throw new BadRequestError('ttlHours is outside the supported date range.', 'invalid_expiry');
      }
      return new Date(expiresAtMs).toISOString();
    }

    if (typeof body.expiresAt !== 'string' || !ISO_DATETIME.safeParse(body.expiresAt).success) {
      throw new BadRequestError('expiresAt must be a valid ISO-8601 timestamp.', 'invalid_expiry');
    }
    const expiresAtMs = Date.parse(body.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      throw new BadRequestError('expiresAt must be a future ISO-8601 timestamp.', 'invalid_expiry');
    }
    if (policy.maxTtlHours != null) {
      const maxExpiresAtMs = now + policy.maxTtlHours * HOUR_MS;
      if (expiresAtMs > maxExpiresAtMs) {
        throw new BadRequestError(`Expiry may not exceed ${policy.maxTtlHours} hours.`, 'invalid_expiry');
      }
    }
    try {
      return new Date(expiresAtMs).toISOString();
    } catch {
      throw new BadRequestError('expiresAt is outside the supported date range.', 'invalid_expiry');
    }
  }

  /**
   * Parse the explicit repositoryAccess contract: { mode: 'all' } persists null allowlists,
   * { mode: 'selected' } resolves entries to stable GitHub repo ids. An empty selection can never mean all.
   */
  static async resolveRepositoryAccess(
    body: {
      repositoryAccess?: unknown;
      repositoryAllowlist?: unknown;
    },
    policy: RepositoryAccessPolicy = {}
  ): Promise<{ names: string[] | null; repoIds: number[] | null }> {
    if (body.repositoryAllowlist != null) {
      throw new BadRequestError(
        'repositoryAllowlist has been replaced by repositoryAccess: { mode: "all" } | { mode: "selected", repositories: [...] }.',
        'invalid_body'
      );
    }
    const access = body.repositoryAccess as { mode?: unknown; repositories?: unknown } | null | undefined;
    const mode = access && typeof access === 'object' ? access.mode : null;
    if (mode !== 'all' && mode !== 'selected') {
      throw new BadRequestError(
        'repositoryAccess is required: { mode: "all" } or { mode: "selected", repositories: [...] }.',
        'invalid_body'
      );
    }
    const allowedKeys = mode === 'all' ? ['mode'] : ['mode', 'repositories'];
    const unknownKeys = Object.keys(access!).filter((key) => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) {
      throw new BadRequestError(
        `repositoryAccess with mode "${mode}" accepts only ${allowedKeys.join(' and ')}; unknown field${
          unknownKeys.length > 1 ? 's' : ''
        }: ${unknownKeys.join(', ')}.`,
        'invalid_body'
      );
    }
    if (mode === 'all') {
      if (policy.allowAll === false) {
        throw new BadRequestError(
          'This API key must be scoped to at least one repository.',
          'invalid_repository_access'
        );
      }
      return { names: null, repoIds: null };
    }
    return this.resolveRepositoryAllowlist(access!.repositories);
  }

  /** Normalize + validate a repository allowlist and resolve it to stable GitHub repo ids (identity, not the mutable name). */
  static async resolveRepositoryAllowlist(entries: unknown): Promise<{ names: string[]; repoIds: number[] }> {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BadRequestError('repositoryAllowlist must be a non-empty array of repositories.', 'invalid_allowlist');
    }
    if (entries.length > TOKEN_ALLOWLIST_MAX_ENTRIES) {
      throw new BadRequestError(
        `repositoryAllowlist may contain at most ${TOKEN_ALLOWLIST_MAX_ENTRIES} entries.`,
        'invalid_allowlist'
      );
    }
    const normalized: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string') {
        throw new BadRequestError('repositoryAllowlist entries must be "org/repo" strings.', 'invalid_allowlist');
      }
      const value = entry.trim().toLowerCase();
      if (!value || value.length > TOKEN_ALLOWLIST_MAX_ENTRY_LENGTH || !value.includes('/')) {
        throw new BadRequestError(`Invalid repository "${entry}"; expected "org/repo".`, 'invalid_allowlist');
      }
      normalized.push(value);
    }
    const unique = [...new Set(normalized)];
    const repositories = await Repository.query()
      .select('githubRepositoryId', 'fullName')
      .whereRaw('lower("fullName") = ANY(?)', [unique])
      .whereNull('deletedAt');
    const idByName = new Map<string, number>();
    for (const repo of repositories) {
      if (repo.githubRepositoryId != null) idByName.set(repo.fullName.toLowerCase(), Number(repo.githubRepositoryId));
    }
    const missing = unique.filter((name) => !idByName.has(name));
    if (missing.length > 0) {
      const resolved = await Promise.all(missing.map((name) => this.resolveGithubRepositoryId(name)));
      missing.forEach((name, index) => idByName.set(name, resolved[index]));
    }
    const repoIds = unique.map((name) => idByName.get(name)!);
    return { names: unique, repoIds: [...new Set(repoIds)] };
  }

  /** Not-yet-onboarded entries resolve through GitHub so a scoped repos:write key can onboard them later. */
  private static async resolveGithubRepositoryId(fullName: string): Promise<number> {
    const installationId = Number.parseInt(String(GITHUB_APP_INSTALLATION_ID), 10);
    if (!Number.isFinite(installationId)) {
      throw new Error('A valid GitHub App installation ID is required');
    }
    let repoId: unknown;
    try {
      const { getRepositoryByFullName } = await import('server/lib/github');
      repoId = (await getRepositoryByFullName(fullName, installationId)).data?.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Repository not found')) {
        throw new AppError({
          httpStatus: 400,
          code: 'repo_not_found',
          message: `Repository ${fullName} was not found on GitHub or the GitHub App cannot access it.`,
        });
      }
      throw error;
    }
    const id = Number(repoId);
    if (!Number.isSafeInteger(id)) {
      throw new AppError({
        httpStatus: 400,
        code: 'repo_not_found',
        message: `Repository ${fullName} was not found on GitHub or the GitHub App cannot access it.`,
      });
    }
    return id;
  }

  static async assertPersonalKeyCapacity(ownerUserId: string, trx?: Transaction): Promise<void> {
    const limit = await this.maxActivePersonalKeys();
    const active = await ApiToken.query(trx)
      .where({ ownerUserId })
      .whereNull('revokedAt')
      .where((w) => {
        w.whereNull('expiresAt').orWhere('expiresAt', '>', new Date().toISOString());
      })
      .resultSize();
    if (active >= limit) {
      throw new AppError({
        httpStatus: 403,
        code: 'personal_token_limit',
        message: `You already have ${active} active API keys (limit ${limit}); revoke one before creating another.`,
      });
    }
  }

  private static async maxActivePersonalKeys(): Promise<number> {
    const configs = await GlobalConfigService.getInstance().getAllConfigs();
    const configured = (configs as Record<string, any>)?.api_keys?.maxActivePersonalKeysPerUser;
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_ACTIVE_PERSONAL_KEYS;
  }

  static async issueUserToken(input: IssueUserTokenInput): Promise<{ token: string; record: ApiToken }> {
    const scopes = this.validateScopes(input.scopes);
    const token = this.generatePersonalToken();
    const record = await ApiToken.transaction(async (trx) => {
      // The cap is count-based with no DB constraint; a per-owner advisory xact lock serializes check+insert.
      await trx.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `api_token:personal_cap:${input.owner.userId}`,
      ]);
      await this.assertPersonalKeyCapacity(input.owner.userId, trx);
      const inserted = await ApiToken.query(trx).insertAndFetch({
        name: input.name,
        tokenHash: this.hashToken(token),
        tokenPrefix: token.slice(0, 12),
        kind: 'personal',
        scopes,
        repositoryAllowlist: input.repositoryAllowlist,
        repositoryAllowlistRepoIds: input.repositoryAllowlistRepoIds,
        expiresAt: input.expiresAt,
        createdBy: input.owner.userId,
        ownerUserId: input.owner.userId,
        ownerGithubUsername: input.owner.githubUsername,
        ownerEmail: input.owner.email ? input.owner.email.trim().toLowerCase() : null,
        ownerPreferredUsername: input.owner.preferredUsername
          ? input.owner.preferredUsername.trim().toLowerCase()
          : null,
        ownerDisplayName: input.owner.displayName?.trim() || null,
        ownerRoleAtIssue: input.owner.roleAtIssue,
      });
      await recordAuthAuditEventInTransaction(trx, {
        event: 'api_token.issued',
        principalKind: 'personal_key',
        principalId: input.owner.userId,
        actorId: input.owner.userId,
        tokenId: inserted.id,
        outcome: 'issued',
        meta: { scopes, kind: 'personal' },
      });
      return inserted;
    });
    getLogger().info(
      { event: 'api_token.mint', tokenId: record.id, ownerUserId: record.ownerUserId, scopes },
      'ApiToken: user token minted'
    );
    return { token, record };
  }

  static async listTokensByOwner(ownerUserId: string): Promise<ApiToken[]> {
    return ApiToken.query().where({ ownerUserId }).orderBy('createdAt', 'desc');
  }

  /** Owner-scoped revoke: a non-owner (or missing) token returns null so the route 404s with no existence leak. */
  static async revokeOwnedToken(id: number, ownerUserId: string): Promise<ApiToken | null> {
    const result = await ApiToken.transaction(async (trx) => {
      // Re-check ownership and terminal state under the same row lock used for the mutation.
      const record = await ApiToken.query(trx).forUpdate().findById(id);
      if (!record || record.ownerUserId !== ownerUserId) return { record: null, changed: false };
      if (record.revokedAt) return { record, changed: false };
      const updated = await ApiToken.query(trx).patchAndFetchById(id, {
        revokedAt: new Date().toISOString(),
        revokedBy: ownerUserId,
        revokeReason: 'manual',
      });
      await recordAuthAuditEventInTransaction(trx, {
        event: 'api_token.revoked',
        principalKind: principalKindForToken(record.kind),
        principalId: record.ownerUserId ?? null,
        actorId: ownerUserId,
        tokenId: id,
        outcome: 'revoked',
        meta: { scopes: record.scopes, kind: record.kind, reason: 'manual' },
      });
      return { record: updated, changed: true };
    });
    if (result.changed) {
      getLogger().info(
        { event: 'api_token.revoke', tokenId: id, ownerUserId, revokedBy: ownerUserId },
        'ApiToken: user token self-revoked'
      );
    }
    return result.record;
  }

  /** Offboarding hook: resolve by exactly one identifier; refuse if it maps to more than one owner. */
  static async revokeByOwnerIdentifier(
    field: OwnerSelectorField,
    value: string,
    revokedBy: string,
    reason = 'manual'
  ): Promise<{ count: number }> {
    const normalized = field === 'ownerUserId' ? value : value.trim().toLowerCase();
    const matches = await ApiToken.query().where(field, normalized).whereNotNull('ownerUserId');
    const owners = new Set(matches.map((token) => token.ownerUserId));
    if (owners.size > 1) {
      throw new AppError({
        httpStatus: 409,
        code: 'ambiguous_owner',
        message: `${field}=${value} resolves to ${owners.size} distinct owners; revoke by ownerUserId instead.`,
      });
    }
    return this.markRevoked(
      matches.filter((token) => !token.revokedAt).map((token) => token.id),
      revokedBy,
      { event: 'api_token.revoke_by_owner', field, ownerUserId: [...owners][0] ?? null },
      reason
    );
  }

  static async revokeAllUserTokens(revokedBy: string): Promise<{ count: number }> {
    const active = await ApiToken.query().whereNotNull('ownerUserId').whereNull('revokedAt');
    return this.markRevoked(
      active.map((token) => token.id),
      revokedBy,
      { event: 'api_token.revoke_all_user' }
    );
  }

  private static async markRevoked(
    ids: number[],
    revokedBy: string,
    context: Record<string, unknown>,
    reason = 'manual'
  ): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const targetIds = [...new Set(ids)].sort((left, right) => left - right);
    const count = await ApiToken.transaction(async (trx) => {
      // Deterministic row-lock order prevents overlapping bulk operations from deadlocking. The
      // revokedAt predicate is re-evaluated after a concurrent winner commits, so only live rows proceed.
      const selected = await ApiToken.query(trx)
        .select('id', 'kind', 'scopes', 'ownerUserId', 'revokedAt')
        .whereIn('id', targetIds)
        .whereNull('revokedAt')
        .orderBy('id', 'asc')
        .forUpdate();
      const targetSet = new Set(targetIds);
      const records = (selected ?? []).filter((record) => targetSet.has(record.id) && !record.revokedAt);
      if (records.length === 0) return 0;
      const winningIds = records.map((record) => record.id);
      await ApiToken.query(trx)
        .whereIn('id', winningIds)
        .whereNull('revokedAt')
        .patch({ revokedAt: new Date().toISOString(), revokedBy, revokeReason: reason });
      for (const record of records) {
        await recordAuthAuditEventInTransaction(trx, {
          event: 'api_token.revoked',
          principalKind: principalKindForToken(record.kind),
          principalId: record.ownerUserId ?? null,
          actorId: revokedBy,
          tokenId: record.id,
          outcome: 'revoked',
          meta: { scopes: record.scopes, kind: record.kind, reason },
        });
      }
      return records.length;
    });
    if (count > 0) {
      getLogger().info({ ...context, count, revokedBy, reason }, 'ApiToken: bulk revoke');
    }
    return { count };
  }
}
