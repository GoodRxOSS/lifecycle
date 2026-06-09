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
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubAuth } from 'server/lib/agentSession/githubToken';
import { buildWorkspaceFailureLinkData } from 'server/lib/agentSession/workspaceFailureLink';
import AgentRunAdmissionService from 'server/services/agent/RunAdmissionService';
import AgentRunQueueService from 'server/services/agent/RunQueueService';
import AgentRunService, { InvalidAgentRunDefaultsError } from 'server/services/agent/RunService';
import AgentRunPlanResolver, { AgentRunPlanAgentUnavailableError } from 'server/services/agent/RunPlanResolver';
import AgentThreadService from 'server/services/agent/ThreadService';
import { getRunMessageText, readString } from 'server/lib/agent/runRequestText';
import {
  normalizeCanonicalAgentMessagePart,
  type AgentRunRuntimeOptions,
  type CanonicalAgentRunMessageInput,
} from 'server/services/agent/canonicalMessages';
import type { AgentRequestGitHubAuth } from 'server/services/agent/githubAuth';
import { normalizeAgentRequestGitHubAuth } from 'server/services/agent/githubAuth';
import { isAgentDebugRunIntent, type AgentDebugRunIntent } from 'server/services/agent/runPlanTypes';
import AgentSourceService from 'server/services/agent/SourceService';
import AgentSessionService from 'server/services/agentSession';
import AgentMessageStore from 'server/services/agent/MessageStore';

const DISPATCH_GITHUB_TOKEN_WAIT_MS = 250;

function getUnknownKeys(value: Record<string, unknown>, allowedKeys: string[]): string[] {
  return Object.keys(value).filter((key) => !allowedKeys.includes(key));
}

function hasOnlyAllowedCanonicalPartKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const part = value as Record<string, unknown>;
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return getUnknownKeys(part, ['type', 'text']).length === 0;
    case 'file_ref':
      return getUnknownKeys(part, ['type', 'path', 'url', 'mediaType', 'title']).length === 0;
    case 'source_ref':
      return getUnknownKeys(part, ['type', 'url', 'title', 'sourceType']).length === 0;
    default:
      return false;
  }
}

function normalizeCanonicalRunMessage(value: unknown): CanonicalAgentRunMessageInput | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const message = value as Record<string, unknown>;
  if (getUnknownKeys(message, ['clientMessageId', 'parts']).length > 0) {
    return null;
  }

  if (message.clientMessageId !== undefined && typeof message.clientMessageId !== 'string') {
    return null;
  }

  if (!Array.isArray(message.parts)) {
    return null;
  }

  if (!message.parts.every(hasOnlyAllowedCanonicalPartKeys)) {
    return null;
  }

  const parts = message.parts.map(normalizeCanonicalAgentMessagePart);
  if (parts.some((part) => !part) || parts.length === 0) {
    return null;
  }

  return {
    ...(typeof message.clientMessageId === 'string' && message.clientMessageId.trim()
      ? { clientMessageId: message.clientMessageId.trim() }
      : {}),
    parts: parts as CanonicalAgentRunMessageInput['parts'],
  };
}

async function resolveDispatchGitHubAuth(req: NextRequest): Promise<AgentRequestGitHubAuth> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const auth = await Promise.race([
      resolveRequestGitHubAuth(req),
      new Promise<AgentRequestGitHubAuth>((resolve) => {
        timeout = setTimeout(
          () => resolve(normalizeAgentRequestGitHubAuth({ githubToken: null, source: 'none' })),
          DISPATCH_GITHUB_TOKEN_WAIT_MS
        );
      }),
    ]);
    return {
      ...normalizeAgentRequestGitHubAuth(auth),
      writeAuthorized: false,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function normalizeModelRequest(
  value: unknown
): { requestedProvider: string | null; requestedModel: string | null } | null {
  if (value === undefined) {
    return {
      requestedProvider: null,
      requestedModel: null,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const model = value as Record<string, unknown>;
  if (getUnknownKeys(model, ['provider', 'id']).length > 0) {
    return null;
  }
  if (model.provider !== undefined && typeof model.provider !== 'string') {
    return null;
  }
  if (model.id !== undefined && typeof model.id !== 'string') {
    return null;
  }

  return {
    requestedProvider: readString(model.provider),
    requestedModel: readString(model.id),
  };
}

function normalizeRuntimeOptions(value: unknown): AgentRunRuntimeOptions | null {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const options = value as Record<string, unknown>;
  if (getUnknownKeys(options, ['maxIterations']).length > 0) {
    return null;
  }

  const normalized: AgentRunRuntimeOptions = {};
  if (options.maxIterations !== undefined) {
    if (
      typeof options.maxIterations !== 'number' ||
      !Number.isInteger(options.maxIterations) ||
      options.maxIterations < 1
    ) {
      return null;
    }
    normalized.maxIterations = options.maxIterations;
  }

  return normalized;
}

function normalizeDebugIntent(value: unknown): { ok: true; value: AgentDebugRunIntent | null } | { ok: false } {
  if (value === undefined) {
    return { ok: true, value: null };
  }

  if (typeof value !== 'string') {
    return { ok: false };
  }

  const normalized = value.trim();
  if (!isAgentDebugRunIntent(normalized)) {
    return { ok: false };
  }

  return { ok: true, value: normalized };
}

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/runs:
 *   post:
 *     summary: Create and enqueue a managed run for an agent thread
 *     description: Creates a run and resolves its run plan server-side from the thread's selected agent, runtime-control choices, requested model, optional Debug intent, source, and policy. Request body supports only message, model, debugIntent, and runtimeOptions.
 *     tags:
 *       - Agent Platform
 *     operationId: createAgentThreadRun
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentThreadRunRequest'
 *     responses:
 *       '200':
 *         description: Existing managed run returned for an idempotent client message retry
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/CreateAgentThreadRunResponse'
 *       '201':
 *         description: Managed run created
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/CreateAgentThreadRunResponse'
 *       '400':
 *         description: Invalid run request, model selection, harness, or runtime options.
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
 *         description: Thread or session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: Session source is not ready, another run is already active, or the selected agent requires a workspace
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   nullable: true
 *                   allOf:
 *                     - $ref: '#/components/schemas/WorkspaceFailureLinkData'
 *                 error:
 *                   $ref: '#/components/schemas/ApiError'
 */
const postHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(new Error('Request body must be an object'), { status: 400 }, req);
  }

  const requestBody = body as Record<string, unknown>;
  const unknownTopLevelKeys = getUnknownKeys(requestBody, ['message', 'model', 'debugIntent', 'runtimeOptions']);
  if (unknownTopLevelKeys.length > 0) {
    return errorResponse(
      new Error(`Unsupported run request fields: ${unknownTopLevelKeys.join(', ')}`),
      { status: 400 },
      req
    );
  }

  const message = normalizeCanonicalRunMessage(requestBody.message);
  if (!message) {
    return errorResponse(
      new Error('message must contain supported canonical parts and no role or metadata fields'),
      { status: 400 },
      req
    );
  }

  const modelRequest = normalizeModelRequest(requestBody.model);
  if (!modelRequest) {
    return errorResponse(new Error('model must contain only provider and id fields'), { status: 400 }, req);
  }

  const runtimeOptions = normalizeRuntimeOptions(requestBody.runtimeOptions);
  if (!runtimeOptions) {
    return errorResponse(new Error('runtimeOptions contains unsupported or invalid fields'), { status: 400 }, req);
  }

  const debugIntent = normalizeDebugIntent(requestBody.debugIntent);
  if (!debugIntent.ok) {
    return errorResponse(
      new Error('debugIntent must be one of diagnose, investigate, or repair'),
      { status: 400 },
      req
    );
  }

  let threadWithSession;
  try {
    threadWithSession = await AgentThreadService.getOwnedThreadWithSession(routeParams.threadId, userIdentity.userId);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Agent thread not found' || error.message === 'Agent session not found')
    ) {
      return errorResponse(error, { status: 404 }, req);
    }
    throw error;
  }

  const { thread } = threadWithSession;
  // A message to an archived session revives it; the workspace re-provisions lazily on demand.
  const session = await AgentSessionService.ensureSessionActive(threadWithSession.session, userIdentity.userId);
  if (!AgentSessionService.canAcceptMessages(session)) {
    return errorResponse(new Error(AgentSessionService.getMessageBlockReason(session)), { status: 409 }, req);
  }

  const source = await AgentSourceService.getSessionSource(session.id);
  if (!source || source.status !== 'ready') {
    return errorResponse(new Error('Session source is not ready yet.'), { status: 409 }, req);
  }

  let runPlan;
  try {
    runPlan = await AgentRunPlanResolver.resolveForRunAdmission({
      thread,
      session,
      source,
      userIdentity,
      requestedProvider: modelRequest.requestedProvider,
      requestedModel: modelRequest.requestedModel,
      runtimeOptions,
      messageText: getRunMessageText(message),
      requestedDebugIntent: debugIntent.value,
      findPriorCompletedDebugIntentRun: AgentRunService.hasPriorCompletedDebugIntentRun,
    });
  } catch (error) {
    if (error instanceof AgentRunPlanAgentUnavailableError && error.reason === 'workspace_required') {
      const failureData = await buildWorkspaceFailureLinkData({
        sessionId: session.uuid,
        userId: userIdentity.userId,
        includeWithoutFailure: true,
      });
      return errorResponse(error, { status: 409, data: failureData }, req);
    }
    return errorResponse(error instanceof Error ? error : new Error('Invalid agent run model'), { status: 400 }, req);
  }

  let admission: Awaited<ReturnType<typeof AgentRunAdmissionService.createQueuedRunWithMessage>>;
  try {
    admission = await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread,
      session,
      policy: runPlan.approvalPolicy,
      message,
      requestedHarness: runPlan.requestedHarness,
      requestedProvider: runPlan.requestedProvider,
      requestedModel: runPlan.requestedModel,
      resolvedHarness: runPlan.resolvedHarness,
      resolvedProvider: runPlan.resolvedProvider,
      resolvedModel: runPlan.resolvedModel,
      sandboxRequirement: runPlan.sandboxRequirement,
      runtimeOptions: runPlan.runtimeOptions,
      runPlanSnapshot: runPlan.runPlanSnapshot,
    });
  } catch (error) {
    if (AgentRunService.isActiveRunConflictError(error)) {
      return errorResponse(error, { status: 409 }, req);
    }
    if (error instanceof InvalidAgentRunDefaultsError) {
      return errorResponse(error, { status: 400 }, req);
    }

    throw error;
  }

  try {
    await AgentSessionService.touchActivity(session.uuid);
  } catch (error) {
    if (admission.created) {
      await AgentRunService.markQueuedRunDispatchFailed(admission.run.uuid, error).catch(() => {});
    }
    throw error;
  }

  if (admission.created || admission.run.status === 'queued') {
    const githubAuth = await resolveDispatchGitHubAuth(req);
    await AgentRunQueueService.enqueueRun(admission.run.uuid, 'submit', { githubAuth });
  }

  return successResponse(
    {
      run: {
        ...AgentRunService.serializeRun(admission.run),
        threadId: thread.uuid,
        sessionId: session.uuid,
      },
      message: AgentMessageStore.serializeCanonicalMessage(admission.message, thread.uuid, admission.run.uuid),
      links: {
        events: `/api/v2/ai/agent/runs/${admission.run.uuid}/events`,
        eventStream: `/api/v2/ai/agent/runs/${admission.run.uuid}/events/stream`,
        pendingActions: `/api/v2/ai/agent/threads/${thread.uuid}/pending-actions`,
      },
    },
    { status: admission.created ? 201 : 200 },
    req
  );
};

export const POST = createApiHandler(postHandler);
