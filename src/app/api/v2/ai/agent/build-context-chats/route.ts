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
import BuildContextChatService, {
  BuildContextChatBuildNotFoundError,
} from 'server/services/agent/BuildContextChatService';
import { AgentModelSelectionError, MissingAgentProviderApiKeyError } from 'server/services/agent/ProviderRegistry';
import AgentSessionReadService from 'server/services/agent/SessionReadService';

interface CreateBuildContextChatBody {
  buildUuid: string;
  defaults?: {
    model?: string;
  };
}

const ALLOWED_TOP_LEVEL_KEYS = ['buildUuid', 'defaults'];
const ALLOWED_DEFAULT_KEYS = ['model'];

function unknownKeys(value: Record<string, unknown>, allowedKeys: string[]) {
  return Object.keys(value).filter((key) => !allowedKeys.includes(key));
}

function parseCreateBuildContextChatBody(body: unknown): CreateBuildContextChatBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object');
  }

  const requestBody = body as Record<string, unknown>;
  const unsupportedKeys = unknownKeys(requestBody, ALLOWED_TOP_LEVEL_KEYS);
  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported build-context chat fields: ${unsupportedKeys.join(', ')}`);
  }

  if (typeof requestBody.buildUuid !== 'string' || !requestBody.buildUuid.trim()) {
    throw new Error('buildUuid must be a non-empty string');
  }

  if (requestBody.defaults === undefined) {
    return {
      buildUuid: requestBody.buildUuid.trim(),
    };
  }

  if (!requestBody.defaults || typeof requestBody.defaults !== 'object' || Array.isArray(requestBody.defaults)) {
    throw new Error('defaults must be an object');
  }

  const defaults = requestBody.defaults as Record<string, unknown>;
  const unsupportedDefaultKeys = unknownKeys(defaults, ALLOWED_DEFAULT_KEYS);
  if (unsupportedDefaultKeys.length > 0) {
    throw new Error(`Unsupported build-context chat defaults fields: ${unsupportedDefaultKeys.join(', ')}`);
  }

  if (defaults.model !== undefined && typeof defaults.model !== 'string') {
    throw new Error('defaults.model must be a string');
  }

  const requestedModel = defaults.model?.trim() || undefined;
  return {
    buildUuid: requestBody.buildUuid.trim(),
    ...(requestedModel ? { defaults: { model: requestedModel } } : {}),
  };
}

/**
 * @openapi
 * /api/v2/ai/agent/build-context-chats:
 *   post:
 *     summary: Create or reuse a build-context agent chat
 *     description: Creates or reuses a build-context chat session and default thread. This endpoint does not submit a message or run.
 *     tags:
 *       - Agent Sessions
 *     operationId: createBuildContextAgentChat
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateBuildContextAgentChatRequest'
 *     responses:
 *       '200':
 *         description: Existing build-context chat reused
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/BuildContextAgentChatResponse'
 *       '201':
 *         description: Build-context chat created
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/BuildContextAgentChatResponse'
 *       '400':
 *         description: Invalid request or model configuration
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
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const postHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  let requestBody: CreateBuildContextChatBody;
  try {
    requestBody = parseCreateBuildContextChatBody(await req.json().catch(() => null));
  } catch (error) {
    return errorResponse(error, { status: 400 }, req);
  }

  try {
    const result = await BuildContextChatService.launchBuildContextChat({
      buildUuid: requestBody.buildUuid,
      userId: userIdentity.userId,
      userIdentity,
      model: requestBody.defaults?.model,
    });
    const [session, thread] = await Promise.all([
      AgentSessionReadService.serializeSessionRecord(result.session),
      AgentSessionReadService.serializeThread(result.thread, result.session),
    ]);
    const threadId = thread.id;

    return successResponse(
      {
        session,
        thread,
        created: result.created,
        reused: result.reused,
        buildContext: {
          buildUuid: result.buildContext.buildUuid,
          buildKind: result.buildContext.buildKind,
          namespace: result.buildContext.namespace,
          baseBuildUuid: result.buildContext.baseBuildUuid,
          repo: result.buildContext.pullRequest?.fullName ?? null,
          branch: result.buildContext.pullRequest?.branchName ?? null,
          pullRequestNumber: result.buildContext.pullRequest?.pullRequestNumber ?? null,
          contextFreshAt: result.buildContext.contextFreshAt,
        },
        links: {
          messages: `/api/v2/ai/agent/threads/${threadId}/messages`,
          runs: `/api/v2/ai/agent/threads/${threadId}/runs`,
          events: '/api/v2/ai/agent/runs/{runId}/events',
          eventStream: '/api/v2/ai/agent/runs/{runId}/events/stream',
          pendingActions: `/api/v2/ai/agent/threads/${threadId}/pending-actions`,
        },
      },
      { status: result.created ? 201 : 200 },
      req
    );
  } catch (error) {
    if (error instanceof BuildContextChatBuildNotFoundError) {
      return errorResponse(error, { status: 404 }, req);
    }
    if (error instanceof MissingAgentProviderApiKeyError) {
      return errorResponse(error, { status: 400 }, req);
    }
    if (error instanceof AgentModelSelectionError) {
      return errorResponse(error, { status: 400 }, req);
    }

    throw error;
  }
};

export const POST = createApiHandler(postHandler);
