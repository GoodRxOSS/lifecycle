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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import TelemetryService, { TelemetryStatsInterval, TelemetryStatsQuery } from 'server/services/telemetry';
import type { TelemetrySource } from 'server/models/TelemetryEvent';

export const runtime = 'nodejs';

const DEFAULT_RANGE_DAYS = 30;
const SOURCES: TelemetrySource[] = ['cli', 'ui'];
const INTERVALS: TelemetryStatsInterval[] = ['day', 'week'];

function parseDateParam(value: string | null, fallback: Date): Date | null {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseStatsQuery(searchParams: URLSearchParams): { query?: TelemetryStatsQuery; error?: string } {
  const source = searchParams.get('source') as TelemetrySource | null;
  if (!source || !SOURCES.includes(source)) {
    return { error: `source is required and must be one of: ${SOURCES.join(', ')}.` };
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);

  const to = parseDateParam(searchParams.get('to'), now);
  if (!to) {
    return { error: 'to must be a valid ISO date.' };
  }

  const from = parseDateParam(searchParams.get('from'), defaultFrom);
  if (!from) {
    return { error: 'from must be a valid ISO date.' };
  }

  if (from.getTime() > to.getTime()) {
    return { error: 'from must be earlier than or equal to to.' };
  }

  const interval = (searchParams.get('interval') || 'day') as TelemetryStatsInterval;
  if (!INTERVALS.includes(interval)) {
    return { error: `interval must be one of: ${INTERVALS.join(', ')}.` };
  }

  return { query: { source, from, to, interval } };
}

/**
 * @openapi
 * /api/v2/telemetry/stats:
 *   get:
 *     summary: Get telemetry statistics
 *     description: Returns aggregated telemetry statistics (usage over time, top events, active clients, versions, and platforms) for one source over the requested time range.
 *     tags:
 *       - Telemetry
 *     operationId: getTelemetryStats
 *     parameters:
 *       - name: source
 *         in: query
 *         required: true
 *         description: Which client type to aggregate.
 *         schema:
 *           type: string
 *           enum: [cli, ui]
 *       - name: from
 *         in: query
 *         required: false
 *         description: ISO date for the start of the range. Defaults to 30 days before now.
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: to
 *         in: query
 *         required: false
 *         description: ISO date for the end of the range. Defaults to now.
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: interval
 *         in: query
 *         required: false
 *         description: Bucket size for time series.
 *         schema:
 *           type: string
 *           enum: [day, week]
 *           default: day
 *     responses:
 *       '200':
 *         description: Aggregated telemetry statistics.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetTelemetryStatsSuccessResponse'
 *       '400':
 *         description: Invalid query parameters.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const { query, error } = parseStatsQuery(req.nextUrl.searchParams);
  if (!query) {
    return errorResponse(new Error(`Validation failed: ${error}`), { status: 400 }, req);
  }

  const service = new TelemetryService();
  const stats = await service.getStats(query);

  return successResponse(
    {
      range: {
        source: query.source,
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        interval: query.interval,
      },
      stats,
    },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler);
