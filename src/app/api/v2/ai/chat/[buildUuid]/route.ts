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
import { normalizeInvestigationPayload } from 'server/services/ai/utils/normalizePayload';
import { authorizeToolForFixTarget, FixTargetScope } from 'server/services/ai/utils/fixTargetAuthorization';
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
 *       Sends a message to the AI agent and streams the response as Server-Sent Events (SSE).
 *       The buildUuid identifies the ephemeral environment context.
 *
 *
 *       **Streaming protocol:**
 *       The response uses the `text/event-stream` content type. Each event is a JSON object
 *       sent as `data: {JSON}\n\n`. Clients should use the EventSource API or a streaming
 *       fetch with an AbortController. The connection is kept alive via the `Connection: keep-alive`
 *       header. Clients can cancel by aborting the request.
 *
 *
 *       **SSE event types (by `type` field):**
 *
 *       - `chunk` — Streamed text fragment of the AI response. Concatenate all chunks to build
 *         the full response. See SSEChunkEvent schema.
 *
 *       - `tool_call` — The AI is invoking a tool. Contains a `toolCallId` that correlates
 *         with a later `processing` event. See SSEToolCallEvent schema.
 *
 *       - `processing` — A tool call has completed. Messages starting with a checkmark (✓)
 *         indicate success. See SSEProcessingEvent schema.
 *
 *       - `thinking` — The AI is reasoning before producing output. See SSEThinkingEvent schema.
 *
 *       - `error` — A non-fatal processing error during investigation. See SSEActivityErrorEvent schema.
 *
 *       - `evidence_file` — A source file found as evidence. See SSEEvidenceFileEvent schema.
 *
 *       - `evidence_commit` — A git commit found as evidence. See SSEEvidenceCommitEvent schema.
 *
 *       - `evidence_resource` — A Kubernetes resource found as evidence. See SSEEvidenceResourceEvent schema.
 *
 *       - `debug_context` — System prompt and model selection info. See SSEDebugContextEvent schema.
 *
 *       - `debug_tool_call` — Raw tool invocation data. See SSEDebugToolCallEvent schema.
 *
 *       - `debug_tool_result` — Raw tool result data. See SSEDebugToolResultEvent schema.
 *
 *       - `debug_metrics` — Aggregate token/cost metrics. See SSEDebugMetricsEvent schema.
 *
 *       - `complete_json` — Structured JSON response (e.g. investigation_complete).
 *         Sent before the `complete` event. See SSECompleteJsonEvent schema.
 *
 *       - `complete` — Final event signaling end of stream. See SSECompleteEvent schema.
 *
 *
 *       **Error handling:**
 *       Because the HTTP 200 status is committed before streaming begins, errors during
 *       processing are delivered as SSE events with `error: true` instead of HTTP error codes.
 *       See the SSEErrorEvent schema for the error payload format, which includes a `category`
 *       field for classification and a `suggestedAction` field for client retry logic.
 *
 *
 *       **Typical event sequence:**
 *       `chunk*` → `tool_call` → `processing` → `chunk*` → ... → `complete_json`? → `complete`
 *
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
 *                 example: Why is the web service CrashLoopBackOff?
 *               clearHistory:
 *                 type: boolean
 *                 description: Whether to clear conversation history before processing.
 *                 default: false
 *               provider:
 *                 type: string
 *                 description: >
 *                   The LLM provider to use. When omitted the default provider from the
 *                   effective configuration is used.
 *                 example: anthropic
 *               modelId:
 *                 type: string
 *                 description: >
 *                   The specific model ID to use. Must belong to the given provider.
 *                   When omitted the default model is used.
 *                 example: claude-sonnet-4-20250514
 *               isSystemAction:
 *                 type: boolean
 *                 description: >
 *                   Whether this message is a system-initiated action (e.g. automatic
 *                   investigation triggered by a deployment event).
 *                 default: false
 *               mode:
 *                 type: string
 *                 enum: [investigate, fix]
 *                 description: >
 *                   Operation mode. "investigate" (default) is read-only analysis.
 *                   "fix" enables the agent to take corrective actions via tools.
 *                 default: investigate
 *               fixTarget:
 *                 type: object
 *                 description: >
 *                   Optional service-scoped fix target. When provided in fix mode,
 *                   mutating tool calls are constrained to this selected issue.
 *                 properties:
 *                   serviceName:
 *                     type: string
 *                   suggestedFix:
 *                     type: string
 *                   filePath:
 *                     type: string
 *                   files:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         path:
 *                           type: string
 *     responses:
 *       '200':
 *         description: >
 *           SSE event stream. Each line is formatted as `data: {JSON}\n\n`.
 *           Events use a `type` discriminator field — see the SSE event schemas
 *           (SSEChunkEvent, SSEToolCallEvent, SSEProcessingEvent, SSEThinkingEvent,
 *           SSEActivityErrorEvent, SSEEvidenceFileEvent, SSEEvidenceCommitEvent,
 *           SSEEvidenceResourceEvent, SSEDebugContextEvent, SSEDebugToolCallEvent,
 *           SSEDebugToolResultEvent, SSEDebugMetricsEvent, SSECompleteJsonEvent,
 *           SSECompleteEvent). Errors arrive as SSEErrorEvent with `error: true`.
 *         headers:
 *           Content-Type:
 *             schema:
 *               type: string
 *               example: text/event-stream; charset=utf-8
 *           Cache-Control:
 *             schema:
 *               type: string
 *               example: no-cache, no-transform
 *           Connection:
 *             schema:
 *               type: string
 *               example: keep-alive
 *           X-Accel-Buffering:
 *             schema:
 *               type: string
 *               example: 'no'
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               description: >
 *                 Newline-delimited SSE events. Each event is `data: <JSON>\n\n`.
 *             examples:
 *               chunk:
 *                 summary: Text chunk event
 *                 value: 'data: {"type":"chunk","content":"The web service is failing because..."}\n\n'
 *               tool_call:
 *                 summary: Tool invocation event
 *                 value: 'data: {"type":"tool_call","message":"Reading pod logs...","toolCallId":"tc_1"}\n\n'
 *               processing:
 *                 summary: Tool completion event
 *                 value: 'data: {"type":"processing","message":"✓ Pod logs retrieved","toolCallId":"tc_1","details":{"toolDurationMs":1200}}\n\n'
 *               complete:
 *                 summary: Stream completion event
 *                 value: 'data: {"type":"complete","totalInvestigationTimeMs":8500}\n\n'
 *               error:
 *                 summary: Stream error event
 *                 value: 'data: {"error":true,"userMessage":"Rate limit exceeded","category":"rate-limited","suggestedAction":"retry","retryAfter":30,"modelName":"claude-sonnet-4-20250514"}\n\n'
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
  let writerClosed = false;

  const sendEvent = (data: AIChatSSEEvent | SSEErrorEvent) => {
    if (writerClosed) return;
    try {
      writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)).catch(() => {});
    } catch {
      writerClosed = true;
    }
  };

  const MAX_STORED_JSON_LENGTH = 8000;
  const truncateForStorage = (value: unknown): unknown => {
    try {
      const json = JSON.stringify(value);
      if (json.length <= MAX_STORED_JSON_LENGTH) return value;
      return { _truncated: true, preview: json.slice(0, MAX_STORED_JSON_LENGTH), originalLength: json.length };
    } catch {
      return { _truncated: true, preview: '[non-serializable]', originalLength: 0 };
    }
  };

  req.signal.addEventListener('abort', () => {
    writerClosed = true;
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

      const { message, clearHistory, provider, modelId, isSystemAction, mode: requestedMode, fixTarget } = body;

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
        const collectedActivities: Array<{
          type: string;
          message: string;
          status?: 'pending' | 'completed' | 'failed';
          details?: { toolDurationMs?: number; totalDurationMs?: number };
          toolCallId?: string;
          resultPreview?: string;
        }> = [];
        const collectedEvidence: Array<Record<string, unknown>> = [];
        let collectedDebugContext: any = null;
        const collectedDebugToolData = new Map<
          string,
          {
            toolCallId: string;
            toolName: string;
            toolArgs: Record<string, unknown>;
            toolResult?: unknown;
            toolDurationMs?: number;
          }
        >();
        let collectedDebugMetrics: any = null;
        try {
          const mode = requestedMode === 'fix' ? 'fix' : 'investigate';
          getLogger().info(`AI: using mode=${mode} (requestedMode=${requestedMode})`);

          const onToolConfirmation = mode === 'fix' ? async () => true : undefined;
          const onToolAuthorization =
            mode === 'fix' && fixTarget
              ? async (
                  tool: { name: string; description: string; category: string; safetyLevel: string },
                  args: Record<string, unknown>
                ) => authorizeToolForFixTarget(fixTarget as FixTargetScope, { ...tool, args })
              : undefined;

          const result = await llmService.processQueryStream(
            message,
            context,
            conversationHistory,
            (chunk) => {
              sendEvent({ type: 'chunk', content: chunk });
            },
            (activity) => {
              sendEvent(activity as AIChatSSEEvent);
              if (activity.type === 'tool_call') {
                collectedActivities.push({
                  type: activity.type,
                  message: activity.message,
                  status: 'pending',
                  toolCallId: activity.toolCallId,
                });
              } else if (activity.type === 'processing') {
                const isFailed = !activity.message.startsWith('\u2713');
                const matchIdx = collectedActivities.findIndex(
                  (a) => a.status === 'pending' && activity.toolCallId && a.toolCallId === activity.toolCallId
                );
                if (matchIdx !== -1) {
                  collectedActivities[matchIdx] = {
                    ...collectedActivities[matchIdx],
                    message: activity.message,
                    status: isFailed ? 'failed' : 'completed',
                    details: activity.details,
                    toolCallId: activity.toolCallId,
                    resultPreview: activity.resultPreview,
                  };
                } else {
                  collectedActivities.push({
                    type: activity.type,
                    message: activity.message,
                    status: isFailed ? 'failed' : 'completed',
                    details: activity.details,
                    toolCallId: activity.toolCallId,
                    resultPreview: activity.resultPreview,
                  });
                }
              } else {
                collectedActivities.push({ type: activity.type, message: activity.message });
              }
            },
            (evidenceEvent) => {
              sendEvent(evidenceEvent);
              collectedEvidence.push(evidenceEvent as unknown as Record<string, unknown>);
            },
            onToolConfirmation,
            onToolAuthorization,
            mode,
            (event: AIChatSSEEvent) => {
              try {
                sendEvent(event);
              } catch {
                /* SSE send must not block collection */
              }
              try {
                const e = event as any;
                if (e.type === 'debug_context') {
                  collectedDebugContext = {
                    systemPrompt: e.systemPrompt,
                    maskingStats: e.maskingStats,
                    provider: e.provider,
                    modelId: e.modelId,
                  };
                } else if (e.type === 'debug_tool_call') {
                  collectedDebugToolData.set(e.toolCallId, {
                    toolCallId: e.toolCallId,
                    toolName: e.toolName,
                    toolArgs: e.toolArgs,
                  });
                } else if (e.type === 'debug_tool_result') {
                  const existing = collectedDebugToolData.get(e.toolCallId);
                  if (existing) {
                    existing.toolResult = e.toolResult;
                    existing.toolDurationMs = e.toolDurationMs;
                  } else {
                    collectedDebugToolData.set(e.toolCallId, {
                      toolCallId: e.toolCallId,
                      toolName: e.toolName,
                      toolArgs: {},
                      toolResult: e.toolResult,
                      toolDurationMs: e.toolDurationMs,
                    });
                  }
                } else if (e.type === 'debug_metrics') {
                  collectedDebugMetrics = {
                    iterations: e.iterations,
                    totalToolCalls: e.totalToolCalls,
                    totalDurationMs: e.totalDurationMs,
                    inputTokens: e.inputTokens,
                    outputTokens: e.outputTokens,
                    inputCostPerMillion: e.inputCostPerMillion,
                    outputCostPerMillion: e.outputCostPerMillion,
                  };
                }
              } catch {
                /* debug collection must never disrupt the stream */
              }
            }
          );

          aiResponse = result.response;
          isJsonResponse = result.isJson;
          totalInvestigationTimeMs = result.totalInvestigationTimeMs;
          let preambleText: string | undefined = result.preamble;
          let completeJsonEmitted = false;

          if (aiResponse.includes('"investigation_complete"')) {
            const extracted = extractJsonFromResponse(aiResponse, buildUuid);
            if (extracted.isJson) {
              aiResponse = extracted.response;
              isJsonResponse = true;
              if (extracted.preamble && !preambleText) {
                preambleText = extracted.preamble;
              }
            }
          }

          if (isJsonResponse) {
            try {
              let parsed = JSON.parse(aiResponse);
              getLogger().info(
                `AI: JSON response type=${parsed.type} hasPullRequest=${!!context.lifecycleContext
                  ?.pullRequest} fullName=${context.lifecycleContext?.pullRequest?.fullName} branch=${
                  context.lifecycleContext?.pullRequest?.branch
                }`
              );
              if (parsed.type === 'investigation_complete') {
                parsed = normalizeInvestigationPayload(parsed, { availableTools: result.availableTools });

                if (context.lifecycleContext?.pullRequest) {
                  const fullName = context.lifecycleContext.pullRequest.fullName;
                  const branch = context.lifecycleContext.pullRequest.branch;
                  if (fullName && branch) {
                    const [owner, name] = fullName.split('/');
                    parsed.repository = { owner, name, branch };
                    getLogger().info(`AI: added repository to response owner=${owner} name=${name} branch=${branch}`);
                  }
                }

                const sanitized = sanitizeForJson(parsed);
                aiResponse = JSON.stringify(sanitized, null, 2);

                JSON.parse(aiResponse);
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

            if (isJsonResponse && !completeJsonEmitted) {
              completeJsonEmitted = true;
              sendEvent({
                type: 'complete_json',
                content: aiResponse,
                totalInvestigationTimeMs,
                ...(preambleText ? { preamble: preambleText } : {}),
              });
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
          activityHistory: collectedActivities.length > 0 ? collectedActivities : undefined,
          evidenceItems: collectedEvidence.length > 0 ? collectedEvidence : undefined,
          totalInvestigationTimeMs,
          debugContext: collectedDebugContext || undefined,
          debugToolData:
            collectedDebugToolData.size > 0
              ? Array.from(collectedDebugToolData.values()).map((td) => ({
                  ...td,
                  toolArgs: truncateForStorage(td.toolArgs),
                  toolResult: td.toolResult !== undefined ? truncateForStorage(td.toolResult) : undefined,
                }))
              : undefined,
          debugMetrics: collectedDebugMetrics || undefined,
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
      writerClosed = true;
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
