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

import type { AgentRunUsageSummary } from './types';

type UsageLike =
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        noCacheTokens?: number;
      };
      outputTokenDetails?: {
        reasoningTokens?: number;
        textTokens?: number;
      };
      raw?: unknown;
    }
  | null
  | undefined;

type ResponseLike =
  | {
      id?: string;
      modelId?: string;
      timestamp?: string | Date | number;
    }
  | null
  | undefined;

type ProviderMetadataLike = Record<string, unknown> | null | undefined;

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toISOString();
  }

  return undefined;
}

type CostCandidate = {
  totalCostUsd: number;
  costSource: string;
};

const DIRECT_USD_KEYS = ['totalCostUsd', 'costUsd', 'usdCost', 'total_cost_usd', 'cost_usd'] as const;
const DIRECT_COST_KEYS = ['cost', 'marketCost', 'total_cost', 'market_cost'] as const;
const STRUCTURED_USD_KEYS = ['billing', 'price', 'pricing', 'totalCost'] as const;

function extractStructuredUsdValue(container: Record<string, unknown>, source: string): CostCandidate | undefined {
  const currency = typeof container.currency === 'string' ? container.currency : null;
  const amount =
    parseFiniteNumber(container.amount) ??
    parseFiniteNumber(container.value) ??
    parseFiniteNumber(container.total) ??
    parseFiniteNumber(container.usd);

  if (currency && currency.toLowerCase() === 'usd' && amount != null) {
    return {
      totalCostUsd: amount,
      costSource: source,
    };
  }

  const usdAmount = parseFiniteNumber(container.usd);
  if (usdAmount != null) {
    return {
      totalCostUsd: usdAmount,
      costSource: source,
    };
  }

  return undefined;
}

function extractExplicitUsdCandidate(
  value: unknown,
  sourcePrefix: string,
  seen: Set<unknown>,
  depth: number
): CostCandidate | undefined {
  if (!value || depth > 4 || seen.has(value)) {
    return undefined;
  }

  const record = toRecord(value);
  if (!record) {
    return undefined;
  }

  seen.add(record);

  for (const key of DIRECT_USD_KEYS) {
    const amount = parseFiniteNumber(record[key]);
    if (amount != null) {
      return {
        totalCostUsd: amount,
        costSource: `${sourcePrefix}.${key}`,
      };
    }
  }

  for (const key of DIRECT_COST_KEYS) {
    const amount = parseFiniteNumber(record[key]);
    if (amount != null) {
      return {
        totalCostUsd: amount,
        costSource: `${sourcePrefix}.${key}`,
      };
    }
  }

  const gateway = toRecord(record.gateway);
  if (gateway) {
    const gatewayCost = parseFiniteNumber(gateway.cost) ?? parseFiniteNumber(gateway.marketCost);
    if (gatewayCost != null) {
      return {
        totalCostUsd: gatewayCost,
        costSource:
          parseFiniteNumber(gateway.cost) != null
            ? `${sourcePrefix}.gateway.cost`
            : `${sourcePrefix}.gateway.marketCost`,
      };
    }
  }

  for (const key of STRUCTURED_USD_KEYS) {
    const container = toRecord(record[key]);
    if (!container) {
      continue;
    }

    const candidate = extractStructuredUsdValue(container, `${sourcePrefix}.${key}`);
    if (candidate) {
      return candidate;
    }
  }

  for (const [key, nestedValue] of Object.entries(record)) {
    if (
      key !== 'gateway' &&
      !key.toLowerCase().includes('cost') &&
      !key.toLowerCase().includes('price') &&
      !key.toLowerCase().includes('billing')
    ) {
      continue;
    }

    const candidate = extractExplicitUsdCandidate(nestedValue, `${sourcePrefix}.${key}`, seen, depth + 1);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function extractSdkReportedTotalCostUsd({
  usage,
  providerMetadata,
}: {
  usage?: UsageLike;
  providerMetadata?: ProviderMetadataLike;
}): Pick<AgentRunUsageSummary, 'totalCostUsd' | 'costSource'> {
  const seen = new Set<unknown>();
  const fromRaw = extractExplicitUsdCandidate(usage?.raw, 'usage.raw', seen, 0);
  if (fromRaw) {
    return fromRaw;
  }

  const fromProviderMetadata = extractExplicitUsdCandidate(providerMetadata, 'providerMetadata', seen, 0);
  if (fromProviderMetadata) {
    return fromProviderMetadata;
  }

  return {};
}

export function normalizeSdkUsageSummary({
  usage,
  providerMetadata,
  steps,
  toolCalls,
  finishReason,
  rawFinishReason,
  warnings,
  response,
}: {
  usage?: UsageLike;
  providerMetadata?: ProviderMetadataLike;
  steps?: number;
  toolCalls?: number;
  finishReason?: string | null;
  rawFinishReason?: string | null;
  warnings?: unknown[] | null;
  response?: ResponseLike;
}): AgentRunUsageSummary {
  const usageRecord = usage ?? undefined;
  const reasoningTokens =
    parseFiniteNumber(usageRecord?.reasoningTokens) ??
    parseFiniteNumber(usageRecord?.outputTokenDetails?.reasoningTokens);
  const cacheReadInputTokens = parseFiniteNumber(usageRecord?.inputTokenDetails?.cacheReadTokens);
  const cacheCreationInputTokens = parseFiniteNumber(usageRecord?.inputTokenDetails?.cacheWriteTokens);
  const summary: AgentRunUsageSummary = {
    inputTokens: parseFiniteNumber(usageRecord?.inputTokens),
    outputTokens: parseFiniteNumber(usageRecord?.outputTokens),
    totalTokens: parseFiniteNumber(usageRecord?.totalTokens),
    reasoningTokens,
    cachedInputTokens: parseFiniteNumber(usageRecord?.cachedInputTokens) ?? cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    nonCachedInputTokens: parseFiniteNumber(usageRecord?.inputTokenDetails?.noCacheTokens),
    textOutputTokens: parseFiniteNumber(usageRecord?.outputTokenDetails?.textTokens),
    steps,
    toolCalls,
    finishReason: finishReason ?? undefined,
    rawFinishReason: rawFinishReason ?? undefined,
    warningCount: Array.isArray(warnings) ? warnings.length : undefined,
    responseId: typeof response?.id === 'string' && response.id.trim() ? response.id : undefined,
    responseModelId: typeof response?.modelId === 'string' && response.modelId.trim() ? response.modelId : undefined,
    responseTimestamp: toIsoTimestamp(response?.timestamp),
    providerMetadata: toRecord(providerMetadata),
    rawUsage: toRecord(usageRecord?.raw),
  };

  Object.assign(
    summary,
    extractSdkReportedTotalCostUsd({
      usage,
      providerMetadata,
    })
  );

  return summary;
}

export function sumSdkUsageSummaries(left: AgentRunUsageSummary, right: AgentRunUsageSummary): AgentRunUsageSummary {
  const sumField = (first: number | undefined, second: number | undefined): number | undefined => {
    if (first == null && second == null) {
      return undefined;
    }

    return (first ?? 0) + (second ?? 0);
  };

  return {
    inputTokens: sumField(left.inputTokens, right.inputTokens),
    outputTokens: sumField(left.outputTokens, right.outputTokens),
    totalTokens: sumField(left.totalTokens, right.totalTokens),
    reasoningTokens: sumField(left.reasoningTokens, right.reasoningTokens),
    cachedInputTokens: sumField(left.cachedInputTokens, right.cachedInputTokens),
    cacheCreationInputTokens: sumField(left.cacheCreationInputTokens, right.cacheCreationInputTokens),
    cacheReadInputTokens: sumField(left.cacheReadInputTokens, right.cacheReadInputTokens),
    nonCachedInputTokens: sumField(left.nonCachedInputTokens, right.nonCachedInputTokens),
    textOutputTokens: sumField(left.textOutputTokens, right.textOutputTokens),
    totalCostUsd: sumField(left.totalCostUsd, right.totalCostUsd),
    warningCount: sumField(left.warningCount, right.warningCount),
    steps: right.steps ?? left.steps,
    toolCalls: sumField(left.toolCalls, right.toolCalls),
    finishReason: right.finishReason ?? left.finishReason,
    rawFinishReason: right.rawFinishReason ?? left.rawFinishReason,
    responseId: right.responseId ?? left.responseId,
    responseModelId: right.responseModelId ?? left.responseModelId,
    responseTimestamp: right.responseTimestamp ?? left.responseTimestamp,
    costSource: right.costSource ?? left.costSource,
    providerMetadata: right.providerMetadata ?? left.providerMetadata,
    rawUsage: right.rawUsage ?? left.rawUsage,
  };
}

export class AgentRunObservabilityTracker {
  private summary: AgentRunUsageSummary = {};

  updateFromStep({
    usage,
    stepNumber,
    toolCalls,
  }: {
    usage?: UsageLike;
    stepNumber?: number;
    toolCalls?: unknown[];
  }): AgentRunUsageSummary {
    const stepSummary = normalizeSdkUsageSummary({
      usage,
      steps: stepNumber,
      toolCalls: Array.isArray(toolCalls) ? toolCalls.length : undefined,
    });

    this.summary = sumSdkUsageSummaries(this.summary, stepSummary);
    this.summary.steps = Math.max(this.summary.steps ?? 0, stepNumber ?? 0) || undefined;
    return this.summary;
  }

  finalize({
    usage,
    providerMetadata,
    steps,
    finishReason,
    rawFinishReason,
    warnings,
    response,
  }: {
    usage?: UsageLike;
    providerMetadata?: ProviderMetadataLike;
    steps?: Array<{ toolCalls?: unknown[] }> | null;
    finishReason?: string | null;
    rawFinishReason?: string | null;
    warnings?: unknown[] | null;
    response?: ResponseLike;
  }): AgentRunUsageSummary {
    const totalToolCalls = Array.isArray(steps)
      ? steps.reduce((count, step) => count + (Array.isArray(step?.toolCalls) ? step.toolCalls.length : 0), 0)
      : this.summary.toolCalls;
    const finalSummary = normalizeSdkUsageSummary({
      usage,
      providerMetadata,
      steps: Array.isArray(steps) ? steps.length : this.summary.steps,
      toolCalls: totalToolCalls,
      finishReason,
      rawFinishReason,
      warnings,
      response,
    });

    this.summary = {
      ...this.summary,
      ...finalSummary,
    };

    return this.summary;
  }

  getSummary(): AgentRunUsageSummary {
    return this.summary;
  }
}

export function buildMessageObservabilityMetadataPatch(summary: AgentRunUsageSummary): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (Object.keys(summary).length > 0) {
    metadata.usage = summary;
  }

  if (summary.finishReason) {
    metadata.finishReason = summary.finishReason;
  }
  if (summary.rawFinishReason) {
    metadata.rawFinishReason = summary.rawFinishReason;
  }
  if (summary.responseId) {
    metadata.responseId = summary.responseId;
  }
  if (summary.responseModelId) {
    metadata.responseModelId = summary.responseModelId;
    metadata.model = summary.responseModelId;
  }
  if (summary.responseTimestamp) {
    metadata.responseTimestamp = summary.responseTimestamp;
  }
  if (summary.warningCount != null) {
    metadata.warningCount = summary.warningCount;
  }
  if (summary.providerMetadata) {
    metadata.providerMetadata = summary.providerMetadata;
  }

  return metadata;
}
