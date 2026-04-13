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
import AgentSessionService from 'server/services/agentSession';
import { loadAgentSessionServiceCandidates } from 'server/services/agentSessionCandidates';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/agent/session-candidates:
 *   get:
 *     summary: List dev-mode service candidates for an environment-backed agent session
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentSessionCandidates
 *     parameters:
 *       - in: query
 *         name: buildUuid
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Candidate services returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: object
 *                   required:
 *                     - services
 *                     - activeSession
 *                   properties:
 *                     services:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required:
 *                           - name
 *                           - type
 *                         properties:
 *                           name:
 *                             type: string
 *                           type:
 *                             type: string
 *                           detail:
 *                             type: string
 *                           repo:
 *                             type: string
 *                           branch:
 *                             type: string
 *                           revision:
 *                             type: string
 *                             nullable: true
 *                     activeSession:
 *                       type: object
 *                       nullable: true
 *                       required:
 *                         - id
 *                         - status
 *                         - ownerGithubUsername
 *                         - ownedByCurrentUser
 *                       properties:
 *                         id:
 *                           type: string
 *                           nullable: true
 *                         status:
 *                           type: string
 *                           enum: [starting, active]
 *                         ownerGithubUsername:
 *                           type: string
 *                           nullable: true
 *                         ownedByCurrentUser:
 *                           type: boolean
 *                 error:
 *                   nullable: true
 *       '400':
 *         description: Invalid request
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Build or lifecycle config not found
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const { searchParams } = new URL(req.url);
  const buildUuid = searchParams.get('buildUuid');
  if (!buildUuid) {
    return errorResponse(new Error('buildUuid is required'), { status: 400 }, req);
  }

  try {
    const [services, activeSession] = await Promise.all([
      loadAgentSessionServiceCandidates(buildUuid),
      AgentSessionService.getEnvironmentActiveSession(buildUuid, userIdentity.userId),
    ]);

    return successResponse(
      {
        services: services
          .map(({ name, type, detail, repo, branch, revision }) => ({ name, type, detail, repo, branch, revision }))
          .sort((a, b) =>
            a.name === b.name
              ? `${a.repo}:${a.branch}`.localeCompare(`${b.repo}:${b.branch}`)
              : a.name.localeCompare(b.name)
          ),
        activeSession,
      },
      { status: 200 },
      req
    );
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return errorResponse(err, { status: 404 }, req);
    }

    return errorResponse(err, { status: 400 }, req);
  }
};

export const GET = createApiHandler(getHandler);
