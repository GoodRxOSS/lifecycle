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

import RedisClient from 'server/lib/redisClient';
import { decrypt, encrypt } from 'server/lib/encryption';
import { getLogger } from 'server/lib/logger';
import type { AgentRequestGitHubAuth, AgentWriteAuthorizedGitHubAuth } from './githubAuth';
import { hasWriteAuthorizedUserGitHubAuth } from './githubAuth';

const HANDOFF_TTL_SECONDS = 60 * 60;

type ApprovalGitHubAuthHandoffRecord = {
  runUuid: string;
  actionUuid: string;
  toolCallId: string | null;
  approvedByUserId: string;
  githubUsername?: string | null;
  encryptedGithubToken: string;
  createdAt: string;
  expiresAt: string;
};

type StoreHandoffOptions = {
  runUuid: string;
  actionUuid: string;
  toolCallId?: string | null;
  approvedByUserId: string;
  auth: AgentRequestGitHubAuth;
};

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

function actionKey(runUuid: string, actionUuid: string): string {
  return `agent:approval-github-auth:run:${keyPart(runUuid)}:action:${keyPart(actionUuid)}`;
}

function toolKey(runUuid: string, toolCallId: string): string {
  return `agent:approval-github-auth:run:${keyPart(runUuid)}:tool:${keyPart(toolCallId)}`;
}

function runIndexKey(runUuid: string): string {
  return `agent:approval-github-auth:run:${keyPart(runUuid)}:keys`;
}

function parseRecord(value: string | null): ApprovalGitHubAuthHandoffRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ApprovalGitHubAuthHandoffRecord>;
    if (
      typeof parsed.runUuid !== 'string' ||
      typeof parsed.actionUuid !== 'string' ||
      typeof parsed.approvedByUserId !== 'string' ||
      typeof parsed.encryptedGithubToken !== 'string'
    ) {
      return null;
    }

    return {
      runUuid: parsed.runUuid,
      actionUuid: parsed.actionUuid,
      toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null,
      approvedByUserId: parsed.approvedByUserId,
      githubUsername: parsed.githubUsername || null,
      encryptedGithubToken: parsed.encryptedGithubToken,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function toAuth(record: ApprovalGitHubAuthHandoffRecord): AgentWriteAuthorizedGitHubAuth {
  return {
    githubToken: decrypt(record.encryptedGithubToken),
    source: 'user',
    githubUsername: record.githubUsername || null,
    writeAuthorized: true,
  };
}

export default class ApprovalGitHubAuthHandoffService {
  private static redis() {
    return RedisClient.getInstance().getRedis();
  }

  static async store(options: StoreHandoffOptions): Promise<void> {
    if (!hasWriteAuthorizedUserGitHubAuth(options.auth)) {
      throw new Error('Approval GitHub auth handoff requires a write-authorized user token.');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + HANDOFF_TTL_SECONDS * 1000);
    const record: ApprovalGitHubAuthHandoffRecord = {
      runUuid: options.runUuid,
      actionUuid: options.actionUuid,
      toolCallId: options.toolCallId?.trim() || null,
      approvedByUserId: options.approvedByUserId,
      githubUsername: options.auth.githubUsername || null,
      encryptedGithubToken: encrypt(options.auth.githubToken),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const payload = JSON.stringify(record);
    const redis = this.redis();
    const keys = [actionKey(options.runUuid, options.actionUuid)];
    if (record.toolCallId) {
      keys.push(toolKey(options.runUuid, record.toolCallId));
    }

    await Promise.all(keys.map((key) => redis.set(key, payload, 'EX', HANDOFF_TTL_SECONDS)));
    await redis.sadd(runIndexKey(options.runUuid), ...keys);
    await redis.expire(runIndexKey(options.runUuid), HANDOFF_TTL_SECONDS);
  }

  static async getByAction(runUuid: string, actionUuid: string): Promise<AgentWriteAuthorizedGitHubAuth | null> {
    const record = parseRecord(await this.redis().get(actionKey(runUuid, actionUuid)));
    return record ? toAuth(record) : null;
  }

  static async getByToolCallId(
    runUuid: string,
    toolCallId: string | null | undefined
  ): Promise<AgentWriteAuthorizedGitHubAuth | null> {
    if (!toolCallId?.trim()) {
      return null;
    }

    const record = parseRecord(await this.redis().get(toolKey(runUuid, toolCallId.trim())));
    return record ? toAuth(record) : null;
  }

  static async getFirstForRun(runUuid: string): Promise<AgentWriteAuthorizedGitHubAuth | null> {
    const redis = this.redis();
    const keys = await redis.smembers(runIndexKey(runUuid));
    for (const key of keys) {
      const record = parseRecord(await redis.get(key));
      if (record) {
        return toAuth(record);
      }
    }
    return null;
  }

  static async clearAction(runUuid: string, actionUuid: string, toolCallId?: string | null): Promise<void> {
    const redis = this.redis();
    const keys = [actionKey(runUuid, actionUuid)];
    if (toolCallId?.trim()) {
      keys.push(toolKey(runUuid, toolCallId.trim()));
    }
    await redis.del(...keys).catch((error) => {
      getLogger().warn({ error, runUuid, actionUuid }, 'AgentApproval: GitHub auth handoff cleanup failed');
    });
  }

  static async clearRun(runUuid: string): Promise<void> {
    const redis = this.redis();
    const indexKey = runIndexKey(runUuid);
    const keys = await redis.smembers(indexKey).catch(() => []);
    if (keys.length > 0) {
      await redis.del(...keys, indexKey).catch((error) => {
        getLogger().warn({ error, runUuid }, 'AgentApproval: GitHub auth handoff run cleanup failed');
      });
    } else {
      await redis.del(indexKey).catch(() => {});
    }
  }
}
