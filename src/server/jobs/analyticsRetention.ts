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

import AuthAuditEvent from 'server/models/AuthAuditEvent';
import GlobalConfigService from 'server/services/globalConfig';
import { getLogger } from 'server/lib/logger';

export const ANALYTICS_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ANALYTICS_RETENTION_MAX_DAYS = 3650;
const BATCH_SIZE = 5000;

export interface AnalyticsRetention {
  mcpToolCallDays: number;
  buildEventDays: number;
}

const days = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, ANALYTICS_RETENTION_MAX_DAYS);
};

export async function readAnalyticsRetention(): Promise<AnalyticsRetention> {
  const config = (await GlobalConfigService.getInstance().getConfig('analytics_retention')) as
    | { mcpToolCallDays?: unknown; buildEventDays?: unknown }
    | null
    | undefined;
  return { mcpToolCallDays: days(config?.mcpToolCallDays), buildEventDays: days(config?.buildEventDays) };
}

async function deleteInBatches(sql: string, cutoff: string): Promise<number> {
  const knex = AuthAuditEvent.knex();
  let deleted = 0;
  for (;;) {
    const result = (await knex.raw(sql, [cutoff, BATCH_SIZE])) as { rowCount?: number };
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < BATCH_SIZE) break;
  }
  return deleted;
}

const cutoffFor = (retentionDays: number) => new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

/** Deletes only recorded MCP tool calls and build events; every other audit event is kept. */
export async function processAnalyticsRetentionSweep(): Promise<{ mcpToolCalls: number; buildEvents: number }> {
  const retention = await readAnalyticsRetention();
  const mcpToolCalls = retention.mcpToolCallDays
    ? await deleteInBatches(
        `DELETE FROM auth_audit_events WHERE id IN (
          SELECT id FROM auth_audit_events WHERE event = 'mcp.tool_call' AND "createdAt" < ? ORDER BY id LIMIT ?)`,
        cutoffFor(retention.mcpToolCallDays)
      )
    : 0;
  const buildEvents = retention.buildEventDays
    ? await deleteInBatches(
        `DELETE FROM build_events WHERE id IN (SELECT id FROM build_events WHERE "createdAt" < ? ORDER BY id LIMIT ?)`,
        cutoffFor(retention.buildEventDays)
      )
    : 0;
  if (mcpToolCalls > 0 || buildEvents > 0) {
    getLogger().info({ retention, mcpToolCalls, buildEvents }, 'Analytics: retention sweep deleted records');
  }
  return { mcpToolCalls, buildEvents };
}
