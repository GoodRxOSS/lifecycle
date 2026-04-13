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
  McpAuthConfig,
  McpDiscoveredTool,
  McpResolvedTransportConfig,
  McpServerConfigRecord,
  McpTransportConfig,
  ResolvedMcpServer,
  UpdateMcpServerConfigInput,
} from './types';

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const MAX_SLUG_LENGTH = 100;
const VALIDATION_TIMEOUT_MS = 5000;
const REDACTED_SHARED_SECRET = '******';

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

export function redactSharedConfigSecrets<T extends { sharedConfig?: { headers?: Record<string, string> } | null }>(
  config: T
): T {
  if (!config.sharedConfig?.headers || typeof config.sharedConfig.headers !== 'object') {
    return config;
  }

  return {
    ...config,
    sharedConfig: {
      ...config.sharedConfig,
      headers: Object.fromEntries(Object.keys(config.sharedConfig.headers).map((key) => [key, REDACTED_SHARED_SECRET])),
    },
  };
}

function restoreRedactedSharedHeaders(
  nextSharedConfig: McpServerConfigRecord['sharedConfig'],
  existingSharedConfig: McpServerConfigRecord['sharedConfig']
): McpServerConfigRecord['sharedConfig'] {
  if (!nextSharedConfig?.headers || !existingSharedConfig?.headers) {
    return nextSharedConfig;
  }

  let changed = false;
  const headers = { ...nextSharedConfig.headers };
  for (const [key, value] of Object.entries(headers)) {
    if (value === REDACTED_SHARED_SECRET && existingSharedConfig.headers[key]) {
      headers[key] = existingSharedConfig.headers[key];
      changed = true;
    }
  }

  return changed ? { ...nextSharedConfig, headers } : nextSharedConfig;
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
    const nextTransport = input.transport ? normalizeTransportConfig(input.transport) : config.transport;
    const currentSharedConfig = normalizeSharedConnectionConfig(config.sharedConfig);
    const nextSharedConfig = restoreRedactedSharedHeaders(
      input.sharedConfig ? normalizeSharedConnectionConfig(input.sharedConfig) : currentSharedConfig,
      currentSharedConfig
    );
    const nextAuthConfig =
      input.authConfig !== undefined
        ? resolveAuthConfig(input.authConfig, nextPreset)
        : resolveAuthConfig(config.authConfig, nextPreset);

    const transportChanged = JSON.stringify(nextTransport) !== JSON.stringify(config.transport);
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
        transport: config.transport,
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

  async resolveServersForRepo(
    repoFullName: string,
    disabledSlugs?: string[],
    userIdentity?: RequestUserIdentity | null
  ): Promise<ResolvedMcpServer[]> {
    const configs = await this.listEffectiveConfigs(repoFullName);
    const disabled = new Set(disabledSlugs ?? []);
    const filteredConfigs = configs.filter((config) => !disabled.has(config.slug));
    const sharedScopes = ['global', repoFullName];
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
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP server connectivity validation failed: ${message}`);
    }
  }
}
