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

import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import McpServerConfig from 'server/models/McpServerConfig';
import { APP_HOST } from 'shared/config';
import UserMcpConnectionService from 'server/services/userMcpConnection';
import {
  applyCompiledConnectionConfigToTransport,
  buildMcpDefinitionFingerprint,
  compileFieldConnectionConfig,
  mergeCompiledConnectionConfig,
  normalizeAuthConfig,
  normalizeSharedConnectionConfig,
  normalizeTransportConfig,
  requiresUserConnection,
} from './connectionConfig';
import { McpClientManager } from './client';
import { PersistentOAuthClientProvider } from './oauthProvider';
import { getMcpPreset } from './presets';
import { usesSessionWorkspaceGatewayExecution } from './sessionPod';
import type {
  AgentMcpConnection,
  CreateMcpServerConfigInput,
  McpCompiledConnectionConfig,
  McpAuthConfig,
  McpDiscoveredTool,
  McpResolvedTransportConfig,
  McpServerConfigRecord,
  McpSharedConnectionConfig,
  McpTransportConfig,
  ResolvedMcpServer,
  UpdateMcpServerConfigInput,
} from './types';

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const MAX_SLUG_LENGTH = 100;
const VALIDATION_TIMEOUT_MS = 5000;
const REDACTED_SHARED_SECRET = '******';
const MIN_SECRET_REDACTION_LENGTH = 4;
const NON_SECRET_REDACTION_VALUES = new Set([
  'bearer',
  'basic',
  'false',
  'http',
  'https',
  'none',
  'null',
  'oauth',
  'true',
]);
const SHARED_SECRET_SECTIONS: (keyof McpSharedConnectionConfig)[] = ['headers', 'query', 'env', 'defaultArgs'];

export type McpErrorRedactionSource = {
  values?: Record<string, unknown> | null;
  compiledConfig?: Partial<McpCompiledConnectionConfig> | null;
  transport?: McpResolvedTransportConfig | McpTransportConfig | null;
  extraSecrets?: unknown[];
};

function buildConnectionKey(scope: string, slug: string): string {
  return `${scope}:${slug}`;
}

function resolveAuthConfig(inputAuthConfig: unknown, presetKey?: string | null): McpAuthConfig {
  if (inputAuthConfig) {
    return normalizeAuthConfig(inputAuthConfig);
  }

  return normalizeAuthConfig(getMcpPreset(presetKey)?.authConfig);
}

function buildDefinitionFingerprintMap(
  configs: Pick<McpServerConfig, 'scope' | 'slug' | 'preset' | 'transport' | 'sharedConfig' | 'authConfig'>[]
): Map<string, string> {
  return new Map(
    configs.map((config) => [
      buildConnectionKey(config.scope, config.slug),
      buildMcpDefinitionFingerprint({
        preset: config.preset,
        transport: config.transport,
        sharedConfig: config.sharedConfig,
        authConfig: resolveAuthConfig(config.authConfig, config.preset),
      }),
    ])
  );
}

function buildOAuthCallbackUrl(slug: string, scope: string): string {
  const url = new URL(`${APP_HOST}/api/v2/ai/agent/mcp-connections/${encodeURIComponent(slug)}/oauth/callback`);
  url.searchParams.set('scope', scope);
  return url.toString();
}

function addSecretValue(secrets: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }

  const secret = value.trim();
  if (
    secret.length < MIN_SECRET_REDACTION_LENGTH ||
    secret === REDACTED_SHARED_SECRET ||
    NON_SECRET_REDACTION_VALUES.has(secret.toLowerCase())
  ) {
    return;
  }

  secrets.add(secret);
  secrets.add(encodeURIComponent(secret));
  const encoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
  secrets.add(encoded);
}

function collectUnknownSecretValues(value: unknown, secrets: Set<string>): void {
  if (typeof value === 'string') {
    addSecretValue(secrets, value);
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUnknownSecretValues(item, secrets);
    }
    return;
  }

  for (const item of Object.values(value)) {
    collectUnknownSecretValues(item, secrets);
  }
}

function collectRecordSecretValues(values: Record<string, unknown> | undefined | null, secrets: Set<string>): void {
  if (!values) {
    return;
  }

  for (const value of Object.values(values)) {
    addSecretValue(secrets, value);
  }
}

function collectCompiledConfigSecretValues(
  config: Partial<McpCompiledConnectionConfig> | undefined | null,
  secrets: Set<string>
): void {
  if (!config) {
    return;
  }

  collectRecordSecretValues(config.headers, secrets);
  collectRecordSecretValues(config.query, secrets);
  collectRecordSecretValues(config.env, secrets);
  collectRecordSecretValues(config.defaultArgs, secrets);
}

function collectTransportSecretValues(
  transport: McpResolvedTransportConfig | McpTransportConfig | undefined | null,
  secrets: Set<string>
): void {
  if (!transport) {
    return;
  }

  if (transport.type === 'http' || transport.type === 'sse') {
    collectRecordSecretValues(transport.headers, secrets);
    collectRawQuerySecretValues(transport.url, secrets);
    try {
      const parsed = new URL(transport.url);
      parsed.searchParams.forEach((value) => {
        addSecretValue(secrets, value);
      });
    } catch {
      // Ignore non-URL transport strings; normalized transports should already be valid URLs.
    }
    return;
  }

  if (transport.type === 'stdio') {
    collectRecordSecretValues(transport.env, secrets);
  }
}

function collectRawQuerySecretValues(url: string, secrets: Set<string>): void {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return;
  }

  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  for (const part of query.split('&')) {
    if (!part) {
      continue;
    }

    const valueStart = part.indexOf('=');
    const rawValue = valueStart === -1 ? '' : part.slice(valueStart + 1);
    if (!rawValue) {
      continue;
    }

    addSecretValue(secrets, rawValue);
    try {
      addSecretValue(secrets, decodeURIComponent(rawValue));
    } catch {
      // Ignore malformed percent-encoding; the raw value is still redacted.
    }
  }
}

function collectMcpSecretValues(sources: McpErrorRedactionSource[]): Set<string> {
  const secrets = new Set<string>();

  for (const source of sources) {
    collectUnknownSecretValues(source.values, secrets);
    collectCompiledConfigSecretValues(source.compiledConfig, secrets);
    collectTransportSecretValues(source.transport, secrets);
    for (const secret of source.extraSecrets || []) {
      collectUnknownSecretValues(secret, secrets);
    }
  }

  return secrets;
}

function redactSecretValues(value: string, secrets: Set<string>): string {
  return Array.from(secrets)
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.split(secret).join(REDACTED_SHARED_SECRET), value);
}

function sanitizeUnknownValue(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === 'string') {
    return redactSecretValues(value, secrets);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknownValue(item, secrets));
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeUnknownValue(item, secrets)]));
}

export function sanitizeMcpErrorMessage(error: unknown, sources: McpErrorRedactionSource[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecretValues(message, collectMcpSecretValues(sources));
}

export function sanitizeMcpResult<T>(result: T, sources: McpErrorRedactionSource[] = []): T {
  return sanitizeUnknownValue(result, collectMcpSecretValues(sources)) as T;
}

export function redactSharedConfigSecrets<T extends { sharedConfig?: McpSharedConnectionConfig | null }>(config: T): T {
  const sharedConfig = config.sharedConfig ? { ...config.sharedConfig } : undefined;
  let changed = false;

  if (sharedConfig) {
    for (const section of SHARED_SECRET_SECTIONS) {
      const values = sharedConfig[section];
      if (!values || typeof values !== 'object') {
        continue;
      }

      sharedConfig[section] = Object.fromEntries(
        Object.keys(values).map((key) => [key, REDACTED_SHARED_SECRET])
      ) as Record<string, string>;
      changed = true;
    }
  }

  if (!changed) {
    return config;
  }

  return {
    ...config,
    ...(sharedConfig ? { sharedConfig } : {}),
  };
}

function redactSecretRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
  return values ? Object.fromEntries(Object.keys(values).map((key) => [key, REDACTED_SHARED_SECRET])) : values;
}

function redactTransportUrlQuery(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }

  const hashStart = url.indexOf('#', queryStart);
  const base = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const hash = hashStart === -1 ? '' : url.slice(hashStart);
  if (!query) {
    return url;
  }

  const redactedQuery = query
    .split('&')
    .map((part) => {
      if (!part) {
        return part;
      }

      const valueStart = part.indexOf('=');
      const key = valueStart === -1 ? part : part.slice(0, valueStart);
      return `${key}=${REDACTED_SHARED_SECRET}`;
    })
    .join('&');

  return `${base}?${redactedQuery}${hash}`;
}

export function redactMcpConfigSecrets<
  T extends { sharedConfig?: McpSharedConnectionConfig | null; transport?: McpTransportConfig | null }
>(config: T): T {
  const redacted = redactSharedConfigSecrets(config);
  if (!redacted.transport) {
    return redacted;
  }

  if (redacted.transport.type === 'http' || redacted.transport.type === 'sse') {
    const url = redactTransportUrlQuery(redacted.transport.url);
    if (!redacted.transport.headers && url === redacted.transport.url) {
      return redacted;
    }

    return {
      ...redacted,
      transport: {
        ...redacted.transport,
        url,
        ...(redacted.transport.headers ? { headers: redactSecretRecord(redacted.transport.headers) } : {}),
      },
    };
  }

  if (!redacted.transport.env) {
    return redacted;
  }

  return {
    ...redacted,
    transport: {
      ...redacted.transport,
      env: redactSecretRecord(redacted.transport.env),
    },
  };
}

function restoreRedactedSharedConfig(
  nextSharedConfig: McpServerConfigRecord['sharedConfig'],
  existingSharedConfig: McpServerConfigRecord['sharedConfig']
): McpServerConfigRecord['sharedConfig'] {
  if (!nextSharedConfig || !existingSharedConfig) {
    return nextSharedConfig;
  }

  let changed = false;
  const sharedConfig = { ...nextSharedConfig };

  for (const section of SHARED_SECRET_SECTIONS) {
    const nextValues = sharedConfig[section];
    const existingValues = existingSharedConfig[section];
    if (!nextValues || !existingValues) {
      continue;
    }

    const restoredValues = { ...nextValues };
    for (const [key, value] of Object.entries(restoredValues)) {
      if (value === REDACTED_SHARED_SECRET && existingValues[key]) {
        restoredValues[key] = existingValues[key];
        changed = true;
      }
    }

    sharedConfig[section] = restoredValues;
  }

  return changed ? sharedConfig : nextSharedConfig;
}

function restoreRedactedSecretRecord(
  nextValues: Record<string, string> | undefined,
  existingValues: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!nextValues || !existingValues) {
    return nextValues;
  }

  let changed = false;
  const restoredValues = { ...nextValues };
  for (const [key, value] of Object.entries(restoredValues)) {
    if (value === REDACTED_SHARED_SECRET && existingValues[key]) {
      restoredValues[key] = existingValues[key];
      changed = true;
    }
  }

  return changed ? restoredValues : nextValues;
}

function parseUrlQueryParts(url: string): { base: string; query: string; hash: string } | null {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return null;
  }

  const hashStart = url.indexOf('#', queryStart);
  return {
    base: url.slice(0, queryStart),
    query: url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart),
    hash: hashStart === -1 ? '' : url.slice(hashStart),
  };
}

function restoreRedactedTransportUrlQuery(nextUrl: string, existingUrl: string): string {
  const nextParts = parseUrlQueryParts(nextUrl);
  const existingParts = parseUrlQueryParts(existingUrl);
  if (!nextParts || !existingParts || !nextParts.query || !existingParts.query) {
    return nextUrl;
  }

  const existingValuesByKey = new Map<string, string[]>();
  for (const part of existingParts.query.split('&')) {
    const valueStart = part.indexOf('=');
    if (valueStart === -1) {
      continue;
    }

    const key = part.slice(0, valueStart);
    const value = part.slice(valueStart + 1);
    existingValuesByKey.set(key, [...(existingValuesByKey.get(key) || []), value]);
  }

  let changed = false;
  const restoredQuery = nextParts.query
    .split('&')
    .map((part) => {
      const valueStart = part.indexOf('=');
      if (valueStart === -1) {
        return part;
      }

      const key = part.slice(0, valueStart);
      const value = part.slice(valueStart + 1);
      if (value !== REDACTED_SHARED_SECRET) {
        return part;
      }

      const existingValues = existingValuesByKey.get(key);
      const existingValue = existingValues?.shift();
      if (!existingValue) {
        return part;
      }

      changed = true;
      return `${key}=${existingValue}`;
    })
    .join('&');

  return changed ? `${nextParts.base}?${restoredQuery}${nextParts.hash}` : nextUrl;
}

function transportTargetChanged(nextTransport: McpTransportConfig, existingTransport: McpTransportConfig): boolean {
  if (nextTransport.type !== existingTransport.type) {
    return true;
  }

  if (nextTransport.type === 'http' || nextTransport.type === 'sse') {
    if (existingTransport.type !== 'http' && existingTransport.type !== 'sse') {
      return true;
    }

    try {
      const nextUrl = new URL(nextTransport.url);
      const existingUrl = new URL(existingTransport.url);
      return (
        nextUrl.protocol !== existingUrl.protocol ||
        nextUrl.host !== existingUrl.host ||
        nextUrl.pathname !== existingUrl.pathname
      );
    } catch {
      return nextTransport.url.split('?')[0] !== existingTransport.url.split('?')[0];
    }
  }

  if (existingTransport.type !== 'stdio') {
    return true;
  }

  return (
    nextTransport.command !== existingTransport.command ||
    JSON.stringify(nextTransport.args || []) !== JSON.stringify(existingTransport.args || [])
  );
}

function recordContainsRedactedSecret(values: Record<string, string> | undefined): boolean {
  return !!values && Object.values(values).some((value) => value === REDACTED_SHARED_SECRET);
}

function transportContainsRedactedSecret(transport: McpTransportConfig): boolean {
  if (transport.type === 'http' || transport.type === 'sse') {
    let redactedQueryValue = false;
    new URLSearchParams(parseUrlQueryParts(transport.url)?.query || '').forEach((value) => {
      if (value === REDACTED_SHARED_SECRET) {
        redactedQueryValue = true;
      }
    });
    return recordContainsRedactedSecret(transport.headers) || redactedQueryValue;
  }

  return recordContainsRedactedSecret(transport.env);
}

function sharedConfigContainsRedactedSecret(sharedConfig: McpSharedConnectionConfig): boolean {
  return SHARED_SECRET_SECTIONS.some((section) => recordContainsRedactedSecret(sharedConfig[section]));
}

function sharedConfigContainsSecretValue(sharedConfig: McpSharedConnectionConfig): boolean {
  return SHARED_SECRET_SECTIONS.some((section) => {
    const values = sharedConfig[section];
    return !!values && Object.values(values).length > 0;
  });
}

function restoreRedactedTransport(
  nextTransport: McpTransportConfig,
  existingTransport: McpTransportConfig
): McpTransportConfig {
  if (nextTransport.type !== existingTransport.type) {
    if (transportContainsRedactedSecret(nextTransport)) {
      throw new Error('Re-enter MCP transport secrets when changing the MCP transport target');
    }

    return nextTransport;
  }

  if (nextTransport.type === 'http' || nextTransport.type === 'sse') {
    if (existingTransport.type !== 'http' && existingTransport.type !== 'sse') {
      return nextTransport;
    }

    if (transportTargetChanged(nextTransport, existingTransport) && transportContainsRedactedSecret(nextTransport)) {
      throw new Error('Re-enter MCP transport secrets when changing the MCP transport target');
    }

    const headers = restoreRedactedSecretRecord(nextTransport.headers, existingTransport.headers);
    const url = restoreRedactedTransportUrlQuery(nextTransport.url, existingTransport.url);
    return headers === nextTransport.headers && url === nextTransport.url
      ? nextTransport
      : { ...nextTransport, url, headers };
  }

  if (existingTransport.type !== 'stdio') {
    return nextTransport;
  }

  if (transportTargetChanged(nextTransport, existingTransport) && transportContainsRedactedSecret(nextTransport)) {
    throw new Error('Re-enter MCP transport secrets when changing the MCP transport target');
  }

  const env = restoreRedactedSecretRecord(nextTransport.env, existingTransport.env);
  return env === nextTransport.env ? nextTransport : { ...nextTransport, env };
}

export class McpConfigService {
  private async listEffectiveConfigs(repoFullName?: string): Promise<McpServerConfig[]> {
    const [globalConfigs, repoConfigs] = await Promise.all([
      McpServerConfig.query().where({ scope: 'global', enabled: true }).whereNull('deletedAt'),
      repoFullName
        ? McpServerConfig.query().where({ scope: repoFullName, enabled: true }).whereNull('deletedAt')
        : Promise.resolve([] as McpServerConfig[]),
    ]);

    const bySlug = new Map<string, McpServerConfig>();
    for (const config of globalConfigs) {
      bySlug.set(config.slug, config);
    }
    for (const config of repoConfigs) {
      bySlug.set(config.slug, config);
    }

    return Array.from(bySlug.values());
  }

  async listEffectiveDefinitions(repoFullName?: string): Promise<McpServerConfig[]> {
    return this.listEffectiveConfigs(repoFullName);
  }

  async listByScope(scope: string): Promise<McpServerConfig[]> {
    return McpServerConfig.query().where({ scope }).whereNull('deletedAt');
  }

  async getBySlugAndScope(slug: string, scope: string): Promise<McpServerConfig | undefined> {
    const result = await McpServerConfig.query().where({ slug, scope }).whereNull('deletedAt').first();
    return result ?? undefined;
  }

  async create(input: CreateMcpServerConfigInput): Promise<McpServerConfig> {
    this.validateSlug(input.slug);

    const existing = await McpServerConfig.query()
      .where({ slug: input.slug, scope: input.scope })
      .whereNull('deletedAt')
      .first();
    if (existing) {
      throw new Error(`MCP server config with slug '${input.slug}' already exists in scope '${input.scope}'`);
    }

    const transport = normalizeTransportConfig(input.transport);
    const sharedConfig = normalizeSharedConnectionConfig(input.sharedConfig);
    const authConfig = resolveAuthConfig(input.authConfig, input.preset);
    const discoveredTools = await this.validateSharedDiscovery(transport, sharedConfig, authConfig);

    return McpServerConfig.query().insert({
      slug: input.slug,
      name: input.name,
      scope: input.scope,
      description: input.description ?? null,
      preset: input.preset ?? null,
      transport,
      sharedConfig,
      authConfig,
      enabled: input.enabled ?? true,
      timeout: input.timeout ?? 30000,
      sharedDiscoveredTools: discoveredTools,
    } as Partial<McpServerConfig>);
  }

  async update(slug: string, scope: string, input: UpdateMcpServerConfigInput): Promise<McpServerConfig> {
    const config = await this.getBySlugAndScope(slug, scope);
    if (!config) {
      throw new Error(`MCP server config '${slug}' not found in scope '${scope}'`);
    }

    const nextPreset = input.preset ?? config.preset ?? null;
    const currentTransport = normalizeTransportConfig(config.transport);
    const normalizedInputTransport = input.transport ? normalizeTransportConfig(input.transport) : undefined;
    const targetChanged = normalizedInputTransport
      ? transportTargetChanged(normalizedInputTransport, currentTransport)
      : false;
    const nextTransport = input.transport
      ? restoreRedactedTransport(normalizedInputTransport as McpTransportConfig, currentTransport)
      : currentTransport;
    const currentSharedConfig = normalizeSharedConnectionConfig(config.sharedConfig);
    const normalizedInputSharedConfig = input.sharedConfig
      ? normalizeSharedConnectionConfig(input.sharedConfig)
      : undefined;
    if (
      targetChanged &&
      (normalizedInputSharedConfig
        ? sharedConfigContainsRedactedSecret(normalizedInputSharedConfig)
        : sharedConfigContainsSecretValue(currentSharedConfig))
    ) {
      throw new Error('Re-enter MCP shared secrets when changing the MCP transport target');
    }
    const nextSharedConfig = restoreRedactedSharedConfig(
      normalizedInputSharedConfig || currentSharedConfig,
      currentSharedConfig
    );
    const nextAuthConfig =
      input.authConfig !== undefined
        ? resolveAuthConfig(input.authConfig, nextPreset)
        : resolveAuthConfig(config.authConfig, nextPreset);

    const transportChanged = JSON.stringify(nextTransport) !== JSON.stringify(currentTransport);
    const sharedConfigChanged = JSON.stringify(nextSharedConfig) !== JSON.stringify(currentSharedConfig);
    const authConfigChanged =
      JSON.stringify(nextAuthConfig) !== JSON.stringify(resolveAuthConfig(config.authConfig, config.preset));

    let sharedDiscoveredTools: McpDiscoveredTool[] | undefined;
    if (transportChanged || sharedConfigChanged || authConfigChanged || nextPreset !== (config.preset ?? null)) {
      sharedDiscoveredTools = await this.validateSharedDiscovery(nextTransport, nextSharedConfig, nextAuthConfig);
    }

    return McpServerConfig.query().patchAndFetchById(config.id, {
      name: input.name ?? config.name,
      description: input.description ?? config.description ?? null,
      preset: nextPreset,
      transport: nextTransport,
      sharedConfig: nextSharedConfig,
      authConfig: nextAuthConfig,
      enabled: input.enabled ?? config.enabled,
      timeout: input.timeout ?? config.timeout,
      ...(sharedDiscoveredTools !== undefined ? { sharedDiscoveredTools } : {}),
    } as Partial<McpServerConfig>);
  }

  async delete(slug: string, scope: string): Promise<void> {
    const config = await this.getBySlugAndScope(slug, scope);
    if (!config) {
      throw new Error(`MCP server config '${slug}' not found in scope '${scope}'`);
    }

    await McpServerConfig.softDelete(config.id);
  }

  async listEnabledConnectionsForUser(
    repoFullName: string | undefined,
    userIdentity: RequestUserIdentity
  ): Promise<AgentMcpConnection[]> {
    const configs = await this.listEffectiveConfigs(repoFullName);
    const definitionFingerprints = buildDefinitionFingerprintMap(configs);
    const connectionStates = await UserMcpConnectionService.listMaskedStatesByScopes(
      userIdentity.userId,
      ['global', ...(repoFullName ? [repoFullName] : [])],
      userIdentity.githubUsername,
      definitionFingerprints
    );

    return configs.map((config) => {
      const authConfig = resolveAuthConfig(config.authConfig, config.preset);
      const connectionRequired = requiresUserConnection(authConfig);
      const state = connectionStates.get(buildConnectionKey(config.scope, config.slug));

      return {
        slug: config.slug,
        name: config.name,
        description: config.description ?? null,
        scope: config.scope,
        preset: config.preset ?? null,
        transport: redactMcpConfigSecrets({ transport: config.transport }).transport || config.transport,
        sharedConfig: redactSharedConfigSecrets({ sharedConfig: config.sharedConfig || {} }).sharedConfig || {},
        authConfig,
        connectionRequired,
        configured: state?.configured ?? false,
        stale: state?.stale ?? false,
        configuredFieldKeys: state?.configuredFieldKeys ?? [],
        validationError: state?.validationError ?? null,
        validatedAt: state?.validatedAt ?? null,
        updatedAt: state?.updatedAt ?? null,
        discoveredTools: connectionRequired ? state?.discoveredTools || [] : config.sharedDiscoveredTools || [],
        sharedDiscoveredTools: connectionRequired ? [] : config.sharedDiscoveredTools || [],
      };
    });
  }

  async resolveServers(
    repoFullName?: string,
    disabledSlugs?: string[],
    userIdentity?: RequestUserIdentity | null
  ): Promise<ResolvedMcpServer[]> {
    const configs = await this.listEffectiveConfigs(repoFullName);
    const disabled = new Set(disabledSlugs ?? []);
    const filteredConfigs = configs.filter((config) => !disabled.has(config.slug));
    const sharedScopes = ['global', ...(repoFullName ? [repoFullName] : [])];
    const definitionFingerprints = buildDefinitionFingerprintMap(filteredConfigs);

    const userConnections = userIdentity
      ? await UserMcpConnectionService.listDecryptedConnectionsByScopes(
          userIdentity.userId,
          sharedScopes,
          userIdentity.githubUsername,
          definitionFingerprints
        )
      : new Map();

    return filteredConfigs.flatMap((config) => {
      const authConfig = resolveAuthConfig(config.authConfig, config.preset);
      const connectionState = userConnections.get(buildConnectionKey(config.scope, config.slug));
      let compiledUserConfig;
      let resolvedTransport: McpResolvedTransportConfig;

      if (authConfig.mode === 'user-fields') {
        if (
          !connectionState?.state ||
          connectionState.state.type !== 'fields' ||
          Object.keys(connectionState.state.values).length === 0
        ) {
          return [];
        }

        compiledUserConfig = compileFieldConnectionConfig(authConfig.schema, connectionState.state.values);
        const compiledConfig = mergeCompiledConnectionConfig(config.sharedConfig || {}, compiledUserConfig);
        resolvedTransport = applyCompiledConnectionConfigToTransport(config.transport, compiledConfig);

        if ((connectionState.discoveredTools || []).length === 0) {
          return [];
        }

        return [
          {
            scope: config.scope,
            slug: config.slug,
            name: config.name,
            transport: resolvedTransport,
            timeout: config.timeout,
            defaultArgs: compiledConfig.defaultArgs,
            env: compiledConfig.env,
            discoveredTools: connectionState.discoveredTools || [],
          },
        ];
      }

      if (authConfig.mode === 'oauth') {
        if (!userIdentity || !connectionState?.state || connectionState.state.type !== 'oauth') {
          return [];
        }

        resolvedTransport = applyCompiledConnectionConfigToTransport(
          config.transport,
          mergeCompiledConnectionConfig(config.sharedConfig || {}, undefined),
          {
            authProvider: new PersistentOAuthClientProvider({
              userId: userIdentity.userId,
              ownerGithubUsername: userIdentity.githubUsername,
              scope: config.scope,
              slug: config.slug,
              definitionFingerprint: definitionFingerprints.get(buildConnectionKey(config.scope, config.slug)) || '',
              authConfig,
              redirectUrl: buildOAuthCallbackUrl(config.slug, config.scope),
              initialState: connectionState.state,
              discoveredTools: connectionState.discoveredTools,
              validatedAt: connectionState.validatedAt,
              interactive: false,
            }),
          }
        );

        if ((connectionState.discoveredTools || []).length === 0) {
          return [];
        }

        const compiledConfig = mergeCompiledConnectionConfig(config.sharedConfig || {}, undefined);
        return [
          {
            scope: config.scope,
            slug: config.slug,
            name: config.name,
            transport: resolvedTransport,
            timeout: config.timeout,
            defaultArgs: compiledConfig.defaultArgs,
            env: compiledConfig.env,
            discoveredTools: connectionState.discoveredTools || [],
          },
        ];
      }

      const compiledConfig = mergeCompiledConnectionConfig(config.sharedConfig || {}, undefined);
      resolvedTransport = applyCompiledConnectionConfigToTransport(config.transport, compiledConfig);
      const discoveredTools = config.sharedDiscoveredTools || [];

      if (discoveredTools.length === 0) {
        return [];
      }

      return [
        {
          scope: config.scope,
          slug: config.slug,
          name: config.name,
          transport: resolvedTransport,
          timeout: config.timeout,
          defaultArgs: compiledConfig.defaultArgs,
          env: compiledConfig.env,
          discoveredTools,
        },
      ];
    });
  }

  async resolveServersForRepo(
    repoFullName: string,
    disabledSlugs?: string[],
    userIdentity?: RequestUserIdentity | null
  ): Promise<ResolvedMcpServer[]> {
    return this.resolveServers(repoFullName, disabledSlugs, userIdentity);
  }

  async resolveSessionPodServersForRepo(
    repoFullName: string,
    disabledSlugs?: string[],
    userIdentity?: RequestUserIdentity | null
  ): Promise<ResolvedMcpServer[]> {
    const resolved = await this.resolveServersForRepo(repoFullName, disabledSlugs, userIdentity);
    return resolved.filter((server) => usesSessionWorkspaceGatewayExecution(server.transport));
  }

  async discoverTools(
    transport: McpResolvedTransportConfig,
    timeoutMs = VALIDATION_TIMEOUT_MS
  ): Promise<McpDiscoveredTool[]> {
    const client = new McpClientManager();
    try {
      await client.connect(transport, timeoutMs);
      return await client.listTools();
    } finally {
      await client.close();
    }
  }

  async refreshSharedDiscoveredTools(
    config: Pick<
      McpServerConfig,
      'id' | 'slug' | 'preset' | 'transport' | 'sharedConfig' | 'authConfig' | 'timeout' | 'sharedDiscoveredTools'
    >
  ): Promise<McpDiscoveredTool[]> {
    const authConfig = resolveAuthConfig(config.authConfig, config.preset);
    const discoveredTools = await this.validateSharedDiscovery(config.transport, config.sharedConfig, authConfig, {
      timeoutMs: config.timeout,
    });

    await this.syncSharedDiscoveredTools(config, discoveredTools);
    return discoveredTools;
  }

  async syncSharedDiscoveredTools(
    config: Pick<McpServerConfig, 'id' | 'slug' | 'sharedDiscoveredTools'>,
    discoveredTools: McpDiscoveredTool[]
  ): Promise<void> {
    const existingNames = (config.sharedDiscoveredTools || [])
      .map((tool) => tool.name)
      .sort()
      .join(',');
    const newNames = discoveredTools
      .map((tool) => tool.name)
      .sort()
      .join(',');

    if (existingNames !== newNames) {
      await McpServerConfig.query().patchAndFetchById(config.id, { sharedDiscoveredTools: discoveredTools });
    }
  }

  private validateSlug(slug: string): void {
    if (!slug || slug.length > MAX_SLUG_LENGTH || !SLUG_REGEX.test(slug)) {
      throw new Error(
        `Invalid slug '${slug}': must be 1-${MAX_SLUG_LENGTH} lowercase alphanumeric characters or hyphens, no leading/trailing hyphens`
      );
    }
  }

  private async validateSharedDiscovery(
    transport: McpTransportConfig,
    sharedConfig: McpServerConfigRecord['sharedConfig'],
    authConfig: McpAuthConfig,
    options: {
      timeoutMs?: number;
    } = {}
  ): Promise<McpDiscoveredTool[]> {
    const connectionRequired = requiresUserConnection(authConfig);
    if (connectionRequired) {
      getLogger().info(`MCP: shared discovery deferred transport=${transport.type} reason=user_connection_required`);
      return [];
    }

    const compiledConfig = mergeCompiledConnectionConfig(sharedConfig || {}, undefined);
    const resolvedTransport = applyCompiledConnectionConfigToTransport(transport, compiledConfig);

    try {
      return await this.discoverTools(resolvedTransport, options.timeoutMs ?? VALIDATION_TIMEOUT_MS);
    } catch (error) {
      const message = sanitizeMcpErrorMessage(error, [{ compiledConfig, transport: resolvedTransport }]);
      throw new Error(`MCP server connectivity validation failed: ${message}`);
    }
  }
}
