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
  AgentSessionWorkspaceStorageConfigError,
  resolveAgentSessionRuntimeConfig,
  resolveAgentSessionWorkspaceStorageIntent,
} from 'server/lib/agentSession/runtimeConfig';
import { encrypt } from 'server/lib/encryption';
import { redisClient } from 'server/lib/dependencies';
import QueueManager from 'server/lib/queueManager';
import { QUEUE_NAMES } from 'shared/config';
import { setSandboxLaunchState, toPublicSandboxLaunchState } from 'server/lib/agentSession/sandboxLaunchState';
import AgentSandboxSessionService, {
  formatRequestedSandboxServicesLabel,
  summarizeRequestedSandboxServices,
  type RequestedSandboxService,
  type RequestedSandboxServices,
} from 'server/services/agentSandboxSession';
import type { SandboxSessionLaunchJob } from 'server/jobs/agentSandboxSessionLaunch';
import type { RequestedAgentSessionServiceRef } from 'server/services/agentSessionCandidates';

interface CreateSandboxSessionBody {
  baseBuildUuid?: string;
  service?: unknown;
  services?: unknown;
  model?: string;
  workspace?: {
    storageSize?: string;
  };
}

function isRequestedSandboxServiceRef(value: unknown): value is RequestedAgentSessionServiceRef {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as RequestedAgentSessionServiceRef).name === 'string' &&
    ((value as RequestedAgentSessionServiceRef).repo == null ||
      typeof (value as RequestedAgentSessionServiceRef).repo === 'string') &&
    ((value as RequestedAgentSessionServiceRef).branch == null ||
      typeof (value as RequestedAgentSessionServiceRef).branch === 'string')
  );
}

function parseRequestedSandboxService(value: unknown): RequestedSandboxService {
  if (typeof value === 'string') {
    return value;
  }

  if (isRequestedSandboxServiceRef(value)) {
    return value;
  }

  throw new Error('service must be a service name or repo-qualified service reference');
}

function parseRequestedSandboxServices(value: unknown): RequestedSandboxServices {
  if (!Array.isArray(value)) {
    throw new Error('services must be an array of service names or repo-qualified service references');
  }

  if (value.length === 0) {
    throw new Error('services must contain at least one service');
  }

  return value.map(parseRequestedSandboxService);
}

function parseRequestedSandboxServicesFromBody(body: CreateSandboxSessionBody): RequestedSandboxServices {
  if (body.services != null) {
    if (body.service != null) {
      throw new Error('Provide either service or services, not both');
    }

    return parseRequestedSandboxServices(body.services);
  }

  if (body.service != null) {
    return [parseRequestedSandboxService(body.service)];
  }

  throw new Error('service or services is required');
}

function parseRequestedWorkspaceStorageSize(body: CreateSandboxSessionBody): string | undefined {
  const workspace = body.workspace;
  if (workspace === undefined) {
    return undefined;
  }

  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new Error('workspace must be an object');
  }

  if (workspace.storageSize === undefined) {
    return undefined;
  }

  if (typeof workspace.storageSize !== 'string' || !workspace.storageSize.trim()) {
    throw new Error('workspace.storageSize must be a non-empty string');
  }

  return workspace.storageSize.trim();
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
 *                           repo:
 *                             type: string
 *                           branch:
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
 *             oneOf:
 *               - type: object
 *                 required:
 *                   - baseBuildUuid
 *                   - service
 *                 properties:
 *                   baseBuildUuid:
 *                     type: string
 *                   service:
 *                     oneOf:
 *                       - type: string
 *                       - type: object
 *                         required:
 *                           - name
 *                         properties:
 *                           name:
 *                             type: string
 *                           repo:
 *                             type: string
 *                           branch:
 *                             type: string
 *                   model:
 *                     type: string
 *                   workspace:
 *                     type: object
 *                     properties:
 *                       storageSize:
 *                         type: string
 *                         description: Optional workspace PVC size. Accepted only when admin runtime settings allow client overrides.
 *               - type: object
 *                 required:
 *                   - baseBuildUuid
 *                   - services
 *                 properties:
 *                   baseBuildUuid:
 *                     type: string
 *                   services:
 *                     type: array
 *                     minItems: 1
 *                     items:
 *                       oneOf:
 *                         - type: string
 *                         - type: object
 *                           required:
 *                             - name
 *                           properties:
 *                             name:
 *                               type: string
 *                             repo:
 *                               type: string
 *                             branch:
 *                               type: string
 *                   model:
 *                     type: string
 *                   workspace:
 *                     type: object
 *                     properties:
 *                       storageSize:
 *                         type: string
 *                         description: Optional workspace PVC size. Accepted only when admin runtime settings allow client overrides.
 *     responses:
 *       '200':
 *         description: Sandbox session launch queued
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
 *                         - opening_session
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
    const requestedServices = parseRequestedSandboxServicesFromBody(body);
    const requestedWorkspaceStorageSize = parseRequestedWorkspaceStorageSize(body);
    const requestedServiceSummary = summarizeRequestedSandboxServices(requestedServices);
    const requestedServiceLabel = formatRequestedSandboxServicesLabel(requestedServices);
    const runtimeConfig = await resolveAgentSessionRuntimeConfig();
    const workspaceStorage = resolveAgentSessionWorkspaceStorageIntent({
      requestedSize: requestedWorkspaceStorageSize,
      storage: runtimeConfig.workspaceStorage,
    });
    const githubToken = await resolveRequestGitHubToken(req);
    const launchId = uuid();
    const now = new Date().toISOString();
    await setSandboxLaunchState(redisClient.getRedis(), {
      launchId,
      userId: userIdentity.userId,
      status: 'queued',
      stage: 'queued',
      message: `Queued sandbox launch for ${requestedServiceLabel}`,
      createdAt: now,
      updatedAt: now,
      baseBuildUuid: body.baseBuildUuid,
      service: requestedServiceSummary,
      buildUuid: null,
      namespace: null,
      sessionId: null,
      focusUrl: null,
      error: null,
    });

    await sandboxLaunchQueue.add(
      'launch',
      {
        launchId,
        userId: userIdentity.userId,
        userIdentity,
        encryptedGithubToken: githubToken ? encrypt(githubToken) : null,
        baseBuildUuid: body.baseBuildUuid,
        services: requestedServices,
        model: body.model,
        workspaceImage: runtimeConfig.workspaceImage,
        workspaceEditorImage: runtimeConfig.workspaceEditorImage,
        workspaceGatewayImage: runtimeConfig.workspaceGatewayImage,
        nodeSelector: runtimeConfig.nodeSelector,
        keepAttachedServicesOnSessionNode: runtimeConfig.keepAttachedServicesOnSessionNode,
        readiness: runtimeConfig.readiness,
        resources: runtimeConfig.resources,
        workspaceStorage,
        redisTtlSeconds: runtimeConfig.cleanup.redisTtlSeconds,
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
        message: `Queued sandbox launch for ${requestedServiceLabel}`,
        createdAt: now,
        updatedAt: now,
        baseBuildUuid: body.baseBuildUuid,
        service: requestedServiceSummary,
        buildUuid: null,
        namespace: null,
        sessionId: null,
        focusUrl: null,
        error: null,
      }),
      { status: 200 },
      req
    );
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return errorResponse(err, { status: 404 }, req);
    }

    if (err instanceof AgentSessionRuntimeConfigError) {
      return errorResponse(err, { status: 503 }, req);
    }

    if (err instanceof AgentSessionWorkspaceStorageConfigError) {
      return errorResponse(err, { status: 400 }, req);
    }

    return errorResponse(err, { status: 400 }, req);
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
