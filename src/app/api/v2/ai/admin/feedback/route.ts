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

import type { Knex } from 'knex';
import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { defaultDb } from 'server/lib/dependencies';
import { successResponse } from 'server/lib/response';

interface FeedbackEntry {
  id: string;
  feedbackType: 'message' | 'conversation';
  buildUuid: string;
  rating: 'up' | 'down';
  text: string | null;
  userIdentifier: string | null;
  repo: string;
  prNumber: number | null;
  messageId: number | null;
  messagePreview: string | null;
  costUsd: number | null;
  createdAt: string;
}

interface FeedbackQueryRow {
  id: string;
  feedbackType: 'message' | 'conversation';
  buildUuid: string;
  rating: 'up' | 'down';
  text: string | null;
  userIdentifier: string | null;
  repo: string;
  prNumber: number | null;
  messageId: number | null;
  messagePreview: string | null;
  createdAt: string;
  messageContent?: string | null;
  messageMetadata?: unknown;
}

interface FeedbackFilters {
  repo?: string;
  rating?: string;
  from?: string;
  to?: string;
  sortBy?: 'createdAt';
  sortDirection?: 'asc' | 'desc';
}

const PREVIEW_MAX_LENGTH = 140;

interface DebugMetricsPayload {
  inputTokens?: unknown;
  outputTokens?: unknown;
  inputCostPerMillion?: unknown;
  outputCostPerMillion?: unknown;
}

interface ConversationMessageCostRow {
  buildUuid: string;
  metadata: unknown;
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncatePreview(value: string): string {
  const graphemes = Array.from(value);
  if (graphemes.length <= PREVIEW_MAX_LENGTH) {
    return value;
  }
  return graphemes.slice(0, PREVIEW_MAX_LENGTH - 1).join('') + '…';
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractDebugMetrics(metadata: unknown): DebugMetricsPayload | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const candidate = (metadata as Record<string, unknown>).debugMetrics;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  return candidate as DebugMetricsPayload;
}

function computeCostFromDebugMetrics(debugMetrics: DebugMetricsPayload | null): number | null {
  if (!debugMetrics) {
    return null;
  }

  const inputTokens = parseFiniteNumber(debugMetrics.inputTokens);
  const outputTokens = parseFiniteNumber(debugMetrics.outputTokens);
  const inputCostPerMillion = parseFiniteNumber(debugMetrics.inputCostPerMillion);
  const outputCostPerMillion = parseFiniteNumber(debugMetrics.outputCostPerMillion);

  let totalCost = 0;
  let hasCost = false;

  if (inputTokens != null && inputCostPerMillion != null) {
    totalCost += (inputTokens / 1_000_000) * inputCostPerMillion;
    hasCost = true;
  }

  if (outputTokens != null && outputCostPerMillion != null) {
    totalCost += (outputTokens / 1_000_000) * outputCostPerMillion;
    hasCost = true;
  }

  return hasCost ? totalCost : null;
}

function computeMessageCost(metadata: unknown): number | null {
  return computeCostFromDebugMetrics(extractDebugMetrics(metadata));
}

async function computeSessionCostByBuildUuid(db: Knex, buildUuids: string[]): Promise<Map<string, number | null>> {
  const uniqueBuildUuids = [...new Set(buildUuids.filter(Boolean))];
  const costByBuildUuid = new Map<string, number | null>();
  if (uniqueBuildUuids.length === 0) {
    return costByBuildUuid;
  }

  const rows = (await db('conversation_messages as cm')
    .select({
      buildUuid: 'cm.buildUuid',
      metadata: 'cm.metadata',
    })
    .whereIn('cm.buildUuid', uniqueBuildUuids)) as ConversationMessageCostRow[];

  const rollingCost = new Map<string, number>();
  const hasCost = new Set<string>();

  for (const row of rows) {
    const messageCost = computeMessageCost(row.metadata);
    if (messageCost == null) {
      continue;
    }
    rollingCost.set(row.buildUuid, (rollingCost.get(row.buildUuid) || 0) + messageCost);
    hasCost.add(row.buildUuid);
  }

  for (const buildUuid of uniqueBuildUuids) {
    costByBuildUuid.set(buildUuid, hasCost.has(buildUuid) ? rollingCost.get(buildUuid) || 0 : null);
  }

  return costByBuildUuid;
}

function extractSummaryFromStructuredContent(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      summary?: string;
      services?: Array<{
        serviceName?: string;
        issue?: string;
        rootCause?: string;
        suggestedFix?: string;
      }>;
    };

    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      return parsed.summary;
    }

    const firstService = parsed.services?.[0];
    if (firstService) {
      const detail = firstService.issue || firstService.rootCause || firstService.suggestedFix;
      if (detail && firstService.serviceName) {
        return `${firstService.serviceName}: ${detail}`;
      }
      if (detail) {
        return detail;
      }
    }
  } catch {
    const regexMatch = trimmed.match(/"summary"\s*:\s*"([^"]+)"/);
    if (regexMatch?.[1]) {
      return regexMatch[1];
    }
  }

  return null;
}

function buildPreview(row: FeedbackQueryRow): string | null {
  if (row.feedbackType === 'conversation') {
    return row.text ? truncatePreview(toSingleLine(row.text)) : null;
  }

  const source = row.messageContent || row.messagePreview || row.text;
  if (!source) {
    return null;
  }

  const structuredSummary = extractSummaryFromStructuredContent(source);
  if (structuredSummary) {
    return truncatePreview(toSingleLine(structuredSummary));
  }

  return truncatePreview(toSingleLine(source));
}

function applyFilters(query: Knex.QueryBuilder, tableAlias: string, filters: FeedbackFilters) {
  if (filters.repo) {
    const search = `%${filters.repo.trim()}%`;
    query.where((builder) => {
      builder.whereILike(`${tableAlias}.repo`, search).orWhereILike(`${tableAlias}.buildUuid`, search);
    });
  }
  if (filters.rating) {
    query.where(`${tableAlias}.rating`, filters.rating);
  }
  if (filters.from) {
    query.where(`${tableAlias}.createdAt`, '>=', filters.from);
  }
  if (filters.to) {
    query.where(`${tableAlias}.createdAt`, '<=', filters.to);
  }
}

function buildMessageFeedbackQuery(db: Knex, filters: FeedbackFilters): Knex.QueryBuilder {
  const query = db('message_feedback as mf')
    .leftJoin('conversation_messages as cm', 'mf.messageId', 'cm.id')
    .select({
      buildUuid: 'mf.buildUuid',
      rating: 'mf.rating',
      text: 'mf.text',
      userIdentifier: 'mf.userIdentifier',
      repo: 'mf.repo',
      prNumber: 'mf.prNumber',
      messageId: 'mf.messageId',
      createdAt: 'mf.createdAt',
    })
    .select(db.raw("concat('message-', ??) as ??", ['mf.id', 'id']))
    .select(db.raw("'message' as ??", ['feedbackType']))
    .select(db.raw('NULL::text as ??', ['messagePreview']))
    .select({ messageContent: 'cm.content' })
    .select({ messageMetadata: 'cm.metadata' });

  applyFilters(query, 'mf', filters);
  return query;
}

function buildConversationFeedbackQuery(db: Knex, filters: FeedbackFilters): Knex.QueryBuilder {
  const query = db('conversation_feedback as cf')
    .select({
      buildUuid: 'cf.buildUuid',
      rating: 'cf.rating',
      text: 'cf.text',
      userIdentifier: 'cf.userIdentifier',
      repo: 'cf.repo',
      prNumber: 'cf.prNumber',
    })
    .select(db.raw('NULL::integer as ??', ['messageId']))
    .select({ createdAt: 'cf.createdAt' })
    .select(db.raw("concat('conversation-', ??) as ??", ['cf.id', 'id']))
    .select(db.raw("'conversation' as ??", ['feedbackType']))
    .select(db.raw('NULL::text as ??', ['messagePreview']))
    .select(db.raw('NULL::text as ??', ['messageContent']))
    .select(db.raw('NULL::jsonb as ??', ['messageMetadata']));

  applyFilters(query, 'cf', filters);
  return query;
}

function buildUnifiedFeedbackQuery(db: Knex, filters: FeedbackFilters, type?: string): Knex.QueryBuilder | null {
  const queries: Knex.QueryBuilder[] = [];

  if (!type || type === 'message') {
    queries.push(buildMessageFeedbackQuery(db, filters));
  }
  if (!type || type === 'conversation') {
    queries.push(buildConversationFeedbackQuery(db, filters));
  }

  if (queries.length === 0) {
    return null;
  }

  if (queries.length === 1) {
    return queries[0];
  }

  return db.queryBuilder().unionAll(queries, true);
}

const getHandler = async (req: NextRequest) => {
  const searchParams = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.max(1, parseInt(searchParams.get('limit') || '25', 10));
  const repo = searchParams.get('repo') || undefined;
  const rating = searchParams.get('rating') || undefined;
  const type = searchParams.get('type') || undefined;
  const from = searchParams.get('from') || undefined;
  const to = searchParams.get('to') || undefined;
  const sortBy = searchParams.get('sortBy');
  const sortDirection = searchParams.get('sortDirection');
  const normalizedSortBy: FeedbackFilters['sortBy'] = sortBy === 'createdAt' ? 'createdAt' : 'createdAt';
  const normalizedSortDirection: FeedbackFilters['sortDirection'] = sortDirection === 'asc' ? 'asc' : 'desc';
  const filters: FeedbackFilters = {
    repo,
    rating,
    from,
    to,
    sortBy: normalizedSortBy,
    sortDirection: normalizedSortDirection,
  };

  const db = defaultDb.knex;
  const unifiedQuery = buildUnifiedFeedbackQuery(db, filters, type);

  let data: FeedbackEntry[] = [];
  let totalCount = 0;

  if (unifiedQuery) {
    const countResult = await db
      .from(unifiedQuery.clone().as('feedback'))
      .count<{ count: string }>('* as count')
      .first();
    totalCount = Number(countResult?.count || 0);

    const offset = (page - 1) * limit;
    const rows = (await db
      .from(unifiedQuery.as('feedback'))
      .select('*')
      .orderBy(filters.sortBy || 'createdAt', filters.sortDirection || 'desc')
      .offset(offset)
      .limit(limit)) as FeedbackQueryRow[];
    const conversationBuildUuids = rows
      .filter((row) => row.feedbackType === 'conversation')
      .map((row) => row.buildUuid);
    const sessionCostByBuildUuid = await computeSessionCostByBuildUuid(db, conversationBuildUuids);

    data = rows.map((row) => ({
      id: row.id,
      feedbackType: row.feedbackType,
      buildUuid: row.buildUuid,
      rating: row.rating,
      text: row.text,
      userIdentifier: row.userIdentifier,
      repo: row.repo,
      prNumber: row.prNumber,
      messageId: row.messageId,
      messagePreview: buildPreview(row),
      costUsd:
        row.feedbackType === 'message'
          ? computeMessageCost(row.messageMetadata)
          : sessionCostByBuildUuid.get(row.buildUuid) ?? null,
      createdAt: row.createdAt,
    }));
  }

  const totalPages = Math.ceil(totalCount / limit);

  return successResponse(
    data,
    {
      status: 200,
      metadata: {
        pagination: {
          page,
          totalPages,
          totalCount,
          limit,
        },
      },
    },
    req
  );
};

export const GET = createApiHandler(getHandler);
