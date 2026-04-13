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

import {
  createAgentUIStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
  validateUIMessages,
} from 'ai';
import { NextRequest } from 'next/server';
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentMessageStore from 'server/services/agent/MessageStore';
import { buildMessageObservabilityMetadataPatch, normalizeSdkUsageSummary } from 'server/services/agent/observability';
import AgentRunService from 'server/services/agent/RunService';
import AgentThreadService from 'server/services/agent/ThreadService';
import ApprovalService from 'server/services/agent/ApprovalService';
import AgentRunExecutor from 'server/services/agent/RunExecutor';
import AgentStreamBroker from 'server/services/agent/StreamBroker';
import AgentSessionService from 'server/services/agentSession';
import { applyApprovalResponsesToFileChangeParts } from 'server/services/agent/fileChanges';
import type { AgentUIDataParts, AgentUIMessage, AgentUIMessageMetadata } from 'server/services/agent/types';
import { MissingAgentProviderApiKeyError } from 'server/services/agent/ProviderRegistry';
import { AGENT_API_KEY_HEADER, AGENT_API_KEY_PROVIDER_HEADER } from 'server/services/agent/providerConfig';

type AgentUiMessageChunk = UIMessageChunk<AgentUIMessageMetadata, AgentUIDataParts>;

function createChunkStream() {
  let controller: ReadableStreamDefaultController<AgentUiMessageChunk> | null = null;
  let closed = false;

  return {
    stream: new ReadableStream<AgentUiMessageChunk>({
      start(nextController) {
        controller = nextController;
        if (closed) {
          nextController.close();
          controller = null;
        }
      },
      cancel() {
        closed = true;
        controller = null;
      },
    }),
    write(chunk: AgentUiMessageChunk) {
      if (closed || !controller) {
        return;
      }

      controller.enqueue(chunk);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      if (controller) {
        controller.close();
        controller = null;
      }
    },
  };
}

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/messages:
 *   get:
 *     summary: List persisted messages for an agent thread
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentThreadMessages
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Thread and persisted messages
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
 *                       required: [thread, messages]
 *                       properties:
 *                         thread:
 *                           $ref: '#/components/schemas/AgentThread'
 *                         messages:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/AgentUIMessage'
 *   post:
 *     summary: Send messages to an agent thread and stream the response
 *     tags:
 *       - Agent Sessions
 *     operationId: postAgentThreadMessages
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
 *             type: object
 *             required: [messages]
 *             properties:
 *               provider:
 *                 type: string
 *               modelId:
 *                 type: string
 *               messages:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/AgentUIMessage'
 *     responses:
 *       '400':
 *         description: Invalid request or missing stored provider API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: Session is still starting or another run is already active for this thread
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '200':
 *         description: UI message stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
const getHandler = async (req: NextRequest, { params }: { params: { threadId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const { thread, session } = await AgentThreadService.getOwnedThreadWithSession(params.threadId, userIdentity.userId);
  const messages = await AgentMessageStore.listMessages(params.threadId, userIdentity.userId);

  return successResponse(
    {
      thread: AgentThreadService.serializeThread(thread, session.uuid),
      messages,
    },
    { status: 200 },
    req
  );
};

const postHandler = async (req: NextRequest, { params }: { params: { threadId: string } }): Promise<Response> => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body?.messages)) {
    return errorResponse(new Error('messages array is required'), { status: 400 }, req);
  }
  let submittedMessages: AgentUIMessage[];
  try {
    submittedMessages = await validateUIMessages<AgentUIMessage>({
      messages: body.messages,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error : new Error('Invalid UI messages'), { status: 400 }, req);
  }

  const { thread, session } = await AgentThreadService.getOwnedThreadWithSession(params.threadId, userIdentity.userId);
  if (session.status !== 'active') {
    return errorResponse(
      new Error(
        session.status === 'starting'
          ? 'Wait for the session to finish starting before sending a message.'
          : 'This session is no longer available for new messages.'
      ),
      { status: 409 },
      req
    );
  }
  const latestSubmittedMessage = submittedMessages[submittedMessages.length - 1];
  const isNewUserTurn = latestSubmittedMessage?.role === 'user';
  if (isNewUserTurn) {
    const latestRun = await AgentRunService.getLatestOwnedThreadRun(params.threadId, userIdentity.userId);
    if (latestRun && !AgentRunService.isTerminalStatus(latestRun.status)) {
      return errorResponse(
        new Error(
          latestRun.status === 'waiting_for_approval'
            ? 'Respond to the approval request before sending another message.'
            : 'Wait for the current agent run to finish before sending another message.'
        ),
        { status: 409 },
        req
      );
    }
  }

  const normalizedSubmittedMessages = applyApprovalResponsesToFileChangeParts(submittedMessages);
  await ApprovalService.syncApprovalResponsesFromMessages(
    params.threadId,
    userIdentity.userId,
    normalizedSubmittedMessages
  );
  const syncedMessages = await AgentMessageStore.syncMessages(
    params.threadId,
    userIdentity.userId,
    normalizedSubmittedMessages
  );
  await AgentSessionService.touchActivity(session.uuid);
  const fileChangeStream = createChunkStream();
  let execution: Awaited<ReturnType<typeof AgentRunExecutor.execute>>;
  try {
    execution = await AgentRunExecutor.execute({
      session,
      thread,
      userIdentity,
      messages: syncedMessages,
      requestedProvider: typeof body?.provider === 'string' ? body.provider : undefined,
      requestedModelId: typeof body?.modelId === 'string' ? body.modelId : undefined,
      requestApiKey: req.headers.get(AGENT_API_KEY_HEADER),
      requestApiKeyProvider: req.headers.get(AGENT_API_KEY_PROVIDER_HEADER),
      onFileChange: async (change) => {
        fileChangeStream.write({
          type: 'data-file-change',
          id: change.id,
          data: change,
        });
      },
    });
  } catch (error) {
    if (error instanceof MissingAgentProviderApiKeyError) {
      return errorResponse(error, { status: 400 }, req);
    }

    throw error;
  }

  let finishContext: {
    finishReason?: string;
    isAborted: boolean;
  } = {
    finishReason: undefined,
    isAborted: false,
  };

  const agentUiMessageStream = await createAgentUIStream<
    never,
    typeof execution.agent.tools,
    never,
    AgentUIMessageMetadata
  >({
    agent: execution.agent,
    uiMessages: syncedMessages,
    generateMessageId: () => crypto.randomUUID(),
    abortSignal: execution.abortSignal,
    onFinish: async ({ finishReason, isAborted }) => {
      finishContext = {
        finishReason,
        isAborted,
      };
      fileChangeStream.close();
    },
    messageMetadata: ({ part }) => {
      const eventType = (part as { type?: string }).type;
      if (eventType === 'start') {
        return {
          sessionId: session.uuid,
          threadId: thread.uuid,
          runId: execution.run.uuid,
          provider: execution.selection.provider,
          model: execution.selection.modelId,
          createdAt: new Date().toISOString(),
        };
      }

      if (eventType === 'finish-step') {
        const response = (part as { response?: unknown }).response as
          | {
              id?: string;
              modelId?: string;
              timestamp?: string | Date | number;
            }
          | undefined;
        const providerMetadata = (part as { providerMetadata?: unknown }).providerMetadata as
          | Record<string, unknown>
          | undefined;
        const warningCount = Array.isArray((part as { warnings?: unknown[] }).warnings)
          ? (part as { warnings: unknown[] }).warnings.length
          : undefined;

        return {
          ...(response?.id ? { responseId: response.id } : {}),
          ...(response?.modelId
            ? {
                responseModelId: response.modelId,
                model: response.modelId,
              }
            : {}),
          ...(response?.timestamp
            ? {
                responseTimestamp:
                  response.timestamp instanceof Date
                    ? response.timestamp.toISOString()
                    : typeof response.timestamp === 'number'
                    ? new Date(response.timestamp).toISOString()
                    : response.timestamp,
              }
            : {}),
          ...(providerMetadata ? { providerMetadata } : {}),
          ...(warningCount != null ? { warningCount } : {}),
        };
      }

      if (eventType === 'finish') {
        const totalUsage =
          (
            part as {
              totalUsage?: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                reasoningTokens?: number;
                cachedInputTokens?: number;
                inputTokenDetails?: {
                  cacheReadTokens?: number;
                  cacheWriteTokens?: number;
                  noCacheTokens?: number;
                };
                outputTokenDetails?: {
                  reasoningTokens?: number;
                  textTokens?: number;
                };
                raw?: unknown;
              };
              finishReason?: string;
              rawFinishReason?: string;
            }
          ).totalUsage ?? undefined;
        const usageSummary = totalUsage
          ? normalizeSdkUsageSummary({
              usage: totalUsage,
              finishReason:
                typeof (part as { finishReason?: unknown }).finishReason === 'string'
                  ? (part as { finishReason: string }).finishReason
                  : undefined,
              rawFinishReason:
                typeof (part as { rawFinishReason?: unknown }).rawFinishReason === 'string'
                  ? (part as { rawFinishReason: string }).rawFinishReason
                  : undefined,
            })
          : undefined;

        return {
          sessionId: session.uuid,
          threadId: thread.uuid,
          runId: execution.run.uuid,
          provider: execution.selection.provider,
          model: execution.selection.modelId,
          completedAt: new Date().toISOString(),
          ...(usageSummary ? buildMessageObservabilityMetadataPatch(usageSummary) : {}),
        };
      }

      return undefined;
    },
  });

  const uiMessageStream = createUIMessageStream<AgentUIMessage>({
    originalMessages: syncedMessages,
    generateId: () => crypto.randomUUID(),
    execute: ({ writer }) => {
      writer.merge(agentUiMessageStream as ReadableStream<AgentUiMessageChunk>);
      writer.merge(fileChangeStream.stream);
    },
    onFinish: async ({ messages }) => {
      await execution.onStreamFinish({
        messages,
        finishReason: finishContext.finishReason,
        isAborted: finishContext.isAborted,
      });
    },
  });

  const [responseStream, replayStream] = uiMessageStream.tee() as [
    ReadableStream<AgentUiMessageChunk>,
    ReadableStream<AgentUiMessageChunk>
  ];
  AgentStreamBroker.attach(execution.run.uuid, replayStream);

  return createUIMessageStreamResponse({
    stream: responseStream,
  });
};

export const GET = createApiHandler(getHandler);
export const POST = postHandler;
