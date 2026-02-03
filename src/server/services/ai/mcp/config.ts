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

import McpServerConfig from 'server/models/McpServerConfig';
import { CreateMcpServerConfigInput, UpdateMcpServerConfigInput, ResolvedMcpServer, McpCachedTool } from './types';
import { McpClientManager } from './client';

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const MAX_SLUG_LENGTH = 100;
const VALIDATION_TIMEOUT_MS = 5000;

export class McpConfigService {
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

    const cachedTools = await this.validateConnectivity(input.url, input.headers);

    return McpServerConfig.query().insert({
      slug: input.slug,
      name: input.name,
      url: input.url,
      scope: input.scope,
      description: input.description ?? null,
      headers: input.headers ?? {},
      envVars: input.envVars ?? {},
      enabled: input.enabled ?? true,
      timeout: input.timeout ?? 30000,
      cachedTools,
    });
  }

  async update(slug: string, scope: string, input: UpdateMcpServerConfigInput): Promise<McpServerConfig> {
    const config = await this.getBySlugAndScope(slug, scope);
    if (!config) {
      throw new Error(`MCP server config '${slug}' not found in scope '${scope}'`);
    }

    let cachedTools: McpCachedTool[] | undefined;
    const urlChanged = input.url !== undefined && input.url !== config.url;
    const headersChanged = input.headers !== undefined;
    if (urlChanged || headersChanged) {
      const url = input.url ?? config.url;
      const headers = input.headers ?? config.headers;
      cachedTools = await this.validateConnectivity(url, headers);
    }

    const patch: Record<string, unknown> = { ...input };
    if (cachedTools) {
      patch.cachedTools = cachedTools;
    }

    return McpServerConfig.query().patchAndFetchById(config.id, patch);
  }

  async delete(slug: string, scope: string): Promise<void> {
    const config = await this.getBySlugAndScope(slug, scope);
    if (!config) {
      throw new Error(`MCP server config '${slug}' not found in scope '${scope}'`);
    }
    await McpServerConfig.softDelete(config.id);
  }

  async resolveServersForRepo(repoFullName: string, disabledSlugs?: string[]): Promise<ResolvedMcpServer[]> {
    const [globalConfigs, repoConfigs] = await Promise.all([
      McpServerConfig.query().where({ scope: 'global', enabled: true }).whereNull('deletedAt'),
      McpServerConfig.query().where({ scope: repoFullName, enabled: true }).whereNull('deletedAt'),
    ]);

    const disabled = new Set(disabledSlugs ?? []);
    const filteredGlobal = globalConfigs.filter((c) => !disabled.has(c.slug));

    return [...filteredGlobal, ...repoConfigs].map((c) => ({
      slug: c.slug,
      name: c.name,
      url: c.url,
      headers: c.headers,
      envVars: c.envVars,
      timeout: c.timeout,
      cachedTools: c.cachedTools,
    }));
  }

  private validateSlug(slug: string): void {
    if (!slug || slug.length > MAX_SLUG_LENGTH || !SLUG_REGEX.test(slug)) {
      throw new Error(
        `Invalid slug '${slug}': must be 1-${MAX_SLUG_LENGTH} lowercase alphanumeric characters or hyphens, no leading/trailing hyphens`
      );
    }
  }

  private async validateConnectivity(url: string, headers?: Record<string, string>): Promise<McpCachedTool[]> {
    const client = new McpClientManager();
    try {
      await client.connect(url, headers, VALIDATION_TIMEOUT_MS);
      const tools = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } catch (error) {
      throw new Error(
        `MCP server connectivity validation failed for ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      await client.close();
    }
  }
}
