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

import 'server/lib/dependencies';
import UserMcpConnection from 'server/models/UserMcpConnection';
import { decrypt, encrypt } from 'server/lib/encryption';
import { normalizeUserConnectionValues } from 'server/services/ai/mcp/connectionConfig';
import type {
  McpDiscoveredTool,
  McpStoredUserConnectionState,
  UserMcpConnectionMaskedUser,
  UserMcpConnectionState,
} from 'server/services/ai/mcp/types';

type DecryptedUserMcpConnection = {
  state: McpStoredUserConnectionState | null;
  definitionFingerprint: string;
  stale: boolean;
  discoveredTools: McpDiscoveredTool[];
  validationError: string | null;
  validatedAt: string | null;
  updatedAt: string | null;
};

const STALE_CONNECTION_MESSAGE = 'Connection needs to be refreshed because the shared MCP changed.';

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStoredState(input: unknown): McpStoredUserConnectionState | null {
  if (!isRecordObject(input) || typeof input.type !== 'string') {
    return null;
  }

  if (input.type === 'fields') {
    return {
      type: 'fields',
      values: normalizeUserConnectionValues(input.values),
    };
  }

  if (input.type === 'oauth') {
    return {
      type: 'oauth',
      tokens: isRecordObject(input.tokens) ? (input.tokens as any) : undefined,
      clientInformation: isRecordObject(input.clientInformation) ? (input.clientInformation as any) : undefined,
      codeVerifier: typeof input.codeVerifier === 'string' ? input.codeVerifier : undefined,
      oauthState: typeof input.oauthState === 'string' ? input.oauthState : undefined,
    };
  }

  return null;
}

function parseEncryptedState(ciphertext: string): McpStoredUserConnectionState | null {
  const parsed = JSON.parse(decrypt(ciphertext)) as unknown;
  return normalizeStoredState(parsed);
}

function buildScopedKey(scope: string, slug: string): string {
  return `${scope}:${slug}`;
}

function getCurrentFingerprint(
  scope: string,
  slug: string,
  currentDefinitionFingerprints?: Map<string, string>
): string | undefined {
  return currentDefinitionFingerprints?.get(buildScopedKey(scope, slug));
}

function isStaleConnection(
  record: Pick<UserMcpConnection, 'scope' | 'slug' | 'definitionFingerprint'>,
  currentDefinitionFingerprints?: Map<string, string>
): boolean {
  const currentFingerprint = getCurrentFingerprint(record.scope, record.slug, currentDefinitionFingerprints);
  if (!currentFingerprint) {
    return false;
  }

  return record.definitionFingerprint !== currentFingerprint;
}

function configuredFieldKeys(state: McpStoredUserConnectionState | null): string[] {
  if (!state || state.type !== 'fields') {
    return [];
  }

  return Object.keys(state.values || {});
}

function normalizeDateTime(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return typeof value === 'string' ? value : null;
}

function isConfiguredState(state: McpStoredUserConnectionState | null): boolean {
  if (!state) {
    return false;
  }

  if (state.type === 'fields') {
    return Object.keys(state.values || {}).length > 0;
  }

  return Boolean(state.tokens?.access_token || state.tokens?.refresh_token);
}

function authModeFromState(state: McpStoredUserConnectionState | null): 'fields' | 'oauth' | 'none' {
  if (!state) {
    return 'none';
  }

  return state.type === 'oauth' ? 'oauth' : 'fields';
}

function toMaskedState(
  record: UserMcpConnection,
  currentDefinitionFingerprints?: Map<string, string>
): UserMcpConnectionState {
  const state = parseEncryptedState(record.encryptedState);
  const stale = isStaleConnection(record, currentDefinitionFingerprints);

  return {
    slug: record.slug,
    scope: record.scope,
    authMode: authModeFromState(state),
    configured: !stale && isConfiguredState(state),
    stale,
    configuredFieldKeys: stale ? [] : configuredFieldKeys(state),
    validatedAt: normalizeDateTime(record.validatedAt),
    validationError: stale ? record.validationError || STALE_CONNECTION_MESSAGE : record.validationError,
    discoveredTools: stale ? [] : record.discoveredTools || [],
    updatedAt: normalizeDateTime(record.updatedAt),
  };
}

function toDecryptedConnection(
  record: UserMcpConnection,
  currentDefinitionFingerprints?: Map<string, string>
): DecryptedUserMcpConnection {
  const state = parseEncryptedState(record.encryptedState);
  const stale = isStaleConnection(record, currentDefinitionFingerprints);

  return {
    state: stale ? null : state,
    definitionFingerprint: record.definitionFingerprint,
    stale,
    discoveredTools: stale ? [] : record.discoveredTools || [],
    validationError: stale ? record.validationError || STALE_CONNECTION_MESSAGE : record.validationError,
    validatedAt: normalizeDateTime(record.validatedAt),
    updatedAt: normalizeDateTime(record.updatedAt),
  };
}

export default class UserMcpConnectionService {
  private static buildKey(scope: string, slug: string): string {
    return buildScopedKey(scope, slug);
  }

  private static getOwnerKey(userId: string, ownerGithubUsername?: string | null): string {
    const normalizedOwner = ownerGithubUsername?.trim();
    return normalizedOwner || userId;
  }

  private static async reconcileRecordOwnership(
    record: UserMcpConnection,
    userId: string,
    ownerGithubUsername: string
  ): Promise<UserMcpConnection> {
    if (record.userId === userId && record.ownerGithubUsername === ownerGithubUsername) {
      return record;
    }

    await UserMcpConnection.query().where({ id: record.id }).patch({ userId, ownerGithubUsername });
    record.userId = userId;
    record.ownerGithubUsername = ownerGithubUsername;
    return record;
  }

  private static async findRecord(
    userId: string,
    scope: string,
    slug: string,
    ownerGithubUsername?: string | null
  ): Promise<UserMcpConnection | null> {
    const canonicalOwner = this.getOwnerKey(userId, ownerGithubUsername);

    const ownerMatch = await UserMcpConnection.query()
      .where({ ownerGithubUsername: canonicalOwner, scope, slug })
      .first();
    if (ownerMatch) {
      return this.reconcileRecordOwnership(ownerMatch, userId, canonicalOwner);
    }

    if (canonicalOwner === userId) {
      return null;
    }

    const fallbackMatch = await UserMcpConnection.query().where({ userId, scope, slug }).first();
    if (!fallbackMatch) {
      return null;
    }

    return this.reconcileRecordOwnership(fallbackMatch, userId, canonicalOwner);
  }

  static async upsertConnection({
    userId,
    ownerGithubUsername,
    scope,
    slug,
    state,
    definitionFingerprint,
    discoveredTools,
    validationError = null,
    validatedAt,
  }: {
    userId: string;
    ownerGithubUsername?: string | null;
    scope: string;
    slug: string;
    state: McpStoredUserConnectionState;
    definitionFingerprint: string;
    discoveredTools: McpDiscoveredTool[];
    validationError?: string | null;
    validatedAt: string | null;
  }): Promise<void> {
    const encryptedState = encrypt(JSON.stringify(state));
    const canonicalOwner = this.getOwnerKey(userId, ownerGithubUsername);
    const existing = await this.findRecord(userId, scope, slug, ownerGithubUsername);

    const patch = {
      userId,
      ownerGithubUsername: canonicalOwner,
      encryptedState,
      definitionFingerprint,
      discoveredTools,
      validationError,
      validatedAt,
    };

    if (existing) {
      await UserMcpConnection.query().where({ id: existing.id }).patch(patch);
      return;
    }

    await UserMcpConnection.query().insertAndFetch({
      scope,
      slug,
      ...patch,
    });
  }

  static async getMaskedState(
    userId: string,
    scope: string,
    slug: string,
    ownerGithubUsername?: string | null,
    currentDefinitionFingerprint?: string,
    defaultAuthMode: 'fields' | 'oauth' | 'none' = 'none'
  ): Promise<UserMcpConnectionState> {
    const record = await this.findRecord(userId, scope, slug, ownerGithubUsername);
    if (!record) {
      return {
        slug,
        scope,
        authMode: defaultAuthMode,
        configured: false,
        stale: false,
        configuredFieldKeys: [],
        validatedAt: null,
        validationError: null,
        discoveredTools: [],
        updatedAt: null,
      };
    }

    const fingerprints = currentDefinitionFingerprint
      ? new Map([[this.buildKey(scope, slug), currentDefinitionFingerprint]])
      : undefined;

    return toMaskedState(record, fingerprints);
  }

  static async getDecryptedConnection(
    userId: string,
    scope: string,
    slug: string,
    ownerGithubUsername?: string | null,
    currentDefinitionFingerprint?: string
  ): Promise<DecryptedUserMcpConnection | null> {
    const record = await this.findRecord(userId, scope, slug, ownerGithubUsername);
    if (!record) {
      return null;
    }

    const fingerprints = currentDefinitionFingerprint
      ? new Map([[this.buildKey(scope, slug), currentDefinitionFingerprint]])
      : undefined;

    return toDecryptedConnection(record, fingerprints);
  }

  static async listMaskedStatesByScopes(
    userId: string,
    scopes: string[],
    ownerGithubUsername?: string | null,
    currentDefinitionFingerprints?: Map<string, string>
  ): Promise<Map<string, UserMcpConnectionState>> {
    const uniqueScopes = Array.from(new Set(scopes.filter(Boolean)));
    const canonicalOwner = this.getOwnerKey(userId, ownerGithubUsername);

    const collect = async (ownerKey: 'ownerGithubUsername' | 'userId', value: string) =>
      UserMcpConnection.query().where(ownerKey, value).whereIn('scope', uniqueScopes);

    let records = await collect('ownerGithubUsername', canonicalOwner);
    if (records.length === 0 && canonicalOwner !== userId) {
      records = await collect('userId', userId);
      await Promise.all(records.map((record) => this.reconcileRecordOwnership(record, userId, canonicalOwner)));
    }

    return new Map(
      records.map((record) => [
        this.buildKey(record.scope, record.slug),
        toMaskedState(record, currentDefinitionFingerprints),
      ])
    );
  }

  static async listDecryptedConnectionsByScopes(
    userId: string,
    scopes: string[],
    ownerGithubUsername?: string | null,
    currentDefinitionFingerprints?: Map<string, string>
  ): Promise<Map<string, DecryptedUserMcpConnection>> {
    const uniqueScopes = Array.from(new Set(scopes.filter(Boolean)));
    const canonicalOwner = this.getOwnerKey(userId, ownerGithubUsername);
    let records = await UserMcpConnection.query()
      .where('ownerGithubUsername', canonicalOwner)
      .whereIn('scope', uniqueScopes);

    if (records.length === 0 && canonicalOwner !== userId) {
      records = await UserMcpConnection.query().where('userId', userId).whereIn('scope', uniqueScopes);
      await Promise.all(records.map((record) => this.reconcileRecordOwnership(record, userId, canonicalOwner)));
    }

    return new Map(
      records.map((record) => [
        this.buildKey(record.scope, record.slug),
        toDecryptedConnection(record, currentDefinitionFingerprints),
      ])
    );
  }

  static async deleteConnection(
    userId: string,
    scope: string,
    slug: string,
    ownerGithubUsername?: string | null
  ): Promise<boolean> {
    const record = await this.findRecord(userId, scope, slug, ownerGithubUsername);
    if (!record) {
      return false;
    }

    const count = await UserMcpConnection.query().where({ id: record.id }).delete();
    return count > 0;
  }

  static async listMaskedUsersForServer(
    scope: string,
    slug: string,
    currentDefinitionFingerprint?: string
  ): Promise<UserMcpConnectionMaskedUser[]> {
    const records = await UserMcpConnection.query().where({ scope, slug }).orderBy('updatedAt', 'desc');
    const fingerprints = currentDefinitionFingerprint
      ? new Map([[this.buildKey(scope, slug), currentDefinitionFingerprint]])
      : undefined;

    return records.map((record) => {
      const state = parseEncryptedState(record.encryptedState);
      const stale = isStaleConnection(record, fingerprints);

      return {
        userId: record.userId,
        ownerGithubUsername: record.ownerGithubUsername || null,
        authMode: authModeFromState(state),
        stale,
        configuredFieldKeys: stale ? [] : configuredFieldKeys(state),
        discoveredToolCount: stale ? 0 : (record.discoveredTools || []).length,
        validationError: stale ? record.validationError || STALE_CONNECTION_MESSAGE : record.validationError,
        validatedAt: normalizeDateTime(record.validatedAt),
        updatedAt: normalizeDateTime(record.updatedAt),
      };
    });
  }
}
