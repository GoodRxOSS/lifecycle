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
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentRunEventService, {
  DEFAULT_RUN_EVENT_PAGE_LIMIT,
  MAX_RUN_EVENT_PAGE_LIMIT,
} from 'server/services/agent/RunEventService';
import AgentRunService from 'server/services/agent/RunService';

function parseNonNegativeInteger(value: string | null, fallback: number): number {
  if (value == null || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Expected a non-negative integer cursor.');
  }

  return parsed;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (value == null || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Expected a positive integer limit.');
  }

  return Math.min(parsed, MAX_RUN_EVENT_PAGE_LIMIT);
}

/**
 * @openapi
 * /api/v2/ai/agent/runs/{runId}/events:
 *   get:
 *     summary: Replay canonical events for an agent run
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentRunEvents
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: afterSequence
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Return events with sequence greater than this cursor.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 500
 *           default: 100
 *         description: Maximum events to return.
 *     responses:
 *       '200':
 *         description: Canonical run events
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       type: object
 *                       required: [run, events, pagination]
 *                       properties:
 *                         run:
 *                           type: object
 *                           required: [id, status]
 *                           properties:
 *                             id:
 *                               type: string
 *                             status:
 *                               $ref: '#/components/schemas/AgentRunStatus'
 *                         events:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/AgentRunEvent'
 *                         pagination:
 *                           type: object
 *                           required: [nextSequence, hasMore]
 *                           properties:
 *                             nextSequence:
 *                               type: integer
 *                             hasMore:
 *                               type: boolean
 *       '400':
 *         description: Invalid event cursor or page size.
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
 *       '404':
 *         description: Run not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { runId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  let afterSequence: number;
  let limit: number;
  try {
    afterSequence = parseNonNegativeInteger(req.nextUrl.searchParams.get('afterSequence'), 0);
    limit = parsePositiveInteger(req.nextUrl.searchParams.get('limit'), DEFAULT_RUN_EVENT_PAGE_LIMIT);
  } catch (error) {
    return errorResponse(error, { status: 400 }, req);
  }

  let run;
  try {
    run = await AgentRunService.getOwnedRun(params.runId, userIdentity.userId);
  } catch (error) {
    if (AgentRunService.isRunNotFoundError(error)) {
      return errorResponse(new Error('Agent run not found'), { status: 404 }, req);
    }

    throw error;
  }

  const page = await AgentRunEventService.listRunEventsPageForRun(run, {
    afterSequence,
    limit,
  });

  return successResponse(
    {
      run: page.run,
      events: page.events.map((event) => AgentRunEventService.serializeRunEvent(event)),
      pagination: {
        nextSequence: page.nextSequence,
        hasMore: page.hasMore,
      },
    },
    {
      status: 200,
      metadata: {
        limit: page.limit,
        maxLimit: page.maxLimit,
      },
    },
    req
  );
};

export const GET = createApiHandler(getHandler);
