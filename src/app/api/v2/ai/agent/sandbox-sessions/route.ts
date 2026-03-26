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
import { v4 as uuid } from 'uuid';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubToken } from 'server/lib/agentSession/githubToken';
import {
  AgentSessionRuntimeConfigError,
  resolveAgentSessionRuntimeConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { encrypt } from 'server/lib/encryption';
import { redisClient } from 'server/lib/dependencies';
import QueueManager from 'server/lib/queueManager';
import { QUEUE_NAMES } from 'shared/config';
import { setSandboxLaunchState, toPublicSandboxLaunchState } from 'server/lib/agentSession/sandboxLaunchState';
import AgentSandboxSessionService from 'server/services/agentSandboxSession';
import type { SandboxSessionLaunchJob } from 'server/jobs/agentSandboxSessionLaunch';

interface CreateSandboxSessionBody {
  baseBuildUuid?: string;
  service?: string;
  model?: string;
}

const sandboxLaunchQueue = QueueManager.getInstance().registerQueue(QUEUE_NAMES.AGENT_SANDBOX_SESSION_LAUNCH, {
  connection: redisClient.getConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  },
});

/**
 * @openapi
 * /api/v2/ai/agent/sandbox-sessions:
 *   get:
 *     summary: List sandboxable services for a base environment build
 *     tags:
 *       - Agent Sessions
 *     operationId: getSandboxServiceCandidates
 *     parameters:
 *       - in: query
 *         name: baseBuildUuid
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Sandboxable services returned
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
 *                     - status
 *                     - services
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [needs_service_selection]
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
 *                 error:
 *                   nullable: true
 *       '400':
 *         description: Invalid request
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Base build or lifecycle config not found
 *   post:
 *     summary: Launch an isolated sandbox-backed agent session from an existing build snapshot
 *     tags:
 *       - Agent Sessions
 *     operationId: createSandboxAgentSession
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - baseBuildUuid
 *             properties:
 *               baseBuildUuid:
 *                 type: string
 *               service:
 *                 type: string
 *               model:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Service selection required or sandbox session launch queued
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
 *                     - launchId
 *                     - status
 *                     - stage
 *                     - message
 *                     - createdAt
 *                     - updatedAt
 *                     - baseBuildUuid
 *                     - service
 *                     - buildUuid
 *                     - namespace
 *                     - sessionId
 *                     - focusUrl
 *                     - error
 *                   properties:
 *                     launchId:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [queued, running, created, error]
 *                     stage:
 *                       type: string
 *                       enum:
 *                         - queued
 *                         - resolving_base_build
 *                         - resolving_services
 *                         - creating_sandbox_build
 *                         - resolving_environment
 *                         - deploying_resources
 *                         - creating_agent_session
 *                         - ready
 *                         - error
 *                     message:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                     baseBuildUuid:
 *                       type: string
 *                     service:
 *                       type: string
 *                     buildUuid:
 *                       type: string
 *                       nullable: true
 *                     namespace:
 *                       type: string
 *                       nullable: true
 *                     sessionId:
 *                       type: string
 *                       nullable: true
 *                     focusUrl:
 *                       type: string
 *                       nullable: true
 *                     error:
 *                       type: string
 *                       nullable: true
 *                 error:
 *                   nullable: true
 *       '400':
 *         description: Invalid request
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Base build not found
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const { searchParams } = new URL(req.url);
  const baseBuildUuid = searchParams.get('baseBuildUuid');

  if (!baseBuildUuid) {
    return errorResponse(new Error('baseBuildUuid is required'), { status: 400 }, req);
  }

  try {
    const services = await new AgentSandboxSessionService().getServiceCandidates({
      baseBuildUuid,
    });

    return successResponse(
      {
        status: 'needs_service_selection',
        services,
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

const postHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const body = (await req.json()) as CreateSandboxSessionBody;
  if (!body.baseBuildUuid) {
    return errorResponse(new Error('baseBuildUuid is required'), { status: 400 }, req);
  }

  try {
    if (!body.service) {
      return errorResponse(new Error('service is required'), { status: 400 }, req);
    }

    const runtimeConfig = await resolveAgentSessionRuntimeConfig();
    const githubToken = await resolveRequestGitHubToken(req);
    const launchId = uuid();
    const now = new Date().toISOString();
    await setSandboxLaunchState(redisClient.getRedis(), {
      launchId,
      userId: userIdentity.userId,
      status: 'queued',
      stage: 'queued',
      message: `Queued sandbox launch for ${body.service}`,
      createdAt: now,
      updatedAt: now,
      baseBuildUuid: body.baseBuildUuid,
      service: body.service,
    });

    await sandboxLaunchQueue.add(
      'launch',
      {
        launchId,
        userId: userIdentity.userId,
        userIdentity,
        encryptedGithubToken: githubToken ? encrypt(githubToken) : null,
        baseBuildUuid: body.baseBuildUuid,
        service: body.service,
        model: body.model,
        agentImage: runtimeConfig.image,
        editorImage: runtimeConfig.editorImage,
        nodeSelector: runtimeConfig.nodeSelector,
        readiness: runtimeConfig.readiness,
        resources: runtimeConfig.resources,
      } as SandboxSessionLaunchJob,
      {
        jobId: launchId,
      }
    );

    return successResponse(
      toPublicSandboxLaunchState({
        launchId,
        userId: userIdentity.userId,
        status: 'queued',
        stage: 'queued',
        message: `Queued sandbox launch for ${body.service}`,
        createdAt: now,
        updatedAt: now,
        baseBuildUuid: body.baseBuildUuid,
        service: body.service,
      }),
      { status: 200 },
      req
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'API_KEY_REQUIRED') {
      return errorResponse(
        new Error('An Anthropic API key is required. Please add one in settings.'),
        { status: 400 },
        req
      );
    }

    if (err instanceof Error && /not found/i.test(err.message)) {
      return errorResponse(err, { status: 404 }, req);
    }

    if (err instanceof AgentSessionRuntimeConfigError) {
      return errorResponse(err, { status: 503 }, req);
    }

    return errorResponse(err, { status: 400 }, req);
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
