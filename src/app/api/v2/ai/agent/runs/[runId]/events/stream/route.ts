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
import { errorResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentRunEventService from 'server/services/agent/RunEventService';
import AgentRunService from 'server/services/agent/RunService';

function parseAfterSequence(req: NextRequest): number {
  const rawValue = req.headers.get('last-event-id') || req.nextUrl.searchParams.get('afterSequence');
  if (rawValue == null || rawValue.trim() === '') {
    return 0;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Expected a non-negative integer cursor.');
  }

  return parsed;
}

/**
 * @openapi
 * /api/v2/ai/agent/runs/{runId}/events/stream:
 *   get:
 *     summary: Stream canonical events for an agent run
 *     tags:
 *       - Agent Sessions
 *     operationId: streamAgentRunEvents
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
 *         description: Replay events with sequence greater than this cursor before following live events.
 *       - in: header
 *         name: Last-Event-ID
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Browser SSE resume cursor. Takes precedence over afterSequence.
 *     responses:
 *       '200':
 *         description: Canonical run event stream.
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       '400':
 *         description: Invalid event cursor.
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
const getHandler = async (req: NextRequest, { params }: { params: { runId: string } }): Promise<Response> => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  let afterSequence: number;
  try {
    afterSequence = parseAfterSequence(req);
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

  return new Response(AgentRunEventService.createCanonicalRunEventStream(run.uuid, afterSequence), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
};

export const GET = getHandler;
