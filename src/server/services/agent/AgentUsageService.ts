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

import AgentRun from 'server/models/AgentRun';
import type { AgentRunStatus } from './types';
import AgentThreadService from './ThreadService';

const OPTIONAL_USAGE_NUMERIC_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'nonCachedInputTokens',
  'textOutputTokens',
  'totalCostUsd',
  'estimatedCostUsd',
] as const;

type OptionalUsageField = (typeof OPTIONAL_USAGE_NUMERIC_FIELDS)[number];
type UsageRecord = Partial<Record<OptionalUsageField | 'totalTokens', unknown>>;

const MISSING_USAGE_STATUSES: AgentRunStatus[] = [
  'waiting_for_approval',
  'waiting_for_input',
  'transitioned',
  'completed',
  'failed',
  'cancelled',
];

export interface AgentUsageRunRecord {
  sessionId?: number;
  status: AgentRunStatus;
  resolvedProvider?: string | null;
  resolvedModel?: string | null;
  provider?: string | null;
  model?: string | null;
  usageSummary?: Record<string, unknown> | null;
}

export interface AgentUsageSummary {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  nonCachedInputTokens?: number;
  textOutputTokens?: number;
  totalCostUsd?: number;
  estimatedCostUsd?: number;
}

export interface AgentUsageByModel extends AgentUsageSummary {
  provider: string;
  model: string;
  runCount: number;
  reportedRunCount: number;
  missingUsageRunCount: number;
}

export interface AgentUsageCompleteness {
  runCount: number;
  reportedRunCount: number;
  missingUsageRunCount: number;
  complete: boolean;
}

export interface AgentUsageAggregate {
  usageSummary: AgentUsageSummary;
  usageByModel: AgentUsageByModel[];
  usageCompleteness: AgentUsageCompleteness;
}

export interface AgentThreadUsageAggregate extends AgentUsageAggregate {
  threadId: string;
  sessionId: string;
}

export interface AgentSessionUsageAggregate extends AgentUsageAggregate {
  sessionId: string;
}

interface UsageBucket {
  provider: string;
  model: string;
  usageSummary: AgentUsageSummary;
  runCount: number;
  reportedRunCount: number;
  missingUsageRunCount: number;
}

function readUsageRecord(value: unknown): UsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as UsageRecord;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readExactTotal(usageSummary: UsageRecord): number | undefined {
  const totalTokens = readFiniteNumber(usageSummary.totalTokens);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  const inputTokens = readFiniteNumber(usageSummary.inputTokens);
  const outputTokens = readFiniteNumber(usageSummary.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  const computedTotal = inputTokens + outputTokens;
  return Number.isFinite(computedTotal) ? computedTotal : undefined;
}

function addOptionalUsageNumericFields(target: AgentUsageSummary, usageSummary: UsageRecord): void {
  for (const field of OPTIONAL_USAGE_NUMERIC_FIELDS) {
    const amount = readFiniteNumber(usageSummary[field]);
    if (amount !== undefined) {
      target[field] = (target[field] ?? 0) + amount;
    }
  }
}

function readAttributionValue(primary: unknown, fallback: unknown, unknownValue: string): string {
  if (typeof primary === 'string' && primary.trim()) {
    return primary.trim();
  }

  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim();
  }

  return unknownValue;
}

function readAttribution(run: AgentUsageRunRecord): { provider: string; model: string } {
  return {
    provider: readAttributionValue(run.resolvedProvider, run.provider, 'unknown_provider'),
    model: readAttributionValue(run.resolvedModel, run.model, 'unknown_model'),
  };
}

function shouldCountMissingUsage(run: AgentUsageRunRecord): boolean {
  return MISSING_USAGE_STATUSES.includes(run.status);
}

function serializeUsageBucket(bucket: UsageBucket): AgentUsageByModel {
  return {
    provider: bucket.provider,
    model: bucket.model,
    ...bucket.usageSummary,
    runCount: bucket.runCount,
    reportedRunCount: bucket.reportedRunCount,
    missingUsageRunCount: bucket.missingUsageRunCount,
  };
}

export default class AgentUsageService {
  static aggregateRuns(runs: AgentUsageRunRecord[]): AgentUsageAggregate {
    const usageSummary: AgentUsageSummary = {
      totalTokens: 0,
    };
    const bucketsByAttribution = new Map<string, UsageBucket>();
    let reportedRunCount = 0;
    let missingUsageRunCount = 0;

    for (const run of runs) {
      const attribution = readAttribution(run);
      const bucketKey = `${attribution.provider}\0${attribution.model}`;
      let bucket = bucketsByAttribution.get(bucketKey);
      if (!bucket) {
        bucket = {
          provider: attribution.provider,
          model: attribution.model,
          usageSummary: {
            totalTokens: 0,
          },
          runCount: 0,
          reportedRunCount: 0,
          missingUsageRunCount: 0,
        };
        bucketsByAttribution.set(bucketKey, bucket);
      }

      bucket.runCount += 1;
      const runUsageSummary = readUsageRecord(run.usageSummary);
      const exactTotal = readExactTotal(runUsageSummary);
      if (exactTotal !== undefined) {
        usageSummary.totalTokens += exactTotal;
        bucket.usageSummary.totalTokens += exactTotal;
        reportedRunCount += 1;
        bucket.reportedRunCount += 1;
      } else if (shouldCountMissingUsage(run)) {
        missingUsageRunCount += 1;
        bucket.missingUsageRunCount += 1;
      }

      addOptionalUsageNumericFields(usageSummary, runUsageSummary);
      addOptionalUsageNumericFields(bucket.usageSummary, runUsageSummary);
    }

    return {
      usageSummary,
      usageByModel: [...bucketsByAttribution.values()].map(serializeUsageBucket),
      usageCompleteness: {
        runCount: runs.length,
        reportedRunCount,
        missingUsageRunCount,
        complete: missingUsageRunCount === 0,
      },
    };
  }

  static async aggregateThreadUsage(threadId: number): Promise<AgentUsageAggregate> {
    const runs = await AgentRun.query().where({ threadId }).orderBy('createdAt', 'asc').orderBy('id', 'asc');
    return this.aggregateRuns(runs);
  }

  static async aggregateSessionUsage(sessionId: number): Promise<AgentUsageAggregate> {
    const runs = await AgentRun.query().where({ sessionId }).orderBy('createdAt', 'asc').orderBy('id', 'asc');
    return this.aggregateRuns(runs);
  }

  static async aggregateSessionsUsage(sessionIds: number[]): Promise<Map<number, AgentUsageAggregate>> {
    const usageBySessionId = new Map<number, AgentUsageAggregate>();
    for (const sessionId of sessionIds) {
      usageBySessionId.set(sessionId, this.aggregateRuns([]));
    }

    if (sessionIds.length === 0) {
      return usageBySessionId;
    }

    const runs = await AgentRun.query()
      .whereIn('sessionId', sessionIds)
      .orderBy('sessionId', 'asc')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc');
    const runsBySessionId = new Map<number, AgentUsageRunRecord[]>();

    for (const run of runs) {
      const existing = runsBySessionId.get(run.sessionId) || [];
      existing.push(run);
      runsBySessionId.set(run.sessionId, existing);
    }

    for (const [sessionId, sessionRuns] of runsBySessionId.entries()) {
      usageBySessionId.set(sessionId, this.aggregateRuns(sessionRuns));
    }

    return usageBySessionId;
  }

  static async getOwnedThreadUsage(threadId: string, userId: string): Promise<AgentThreadUsageAggregate> {
    const { thread, session } = await AgentThreadService.getOwnedThreadWithSession(threadId, userId);
    const aggregate = await this.aggregateThreadUsage(thread.id);

    return {
      threadId: thread.uuid,
      sessionId: session.uuid,
      ...aggregate,
    };
  }

  static async getOwnedSessionUsage(sessionId: string, userId: string): Promise<AgentSessionUsageAggregate> {
    const session = await AgentThreadService.getOwnedSession(sessionId, userId);
    const aggregate = await this.aggregateSessionUsage(session.id);

    return {
      sessionId: session.uuid,
      ...aggregate,
    };
  }
}
