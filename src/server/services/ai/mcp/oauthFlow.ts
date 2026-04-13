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

import { randomBytes, randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { defaultRedis } from 'server/lib/dependencies';

const MCP_OAUTH_FLOW_REDIS_PREFIX = 'lifecycle:agent:mcp-oauth-flow:';
const MCP_OAUTH_FLOW_TTL_SECONDS = 10 * 60;
const MCP_OAUTH_STATE_SEPARATOR = '.';
const CONSUME_OAUTH_FLOW_SCRIPT = `
local value = redis.call('get', KEYS[1])
if value then
  redis.call('del', KEYS[1])
end
return value
`;

type OAuthFlowRedis = Pick<Redis, 'del' | 'eval' | 'get' | 'setex'>;

export interface McpOAuthFlowRecord {
  flowId: string;
  userId: string;
  ownerGithubUsername: string | null;
  slug: string;
  scope: string;
  definitionFingerprint: string;
  appOrigin: string | null;
  createdAt: string;
}

export type CreateMcpOAuthFlowInput = Omit<McpOAuthFlowRecord, 'createdAt' | 'flowId'>;

function oauthFlowKey(flowId: string): string {
  return `${MCP_OAUTH_FLOW_REDIS_PREFIX}${flowId}`;
}

export function buildMcpOAuthState(flowId: string): string {
  const normalizedFlowId = normalizeNullableString(flowId);
  if (!normalizedFlowId) {
    throw new Error('Flow id is required to build an OAuth state token');
  }

  return `${normalizedFlowId}${MCP_OAUTH_STATE_SEPARATOR}${randomBytes(16).toString('hex')}`;
}

export function extractMcpOAuthFlowId(state: string | null | undefined): string | null {
  const normalizedState = normalizeNullableString(state);
  if (!normalizedState) {
    return null;
  }

  const separatorIndex = normalizedState.indexOf(MCP_OAUTH_STATE_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }

  return normalizedState.slice(0, separatorIndex);
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRecord(input: unknown): McpOAuthFlowRecord | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const flowId = normalizeNullableString(candidate.flowId);
  const userId = normalizeNullableString(candidate.userId);
  const slug = normalizeNullableString(candidate.slug);
  const scope = normalizeNullableString(candidate.scope);
  const definitionFingerprint = normalizeNullableString(candidate.definitionFingerprint);
  const createdAt = normalizeNullableString(candidate.createdAt);

  if (!flowId || !userId || !slug || !scope || !definitionFingerprint || !createdAt) {
    return null;
  }

  return {
    flowId,
    userId,
    ownerGithubUsername: normalizeNullableString(candidate.ownerGithubUsername),
    slug,
    scope,
    definitionFingerprint,
    appOrigin: normalizeNullableString(candidate.appOrigin),
    createdAt,
  };
}

function parseRecord(raw: unknown): McpOAuthFlowRecord | null {
  if (typeof raw !== 'string') {
    return null;
  }

  try {
    return normalizeRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export default class McpOAuthFlowService {
  static async create(
    input: CreateMcpOAuthFlowInput,
    redis: OAuthFlowRedis = defaultRedis
  ): Promise<McpOAuthFlowRecord> {
    const record: McpOAuthFlowRecord = {
      flowId: randomUUID(),
      userId: input.userId,
      ownerGithubUsername: input.ownerGithubUsername ?? null,
      slug: input.slug,
      scope: input.scope,
      definitionFingerprint: input.definitionFingerprint,
      appOrigin: input.appOrigin ?? null,
      createdAt: new Date().toISOString(),
    };

    await redis.setex(oauthFlowKey(record.flowId), MCP_OAUTH_FLOW_TTL_SECONDS, JSON.stringify(record));

    return record;
  }

  static async get(flowId: string, redis: OAuthFlowRedis = defaultRedis): Promise<McpOAuthFlowRecord | null> {
    const normalizedFlowId = flowId.trim();
    if (!normalizedFlowId) {
      return null;
    }

    return parseRecord(await redis.get(oauthFlowKey(normalizedFlowId)));
  }

  static async consume(flowId: string, redis: OAuthFlowRedis = defaultRedis): Promise<McpOAuthFlowRecord | null> {
    const normalizedFlowId = flowId.trim();
    if (!normalizedFlowId) {
      return null;
    }

    const raw = (await redis.eval(CONSUME_OAUTH_FLOW_SCRIPT, 1, oauthFlowKey(normalizedFlowId))) as string | null;

    return parseRecord(raw);
  }

  static async invalidate(flowId: string, redis: OAuthFlowRedis = defaultRedis): Promise<void> {
    const normalizedFlowId = flowId.trim();
    if (!normalizedFlowId) {
      return;
    }

    await redis.del(oauthFlowKey(normalizedFlowId));
  }
}
