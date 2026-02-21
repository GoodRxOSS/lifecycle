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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, errorResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubToken } from 'server/lib/agentSession/githubToken';
import {
  AgentSessionRuntimeConfigError,
  resolveAgentSessionRuntimeConfig,
} from 'server/lib/agentSession/runtimeConfig';
import AgentSessionService, { ActiveEnvironmentSessionError } from 'server/services/agentSession';
import {
  loadAgentSessionServiceCandidates,
  resolveRequestedAgentSessionServices,
} from 'server/services/agentSessionCandidates';
import Build from 'server/models/Build';
import type { DevConfig } from 'server/models/yaml/YamlService';
import { BuildKind } from 'shared/constants';

interface ResolvedSessionService {
  name: string;
  deployId: number;
  devConfig: DevConfig;
  resourceName?: string;
}

interface CreateSessionBody {
  buildUuid?: string;
  services?: unknown[];
  model?: string;
  repoUrl?: string;
  branch?: string;
  prNumber?: number;
  namespace?: string;
}

function repoNameFromRepoUrl(repoUrl?: string | null) {
  if (!repoUrl) {
    return null;
  }

  const normalized = repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  return normalized || null;
}

function serializeSessionSummary<T extends { id: string | number; uuid?: string | null }>(session: T) {
  const sessionId = session.uuid || String(session.id);
  const {
    id: _internalId,
    uuid: _uuid,
    ...serialized
  } = session as T & {
    uuid?: string | null;
    id: string | number;
  };

  return {
    ...serialized,
    id: sessionId,
    websocketUrl: `/api/agent/session?sessionId=${sessionId}`,
    editorUrl: `/api/agent/editor/${sessionId}/`,
  };
}

function isResolvedSessionService(value: unknown): value is ResolvedSessionService {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as ResolvedSessionService).name === 'string' &&
    typeof (value as ResolvedSessionService).deployId === 'number' &&
    (value as ResolvedSessionService).devConfig != null
  );
}

async function resolveBuildContext(buildUuid: string) {
  return Build.query().findOne({ uuid: buildUuid }).withGraphFetched('[pullRequest, deploys.[deployable]]');
}

async function resolveRequestedServices(
  buildUuid: string | undefined,
  requestedServices: unknown[] | undefined
): Promise<ResolvedSessionService[]> {
  if (!Array.isArray(requestedServices) || requestedServices.length === 0) {
    return [];
  }

  if (requestedServices.every(isResolvedSessionService)) {
    return requestedServices;
  }

  if (!buildUuid) {
    throw new Error('buildUuid is required when services are specified');
  }

  const requestedNames = requestedServices.filter((service): service is string => typeof service === 'string');
  if (requestedNames.length !== requestedServices.length) {
    throw new Error('services must be an array of service names');
  }

  return resolveRequestedAgentSessionServices(await loadAgentSessionServiceCandidates(buildUuid), requestedNames).map(
    ({ name, deployId, devConfig, baseDeploy }) => ({
      name,
      deployId,
      devConfig,
      resourceName: baseDeploy.uuid || undefined,
    })
  );
}

/**
 * @openapi
 * /api/v2/ai/agent/sessions:
 *   get:
 *     summary: List agent sessions for the authenticated user
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentSessions
 *     parameters:
 *       - in: query
 *         name: includeEnded
 *         schema:
 *           type: boolean
 *         description: When true, include ended and errored sessions in the response.
 *     responses:
 *       '200':
 *         description: Agent sessions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required:
 *                       - id
 *                       - buildUuid
 *                       - baseBuildUuid
 *                       - buildKind
 *                       - userId
 *                       - ownerGithubUsername
 *                       - podName
 *                       - namespace
 *                       - model
 *                       - status
 *                       - repo
 *                       - branch
 *                       - services
 *                       - lastActivity
 *                       - createdAt
 *                       - updatedAt
 *                       - endedAt
 *                       - websocketUrl
 *                       - editorUrl
 *                     properties:
 *                       id:
 *                         type: string
 *                       buildUuid:
 *                         type: string
 *                         nullable: true
 *                       baseBuildUuid:
 *                         type: string
 *                         nullable: true
 *                       buildKind:
 *                         $ref: '#/components/schemas/BuildKind'
 *                       userId:
 *                         type: string
 *                       ownerGithubUsername:
 *                         type: string
 *                         nullable: true
 *                       podName:
 *                         type: string
 *                       namespace:
 *                         type: string
 *                       model:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [starting, active, ended, error]
 *                       repo:
 *                         type: string
 *                         nullable: true
 *                       branch:
 *                         type: string
 *                         nullable: true
 *                       services:
 *                         type: array
 *                         items:
 *                           type: string
 *                       lastActivity:
 *                         type: string
 *                         format: date-time
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                       endedAt:
 *                         type: string
 *                         nullable: true
 *                         format: date-time
 *                       websocketUrl:
 *                         type: string
 *                       editorUrl:
 *                         type: string
 *                 error:
 *                   nullable: true
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Create a new interactive agent session
 *     tags:
 *       - Agent Sessions
 *     operationId: createAgentSession
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - buildUuid
 *             properties:
 *               buildUuid:
 *                 type: string
 *               services:
 *                 type: array
 *                 description: Optional service names to enable dev mode for.
 *                 items:
 *                   type: string
 *               model:
 *                 type: string
 *     responses:
 *       '201':
 *         description: Agent session created
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
 *                     - id
 *                     - buildUuid
 *                     - baseBuildUuid
 *                     - buildKind
 *                     - userId
 *                     - ownerGithubUsername
 *                     - podName
 *                     - namespace
 *                     - model
 *                     - status
 *                     - repo
 *                     - branch
 *                     - services
 *                     - websocketUrl
 *                     - editorUrl
 *                     - lastActivity
 *                     - createdAt
 *                     - updatedAt
 *                     - endedAt
 *                   properties:
 *                     id:
 *                       type: string
 *                     buildUuid:
 *                       type: string
 *                       nullable: true
 *                     baseBuildUuid:
 *                       type: string
 *                       nullable: true
 *                     buildKind:
 *                       $ref: '#/components/schemas/BuildKind'
 *                     userId:
 *                       type: string
 *                     ownerGithubUsername:
 *                       type: string
 *                       nullable: true
 *                     podName:
 *                       type: string
 *                     namespace:
 *                       type: string
 *                     model:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [starting, active, ended, error]
 *                     repo:
 *                       type: string
 *                       nullable: true
 *                     branch:
 *                       type: string
 *                       nullable: true
 *                     services:
 *                       type: array
 *                       items:
 *                         type: string
 *                     websocketUrl:
 *                       type: string
 *                     editorUrl:
 *                       type: string
 *                     lastActivity:
 *                       type: string
 *                       format: date-time
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                     endedAt:
 *                       type: string
 *                       nullable: true
 *                       format: date-time
 *                 error:
 *                   nullable: true
 *       '400':
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: An active environment session already exists for the requested environment
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
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const includeEnded = req.nextUrl.searchParams.get('includeEnded') === 'true';
  const sessions = await AgentSessionService.getSessions(userIdentity.userId, { includeEnded });
  return successResponse(
    sessions.map((session) => serializeSessionSummary(session)),
    { status: 200 },
    req
  );
};

const postHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const body = (await req.json()) as CreateSessionBody;
  const { buildUuid, services, model } = body;

  let repoUrl = body.repoUrl;
  let branch = body.branch;
  let prNumber = body.prNumber;
  let namespace = body.namespace;
  let buildKind = BuildKind.ENVIRONMENT;

  if (buildUuid) {
    const build = await resolveBuildContext(buildUuid);
    if (!build?.pullRequest) {
      return errorResponse(new Error('Build not found'), { status: 404 }, req);
    }

    buildKind = build.kind || BuildKind.ENVIRONMENT;
    repoUrl = repoUrl || `https://github.com/${build.pullRequest.fullName}.git`;
    branch = branch || build.pullRequest.branchName;
    prNumber = prNumber ?? build.pullRequest.pullRequestNumber;
    namespace = namespace || build.namespace;
  }

  let resolvedServices: ResolvedSessionService[];
  try {
    resolvedServices = await resolveRequestedServices(buildUuid, services);
  } catch (err) {
    return errorResponse(err, { status: 400 }, req);
  }

  if (!repoUrl || !branch || !namespace) {
    return errorResponse(new Error('repoUrl, branch, and namespace are required'), { status: 400 }, req);
  }

  try {
    const runtimeConfig = await resolveAgentSessionRuntimeConfig();
    const githubToken = await resolveRequestGitHubToken(req);
    const session = await AgentSessionService.createSession({
      userId: userIdentity.userId,
      userIdentity,
      githubToken,
      buildUuid,
      buildKind,
      services: resolvedServices,
      model,
      repoUrl,
      branch,
      prNumber,
      namespace,
      agentImage: runtimeConfig.image,
      editorImage: runtimeConfig.editorImage,
    });

    return successResponse(
      serializeSessionSummary({
        ...session,
        baseBuildUuid: null,
        repo: repoNameFromRepoUrl(repoUrl),
        branch,
        services: resolvedServices.map((service) => service.name),
      }),
      { status: 201 },
      req
    );
  } catch (err) {
    if (err instanceof ActiveEnvironmentSessionError) {
      return errorResponse(err, { status: 409 }, req);
    }

    if (err instanceof Error && err.message === 'API_KEY_REQUIRED') {
      return errorResponse(
        new Error('An Anthropic API key is required. Please add one in settings.'),
        { status: 400 },
        req
      );
    }
    if (err instanceof AgentSessionRuntimeConfigError) {
      return errorResponse(err, { status: 503 }, req);
    }
    throw err;
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
