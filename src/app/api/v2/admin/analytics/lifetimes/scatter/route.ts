/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at the following URL:
 * https://www.apache.org/licenses/LICENSE-2.0
 */

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, withNoStore } from 'server/lib/response';
import EnvironmentLifetimeAnalyticsService, {
  parseEnvironmentLifetimeScatterQuery,
} from 'server/services/analytics/EnvironmentLifetimeAnalyticsService';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/admin/analytics/lifetimes/scatter:
 *   get:
 *     summary: Get bounded recorded API lifetimes or PR lifetime estimates
 *     description: Administrator-only retained-record analytics. Points use retirement dates in the selected window. API durations use createdAt to deletedAt. Torn-down PR estimates use createdAt to updatedAt and can include inactive gaps or later edits. Up to 5000 valid points are returned in full. Above that limit, no points are returned and the scope must be narrowed. Previous-period points are not returned.
 *     tags: [Admin Analytics]
 *     operationId: getEnvironmentLifetimeScatter
 *     parameters:
 *       - { in: query, name: repositoryId, schema: { type: integer, minimum: 1 }, description: Stable installation-aware repository row ID. }
 *       - { in: query, name: unattributed, schema: { type: boolean, default: false }, description: Mutually exclusive with repositoryId. }
 *       - { in: query, name: organization, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: environmentType, schema: { type: string, enum: [all, ephemeral, static], default: all } }
 *       - { in: query, name: environmentAuthor, schema: { type: string, maxLength: 128 } }
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Inclusive retirement calendar date. Defaults to 30 complete days before to. }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Exclusive retirement calendar date. Defaults to today in timezone. }
 *       - { in: query, name: timezone, schema: { type: string, default: UTC }, description: IANA timezone for retirement boundaries. }
 *       - { in: query, name: group, schema: { type: string, enum: [all, api, pr], default: all }, description: API recorded durations and PR estimates retain separate methods. }
 *       - { in: query, name: compare, schema: { type: boolean, default: false }, description: Accepted for shared-filter compatibility. Scatter always resolves compare false and returns selected-window points only. }
 *       - { in: query, name: interval, schema: { type: string, enum: [day, week], default: day }, description: Retained in range metadata. Points are individual environments and are not bucketed. }
 *     responses:
 *       '200': { description: 'Complete bounded scatter data or an explicit over-limit result.', content: { application/json: { schema: { $ref: '#/components/schemas/GetEnvironmentLifetimeScatterSuccessResponse' } } } }
 *       '400': { description: Invalid query, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '401': { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '403': { description: Administrator role required, content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 *       '503': { description: 'Analytics request did not complete before the time limit. Error code: analytics_timeout.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } } }
 */
const getHandler = async (req: NextRequest) => {
  const query = parseEnvironmentLifetimeScatterQuery(req.nextUrl.searchParams);
  const result = await new EnvironmentLifetimeAnalyticsService().getScatter(query);
  return withNoStore(successResponse(result, { status: 200 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
