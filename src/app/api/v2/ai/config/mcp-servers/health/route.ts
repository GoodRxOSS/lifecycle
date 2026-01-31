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

import { NextRequest, NextResponse } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { McpClientManager } from 'server/services/ai/mcp/client';
import { McpCachedTool } from 'server/services/ai/mcp/types';
import McpServerConfig from 'server/models/McpServerConfig';
import 'server/lib/dependencies';
import { getLogger } from 'server/lib/logger';

interface ServerHealthResult {
  slug: string;
  name: string;
  reachable: boolean;
  toolCount: number;
  latencyMs: number;
  error: string | null;
  cacheRefreshed: boolean;
}

async function checkServerHealth(config: McpServerConfig): Promise<ServerHealthResult> {
  const client = new McpClientManager();
  const start = Date.now();
  let cacheRefreshed = false;

  try {
    await client.connect(config.url, config.headers, config.timeout);
    const tools = await client.listTools();
    const latencyMs = Date.now() - start;

    if (tools.length === 0) {
      return {
        slug: config.slug,
        name: config.name,
        reachable: false,
        toolCount: 0,
        latencyMs,
        error: 'Server returned 0 tools',
        cacheRefreshed: false,
      };
    }

    const newCachedTools: McpCachedTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));

    const existingNames = (config.cachedTools || [])
      .map((t) => t.name)
      .sort()
      .join(',');
    const newNames = newCachedTools
      .map((t) => t.name)
      .sort()
      .join(',');

    if (existingNames !== newNames) {
      try {
        await McpServerConfig.query().patchAndFetchById(config.id, { cachedTools: newCachedTools });
        cacheRefreshed = true;
        getLogger().info(
          `MCP cache refreshed for server=${config.slug} oldCount=${config.cachedTools?.length ?? 0} newCount=${
            newCachedTools.length
          }`
        );
      } catch (cacheError) {
        getLogger().warn(
          `MCP cache update failed for server=${config.slug}: ${
            cacheError instanceof Error ? cacheError.message : String(cacheError)
          }`
        );
      }
    }

    return {
      slug: config.slug,
      name: config.name,
      reachable: true,
      toolCount: tools.length,
      latencyMs,
      error: null,
      cacheRefreshed,
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    return {
      slug: config.slug,
      name: config.name,
      reachable: false,
      toolCount: 0,
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
      cacheRefreshed: false,
    };
  } finally {
    await client.close();
  }
}

const getHandler = async (_req: NextRequest) => {
  const allConfigs = await McpServerConfig.query().where({ enabled: true }).whereNull('deletedAt');

  if (allConfigs.length === 0) {
    return NextResponse.json({ healthy: true, servers: [] });
  }

  const results = await Promise.allSettled(allConfigs.map((config) => checkServerHealth(config)));

  const servers: ServerHealthResult[] = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return {
      slug: allConfigs[index].slug,
      name: allConfigs[index].name,
      reachable: false,
      toolCount: 0,
      latencyMs: 0,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      cacheRefreshed: false,
    };
  });

  const healthy = servers.every((s) => s.reachable);

  return NextResponse.json({ healthy, servers });
};

export const GET = createApiHandler(getHandler);
