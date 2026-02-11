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
import { createStreamHandler } from 'server/lib/createStreamHandler';
import { defaultDb, defaultRedis } from 'server/lib/dependencies';
import AIAgentContextService from 'server/services/ai/context/gatherer';
import AIAgentConversationService from 'server/services/ai/conversation/storage';
import AIAgentService from 'server/services/aiAgent';
import AIAgentConfigService from 'server/services/aiAgentConfig';
import { getLogger, withLogContext } from 'server/lib/logger';
import { extractJsonFromResponse } from 'server/services/ai/utils/jsonExtraction';
import { sanitizeForJson } from 'server/services/ai/utils/sanitize';
import {
  createClassifiedError,
  ErrorCategory,
  getUserErrorMessage,
  getSuggestedAction,
  isAuthError,
} from 'server/services/ai/errors';
import { isBrokenCircuitError } from 'cockatiel';
import type { AIChatSSEEvent, SSEErrorEvent } from 'shared/types/aiChat';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/chat/{buildUuid}:
 *   post:
 *     summary: Stream AI chat response
 *     description: >
 *       Sends a message to the AI agent and streams the response as Server-Sent Events.
 *       The buildUuid identifies the ephemeral environment context.
 *     tags:
 *       - AI Chat
 *     operationId: streamAIChat
 *     parameters:
 *       - in: path
 *         name: buildUuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build to chat with.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 description: The user message to send to the AI agent.
 *               clearHistory:
 *                 type: boolean
 *                 description: Whether to clear conversation history before processing.
 *               provider:
 *                 type: string
 *                 description: The LLM provider to use (e.g. anthropic, openai).
 *               modelId:
 *                 type: string
 *                 description: The specific model ID to use.
 *               isSystemAction:
 *                 type: boolean
 *                 description: Whether this message is a system-initiated action.
 *     responses:
 *       '200':
 *         description: SSE event stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       '400':
 *         description: Missing required fields or invalid JSON
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const postHandler = async (req: NextRequest, { params }: { params: { buildUuid: string } }): Promise<Response> => {
  const { buildUuid } = params;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!buildUuid || !body.message) {
    return new Response(JSON.stringify({ error: 'Missing required fields: buildUuid and message' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = (data: AIChatSSEEvent | SSEErrorEvent) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)).catch(() => {});
  };

  req.signal.addEventListener('abort', () => {
    try {
      writer.close();
    } catch {
      // already closed
    }
  });

  (async () => {
    try {
      const aiAgentConfigService = AIAgentConfigService.getInstance();
      const aiAgentConfig = await aiAgentConfigService.getEffectiveConfig();

      if (!aiAgentConfig?.enabled) {
        sendEvent({
          error: true,
          userMessage: 'AI Agent is not enabled',
          category: 'deterministic',
          suggestedAction: 'check-config',
          retryAfter: null,
          modelName: 'AI model',
          code: 'AI_AGENT_DISABLED',
        });
        return;
      }

      const { message, clearHistory, provider, modelId, isSystemAction, mode: requestedMode } = body;

      getLogger().info(
        `AI: v2 chat request received provider=${provider} modelId=${modelId} hasProvider=${!!provider} hasModelId=${!!modelId}`
      );

      await withLogContext({ buildUuid }, async () => {
        const aiAgentContextService = new AIAgentContextService(defaultDb, defaultRedis);
        const conversationService = new AIAgentConversationService(defaultDb, defaultRedis);
        const llmService = new AIAgentService(defaultDb, defaultRedis);

        if (clearHistory) {
          await conversationService.clearConversation(buildUuid);
        }

        const conversation = await conversationService.getConversation(buildUuid);
        const conversationHistory = conversation?.messages || [];

        let context;
        try {
          context = await aiAgentContextService.gatherFullContext(buildUuid);
        } catch (error: any) {
          getLogger().error({ error }, 'AI: context gather failed');
          sendEvent({
            error: true,
            userMessage: `Build not found: ${error.message}`,
            category: 'deterministic',
            suggestedAction: null,
            retryAfter: null,
            modelName: 'AI model',
            code: 'CONTEXT_ERROR',
          });
          return;
        }

        const repoFullName = context.lifecycleContext?.pullRequest?.fullName;

        try {
          if (provider && modelId) {
            await llmService.initializeWithMode('investigate', provider, modelId, repoFullName);
          } else {
            await llmService.initialize(repoFullName);
          }
        } catch (error: any) {
          getLogger().error({ error }, 'AI: init failed');
          sendEvent({
            error: true,
            userMessage: error.message,
            category: 'deterministic',
            suggestedAction: 'check-config',
            retryAfter: null,
            modelName: modelId || 'AI model',
            code: 'LLM_INIT_ERROR',
          });
          return;
        }

        let aiResponse = '';
        let isJsonResponse = false;
        let totalInvestigationTimeMs = 0;
        try {
          const mode = requestedMode === 'fix' ? 'fix' : 'investigate';
          getLogger().info(`AI: using mode=${mode} (requestedMode=${requestedMode})`);

          const onToolConfirmation = mode === 'fix' ? async () => true : undefined;

          const result = await llmService.processQueryStream(
            message,
            context,
            conversationHistory,
            (chunk) => {
              sendEvent({ type: 'chunk', content: chunk });
            },
            (activity) => {
              sendEvent(activity as AIChatSSEEvent);
            },
            (evidenceEvent) => {
              sendEvent(evidenceEvent);
            },
            onToolConfirmation,
            mode
          );

          aiResponse = result.response;
          isJsonResponse = result.isJson;
          totalInvestigationTimeMs = result.totalInvestigationTimeMs;

          if (!isJsonResponse && aiResponse.includes('"investigation_complete"')) {
            const extracted = extractJsonFromResponse(aiResponse, buildUuid);
            aiResponse = extracted.response;
            isJsonResponse = extracted.isJson;
          }

          if (isJsonResponse) {
            try {
              const parsed = JSON.parse(aiResponse);
              getLogger().info(
                `AI: JSON response type=${parsed.type} hasPullRequest=${!!context.lifecycleContext
                  ?.pullRequest} fullName=${context.lifecycleContext?.pullRequest?.fullName} branch=${
                  context.lifecycleContext?.pullRequest?.branch
                }`
              );
              if (parsed.type === 'investigation_complete' && context.lifecycleContext?.pullRequest) {
                const fullName = context.lifecycleContext.pullRequest.fullName;
                const branch = context.lifecycleContext.pullRequest.branch;
                if (fullName && branch) {
                  const [owner, name] = fullName.split('/');
                  parsed.repository = { owner, name, branch };
                  getLogger().info(`AI: added repository to response owner=${owner} name=${name} branch=${branch}`);

                  const sanitized = sanitizeForJson(parsed);
                  aiResponse = JSON.stringify(sanitized, null, 2);

                  JSON.parse(aiResponse);
                }
              }
            } catch (e) {
              getLogger().error(
                { error: e instanceof Error ? e.message : String(e), responseLength: aiResponse.length },
                'AI: JSON validation failed'
              );
              aiResponse =
                '\u26a0\ufe0f Investigation completed but response formatting failed. Please try asking a more specific question.';
              isJsonResponse = false;
            }

            if (isJsonResponse) {
              sendEvent({ type: 'complete_json', content: aiResponse, totalInvestigationTimeMs });
            }
          }
        } catch (error: any) {
          getLogger().error({ error }, 'AI: query failed');
          const currentModel = modelId || 'AI model';

          if (isBrokenCircuitError(error)) {
            const ctx = { modelName: currentModel, providerName: provider || 'unknown' };
            sendEvent({
              error: true,
              userMessage: getUserErrorMessage(ErrorCategory.TRANSIENT, ctx),
              category: 'transient',
              suggestedAction: 'switch-model',
              retryAfter: null,
              modelName: currentModel,
              code: 'CIRCUIT_BREAKER_OPEN',
            });
          } else {
            const classified = createClassifiedError(provider || 'unknown', error);
            const ctx = {
              modelName: currentModel,
              providerName: classified.providerName,
              retryAfter: classified.retryAfter,
              isAuthError: isAuthError(error),
            };
            sendEvent({
              error: true,
              userMessage: getUserErrorMessage(classified.category, ctx),
              category: classified.category as SSEErrorEvent['category'],
              suggestedAction: getSuggestedAction(classified.category, ctx.isAuthError),
              retryAfter: classified.retryAfter ?? null,
              modelName: currentModel,
              code: 'LLM_API_ERROR',
            });
          }
          return;
        }

        await conversationService.addMessage(buildUuid, {
          role: 'user',
          content: message,
          timestamp: Date.now(),
          isSystemAction,
        });

        await conversationService.addMessage(buildUuid, {
          role: 'assistant',
          content: aiResponse,
          timestamp: Date.now(),
        });

        sendEvent({ type: 'complete', totalInvestigationTimeMs });
      });
    } catch (error: any) {
      getLogger().error({ error }, 'AI: chat request failed');
      sendEvent({
        error: true,
        userMessage: error?.message || 'Internal error',
        category: 'ambiguous',
        suggestedAction: 'retry',
        retryAfter: null,
        modelName: 'AI model',
      });
    } finally {
      try {
        await writer.close();
      } catch {
        // Writer may already be closed by abort handler
      }
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};

export const POST = createStreamHandler(postHandler);
