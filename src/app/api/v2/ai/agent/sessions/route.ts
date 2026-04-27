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
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, errorResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import type { DevConfig } from 'server/models/yaml/YamlService';
import type { LifecycleConfig } from 'server/models/yaml';
import AgentChatSessionService from 'server/services/agent/ChatSessionService';
import { MissingAgentProviderApiKeyError } from 'server/services/agent/ProviderRegistry';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import {
  DEFAULT_AGENT_SESSION_LIST_LIMIT,
  MAX_AGENT_SESSION_LIST_LIMIT,
} from 'server/services/agent/SessionReadService';
import { AgentSessionKind, BuildKind } from 'shared/constants';

interface RequestedAgentSessionServiceRef {
  name: string;
  repo?: string | null;
  branch?: string | null;
}

interface ResolvedSessionService {
  name: string;
  deployId: number;
  devConfig: DevConfig;
  resourceName?: string;
  repo?: string | null;
  branch?: string | null;
  revision?: string | null;
  workspacePath?: string;
  workDir?: string | null;
}

interface CreateSessionBody {
  defaults?: {
    model?: string;
    harness?: string;
  };
  source?: {
    adapter?: string;
    input?: Record<string, unknown>;
  };
  workspace?: {
    storageSize?: string;
  };
}

function repoNameFromRepoUrl(repoUrl?: string | null) {
  if (!repoUrl) {
    return null;
  }

  const normalized = repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  return normalized || null;
}

function parseRequestedWorkspaceStorageSize(body: CreateSessionBody): string | undefined {
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

async function resolveLifecycleConfigForSession({
  buildContext,
  repoUrl,
  branch,
}: {
  buildContext: Awaited<ReturnType<typeof resolveBuildContext>> | null;
  repoUrl?: string | null;
  branch?: string | null;
}): Promise<LifecycleConfig | null> {
  const { fetchLifecycleConfig } = await import('server/models/yaml');

  if (buildContext?.pullRequest?.fullName && buildContext.pullRequest.branchName) {
    return fetchLifecycleConfig(buildContext.pullRequest.fullName, buildContext.pullRequest.branchName);
  }

  const repositoryName = repoNameFromRepoUrl(repoUrl);
  if (!repositoryName || !branch) {
    return null;
  }

  return fetchLifecycleConfig(repositoryName, branch);
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

function isRequestedSessionServiceRef(value: unknown): value is RequestedAgentSessionServiceRef {
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

async function resolveBuildContext(buildUuid: string) {
  const { default: Build } = await import('server/models/Build');
  return Build.query()
    .findOne({ uuid: buildUuid })
    .withGraphFetched('[pullRequest, deploys.[deployable, repository, service]]');
}

async function resolveRequestedServices(
  buildUuid: string | undefined,
  requestedServices: unknown[] | undefined,
  buildContext: Awaited<ReturnType<typeof resolveBuildContext>> | null
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

  if (!buildContext) {
    throw new Error('Build not found');
  }

  const { resolveAgentSessionServiceCandidatesForBuild, resolveRequestedAgentSessionServices } = await import(
    'server/services/agentSessionCandidates'
  );

  const requestedRefs = requestedServices.map((service) => {
    if (typeof service === 'string') {
      return service;
    }

    if (isRequestedSessionServiceRef(service)) {
      return service;
    }

    throw new Error('services must be an array of service names or repo-qualified service references');
  });

  return resolveRequestedAgentSessionServices(
    await resolveAgentSessionServiceCandidatesForBuild(buildContext),
    requestedRefs
  ).map(({ name, deployId, devConfig, baseDeploy, repo, branch, revision }) => ({
    name,
    deployId,
    devConfig,
    resourceName: baseDeploy.uuid || undefined,
    repo,
    branch,
    revision: revision || null,
  }));
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
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number for pagination.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 25
 *           minimum: 1
 *           maximum: 100
 *         description: Number of sessions per page.
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
 *                     $ref: '#/components/schemas/AgentSessionSummary'
 *                 metadata:
 *                   $ref: '#/components/schemas/ResponseMetadata'
 *                 error:
 *                   nullable: true
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Create a new agent session
 *     tags:
 *       - Agent Sessions
 *     operationId: createAgentSession
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source]
 *             properties:
 *               defaults:
 *                 type: object
 *                 properties:
 *                   model:
 *                     type: string
 *                   harness:
 *                     type: string
 *               source:
 *                 type: object
 *                 required: [adapter]
 *                 properties:
 *                   adapter:
 *                     type: string
 *                   input:
 *                     type: object
 *                     additionalProperties: true
 *               workspace:
 *                 type: object
 *                 properties:
 *                   storageSize:
 *                     type: string
 *                     description: Optional workspace PVC size. Accepted only when admin runtime settings allow client overrides.
 *               sandbox:
 *                 type: object
 *                 properties:
 *                   providerHint:
 *                     type: string
 *                   requirements:
 *                     type: object
 *                     additionalProperties: true
 *               thread:
 *                 type: object
 *                 properties:
 *                   createDefault:
 *                     type: boolean
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
 *                   $ref: '#/components/schemas/AgentSessionSummary'
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
  const page = parseInt(req.nextUrl.searchParams.get('page') || '1', 10);
  const requestedLimit = parseInt(
    req.nextUrl.searchParams.get('limit') || String(DEFAULT_AGENT_SESSION_LIST_LIMIT),
    10
  );
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(requestedLimit, MAX_AGENT_SESSION_LIST_LIMIT)
    : DEFAULT_AGENT_SESSION_LIST_LIMIT;
  const result = await AgentSessionReadService.listOwnedSessionRecords(userIdentity.userId, {
    includeEnded,
    page,
    limit,
  });

  return successResponse(
    result.records,
    {
      status: 200,
      metadata: result.metadata,
    },
    req
  );
};

const postHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const body = (await req.json()) as CreateSessionBody;
  let requestedWorkspaceStorageSize: string | undefined;
  try {
    requestedWorkspaceStorageSize = parseRequestedWorkspaceStorageSize(body);
  } catch (err) {
    return errorResponse(err, { status: 400 }, req);
  }
  const sourceInput =
    body.source?.input && typeof body.source.input === 'object' && !Array.isArray(body.source.input)
      ? body.source.input
      : {};
  const buildUuid =
    typeof (sourceInput as { buildUuid?: unknown }).buildUuid === 'string'
      ? (sourceInput as { buildUuid: string }).buildUuid
      : undefined;
  const services = Array.isArray((sourceInput as { services?: unknown[] }).services)
    ? (sourceInput as { services: unknown[] }).services
    : undefined;
  const requestedModel = body.defaults?.model;
  const sessionKind =
    body.source?.adapter === 'blank_workspace'
      ? AgentSessionKind.CHAT
      : body.source?.adapter === 'lifecycle_fork'
      ? AgentSessionKind.SANDBOX
      : AgentSessionKind.ENVIRONMENT;

  if (sessionKind === AgentSessionKind.CHAT) {
    if (buildUuid || (Array.isArray(services) && services.length > 0)) {
      return errorResponse(
        new Error('Chat sessions cannot be created with buildUuid or attached services'),
        { status: 400 },
        req
      );
    }

    try {
      const { resolveAgentSessionRuntimeConfig, resolveAgentSessionWorkspaceStorageIntent } = await import(
        'server/lib/agentSession/runtimeConfig'
      );
      const workspaceStorage = requestedWorkspaceStorageSize
        ? resolveAgentSessionWorkspaceStorageIntent({
            requestedSize: requestedWorkspaceStorageSize,
            storage: (await resolveAgentSessionRuntimeConfig()).workspaceStorage,
          })
        : undefined;
      const session = await AgentChatSessionService.createChatSession({
        userId: userIdentity.userId,
        userIdentity,
        model: requestedModel,
        workspaceStorage,
      });

      return successResponse(await AgentSessionReadService.serializeSessionRecord(session), { status: 201 }, req);
    } catch (err) {
      const { AgentSessionRuntimeConfigError, AgentSessionWorkspaceStorageConfigError } = await import(
        'server/lib/agentSession/runtimeConfig'
      );
      if (err instanceof MissingAgentProviderApiKeyError) {
        return errorResponse(err, { status: 400 }, req);
      }
      if (err instanceof AgentSessionRuntimeConfigError || err instanceof AgentSessionWorkspaceStorageConfigError) {
        return errorResponse(err, { status: 400 }, req);
      }

      return errorResponse(err, { status: 500 }, req);
    }
  }

  let repoUrl =
    typeof (sourceInput as { repoUrl?: unknown }).repoUrl === 'string'
      ? (sourceInput as { repoUrl: string }).repoUrl
      : undefined;
  let branch =
    typeof (sourceInput as { branch?: unknown }).branch === 'string'
      ? (sourceInput as { branch: string }).branch
      : undefined;
  let prNumber =
    typeof (sourceInput as { prNumber?: unknown }).prNumber === 'number'
      ? (sourceInput as { prNumber: number }).prNumber
      : undefined;
  let namespace =
    typeof (sourceInput as { namespace?: unknown }).namespace === 'string'
      ? (sourceInput as { namespace: string }).namespace
      : undefined;
  let buildKind = BuildKind.ENVIRONMENT;
  let buildContext: Awaited<ReturnType<typeof resolveBuildContext>> | null = null;
  let lifecycleConfig: LifecycleConfig | null = null;

  if (buildUuid) {
    buildContext = await resolveBuildContext(buildUuid);
    if (!buildContext?.pullRequest) {
      return errorResponse(new Error('Build not found'), { status: 404 }, req);
    }

    buildKind = buildContext.kind || BuildKind.ENVIRONMENT;
    repoUrl = repoUrl || `https://github.com/${buildContext.pullRequest.fullName}.git`;
    branch = branch || buildContext.pullRequest.branchName;
    prNumber = prNumber ?? buildContext.pullRequest.pullRequestNumber;
    namespace = namespace || buildContext.namespace;
  }

  try {
    lifecycleConfig = await resolveLifecycleConfigForSession({
      buildContext,
      repoUrl,
      branch,
    });
  } catch {
    lifecycleConfig = null;
  }

  let resolvedServices: ResolvedSessionService[];
  try {
    resolvedServices = await resolveRequestedServices(buildUuid, services, buildContext);
  } catch (err) {
    return errorResponse(err, { status: 400 }, req);
  }

  if (!repoUrl || !branch || !namespace) {
    return errorResponse(new Error('repoUrl, branch, and namespace are required'), { status: 400 }, req);
  }

  try {
    const [
      { resolveRequestGitHubToken },
      {
        mergeAgentSessionReadinessForServices,
        mergeAgentSessionResources,
        resolveAgentSessionRuntimeConfig,
        resolveAgentSessionWorkspaceStorageIntent,
      },
      { default: AgentSessionService },
    ] = await Promise.all([
      import('server/lib/agentSession/githubToken'),
      import('server/lib/agentSession/runtimeConfig'),
      import('server/services/agentSession'),
    ]);
    const runtimeConfig = await resolveAgentSessionRuntimeConfig();
    const workspaceStorage = resolveAgentSessionWorkspaceStorageIntent({
      requestedSize: requestedWorkspaceStorageSize,
      storage: runtimeConfig.workspaceStorage,
    });
    const githubToken = await resolveRequestGitHubToken(req);
    const session = await AgentSessionService.createSession({
      userId: userIdentity.userId,
      userIdentity,
      githubToken,
      buildUuid,
      buildKind,
      services: resolvedServices,
      model: requestedModel,
      environmentSkillRefs: lifecycleConfig?.environment?.agentSession?.skills,
      repoUrl,
      branch,
      prNumber,
      namespace,
      workspaceImage: runtimeConfig.workspaceImage,
      workspaceEditorImage: runtimeConfig.workspaceEditorImage,
      workspaceGatewayImage: runtimeConfig.workspaceGatewayImage,
      nodeSelector: runtimeConfig.nodeSelector,
      keepAttachedServicesOnSessionNode: runtimeConfig.keepAttachedServicesOnSessionNode,
      readiness: mergeAgentSessionReadinessForServices(
        runtimeConfig.readiness,
        resolvedServices.map((service) => service.devConfig.agentSession?.readiness)
      ),
      resources: mergeAgentSessionResources(
        runtimeConfig.resources,
        lifecycleConfig?.environment?.agentSession?.resources
      ),
      workspaceStorage,
      redisTtlSeconds: runtimeConfig.cleanup.redisTtlSeconds,
    });

    return successResponse(await AgentSessionReadService.serializeSessionRecord(session), { status: 201 }, req);
  } catch (err) {
    const { ActiveEnvironmentSessionError } = await import('server/services/agentSession');
    const { AgentSessionRuntimeConfigError, AgentSessionWorkspaceStorageConfigError } = await import(
      'server/lib/agentSession/runtimeConfig'
    );

    if (err instanceof ActiveEnvironmentSessionError) {
      return errorResponse(err, { status: 409 }, req);
    }
    if (err instanceof MissingAgentProviderApiKeyError) {
      return errorResponse(err, { status: 400 }, req);
    }
    if (err instanceof AgentSessionRuntimeConfigError) {
      return errorResponse(err, { status: 503 }, req);
    }
    if (err instanceof AgentSessionWorkspaceStorageConfigError) {
      return errorResponse(err, { status: 400 }, req);
    }
    throw err;
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
