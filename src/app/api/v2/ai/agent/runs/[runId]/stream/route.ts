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

import { createUIMessageStream, createUIMessageStreamResponse, type ProviderMetadata, type UIMessageChunk } from 'ai';
import { NextRequest } from 'next/server';
import 'server/lib/dependencies';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentMessageStore from 'server/services/agent/MessageStore';
import AgentRunService from 'server/services/agent/RunService';
import AgentStreamBroker from 'server/services/agent/StreamBroker';
import { sanitizeAgentRunStreamChunks } from 'server/services/agent/streamState';
import type { AgentUIDataParts, AgentUIMessage } from 'server/services/agent/types';

type AgentUiMessageChunk = UIMessageChunk<AgentUIMessage['metadata'], AgentUIDataParts>;
const STREAM_POLL_INTERVAL_MS = 300;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function getStoredChunks(run: { streamState?: Record<string, unknown> | null }): AgentUiMessageChunk[] {
  const streamState = run.streamState || {};
  const rawChunks = Array.isArray(streamState.chunks) ? streamState.chunks : [];

  return sanitizeAgentRunStreamChunks(rawChunks as AgentUiMessageChunk[]);
}

function buildDurableReplayStream(runId: string, originalMessages: AgentUIMessage[]): ReadableStream<UIMessageChunk> {
  const stream = createUIMessageStream<AgentUIMessage>({
    execute: async ({ writer }) => {
      let emittedCount = 0;
      let shouldContinue = true;

      while (shouldContinue) {
        const currentRun = await AgentRunService.getRunByUuid(runId);
        if (!currentRun) {
          return;
        }

        const storedChunks = getStoredChunks(currentRun);
        while (emittedCount < storedChunks.length) {
          writer.write(storedChunks[emittedCount] as Parameters<typeof writer.write>[0]);
          emittedCount += 1;
        }

        shouldContinue = currentRun.status === 'running';
        if (!shouldContinue) {
          return;
        }

        await sleep(STREAM_POLL_INTERVAL_MS);
      }
    },
    originalMessages,
  });

  return stream as ReadableStream<UIMessageChunk>;
}

function buildStoredChunkReplayStream(
  originalMessages: AgentUIMessage[],
  chunks: AgentUiMessageChunk[]
): ReadableStream<UIMessageChunk> {
  const stream = createUIMessageStream<AgentUIMessage>({
    originalMessages,
    execute: ({ writer }) => {
      for (const chunk of chunks) {
        writer.write(chunk as Parameters<typeof writer.write>[0]);
      }
    },
  });

  return stream as ReadableStream<UIMessageChunk>;
}

function replayTextPart(chunks: AgentUiMessageChunk[], part: Record<string, unknown>, id: string): void {
  chunks.push({
    type: 'text-start',
    id,
    providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
  });
  chunks.push({
    type: 'text-delta',
    id,
    delta: typeof part.text === 'string' ? part.text : '',
    providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
  });
  chunks.push({
    type: 'text-end',
    id,
    providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
  });
}

function replayReasoningPart(chunks: AgentUiMessageChunk[], part: Record<string, unknown>, id: string): void {
  chunks.push({
    type: 'reasoning-start',
    id,
    providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
  });
  chunks.push({
    type: 'reasoning-delta',
    id,
    delta: typeof part.text === 'string' ? part.text : '',
    providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
  });
  chunks.push({
    type: 'reasoning-end',
    id,
    providerMetadata: part.providerMetadata as ProviderMetadata | undefined,
  });
}

function replayToolPart(chunks: AgentUiMessageChunk[], part: Record<string, unknown>): void {
  const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : null;
  if (!toolCallId) {
    return;
  }

  const toolName =
    typeof part.toolName === 'string'
      ? part.toolName
      : typeof part.type === 'string' && part.type.startsWith('tool-')
      ? part.type.replace(/^tool-/, '')
      : 'unknown';
  const input = 'input' in part ? part.input : null;
  const providerMetadata = part.callProviderMetadata as ProviderMetadata | undefined;
  const resultProviderMetadata = part.resultProviderMetadata as ProviderMetadata | undefined;
  const dynamic = part.type === 'dynamic-tool';
  const title = typeof part.title === 'string' ? part.title : undefined;

  if (part.state === 'output-error') {
    chunks.push({
      type: 'tool-input-error',
      toolCallId,
      toolName,
      input: input ?? part.rawInput ?? null,
      errorText: typeof part.errorText === 'string' ? part.errorText : 'Tool execution failed.',
      providerExecuted: part.providerExecuted === true,
      providerMetadata,
      dynamic,
      title,
    });
  } else if (part.state !== 'input-streaming') {
    chunks.push({
      type: 'tool-input-available',
      toolCallId,
      toolName,
      input,
      providerExecuted: part.providerExecuted === true,
      providerMetadata,
      dynamic,
      title,
    });
  }

  const approval = part.approval as { id?: string } | undefined;
  if (part.state === 'approval-requested' && approval?.id) {
    chunks.push({
      type: 'tool-approval-request',
      approvalId: approval.id,
      toolCallId,
    });
  }

  switch (part.state) {
    case 'output-available':
      chunks.push({
        type: 'tool-output-available',
        toolCallId,
        output: part.output,
        providerExecuted: part.providerExecuted === true,
        providerMetadata: resultProviderMetadata,
        dynamic,
        preliminary: part.preliminary === true,
      });
      break;
    case 'output-error':
      chunks.push({
        type: 'tool-output-error',
        toolCallId,
        errorText: typeof part.errorText === 'string' ? part.errorText : 'Tool execution failed.',
        providerExecuted: part.providerExecuted === true,
        providerMetadata: resultProviderMetadata,
        dynamic,
      });
      break;
    case 'output-denied':
      chunks.push({
        type: 'tool-output-denied',
        toolCallId,
      });
      break;
    default:
      break;
  }
}

function buildReplayChunks(message: AgentUIMessage, finishReason?: string | null): AgentUiMessageChunk[] {
  const chunks: AgentUiMessageChunk[] = [
    {
      type: 'start',
      messageId: message.id,
      messageMetadata: message.metadata,
    },
  ];

  for (const [index, rawPart] of (message.parts || []).entries()) {
    if (!rawPart || typeof rawPart !== 'object') {
      continue;
    }

    const part = rawPart as Record<string, unknown>;
    const partType = typeof part.type === 'string' ? part.type : '';

    switch (partType) {
      case 'step-start':
        chunks.push({ type: 'start-step' });
        break;
      case 'text':
        replayTextPart(chunks, part, `${message.id}-text-${index}`);
        break;
      case 'reasoning':
        replayReasoningPart(chunks, part, `${message.id}-reasoning-${index}`);
        break;
      case 'source-url':
      case 'source-document':
      case 'file':
        chunks.push(part as unknown as AgentUiMessageChunk);
        break;
      case 'dynamic-tool':
        replayToolPart(chunks, part);
        break;
      default:
        if (partType.startsWith('tool-')) {
          replayToolPart(chunks, part);
          break;
        }

        if (partType.startsWith('data-')) {
          chunks.push(part as unknown as AgentUiMessageChunk);
        }
        break;
    }
  }

  chunks.push({
    type: 'finish',
    finishReason:
      (finishReason as 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other' | undefined) ||
      undefined,
    messageMetadata: message.metadata,
  });

  return sanitizeAgentRunStreamChunks(chunks);
}

/**
 * @openapi
 * /api/v2/ai/agent/runs/{runId}/stream:
 *   get:
 *     summary: Reconnect to an agent run stream or replay the latest persisted assistant message
 *     tags:
 *       - Agent Sessions
 *     operationId: reconnectAgentRunStream
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: UI message stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       '204':
 *         description: No active or replayable stream is available for this run.
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { runId: string } }): Promise<Response> => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return new Response('Unauthorized', { status: 401 });
  }

  let run;
  try {
    run = await AgentRunService.getOwnedRun(params.runId, userIdentity.userId);
  } catch (error) {
    if (AgentRunService.isRunNotFoundError(error)) {
      return new Response(null, { status: 204 });
    }

    throw error;
  }

  const activeStream = AgentStreamBroker.open(run.uuid);
  if (activeStream) {
    return createUIMessageStreamResponse({
      stream: activeStream,
    });
  }

  const messages = await AgentMessageStore.listRunMessages(params.runId, userIdentity.userId);
  if (run.status === 'running' && getStoredChunks(run).length > 0) {
    return createUIMessageStreamResponse({
      stream: buildDurableReplayStream(run.uuid, messages),
    });
  }

  const replayMessage = [...messages].reverse().find((message) => message.role === 'assistant');

  if (!replayMessage) {
    const storedChunks = getStoredChunks(run);
    if (storedChunks.length === 0) {
      return new Response(null, { status: 204 });
    }

    return createUIMessageStreamResponse({
      stream: buildStoredChunkReplayStream(messages, storedChunks),
    });
  }

  const chunks = buildReplayChunks(
    replayMessage,
    typeof run.streamState?.finishReason === 'string' ? run.streamState.finishReason : null
  );
  const stream = createUIMessageStream<AgentUIMessage>({
    execute: ({ writer }) => {
      for (const chunk of chunks) {
        writer.write(chunk as Parameters<typeof writer.write>[0]);
      }
    },
    originalMessages: messages,
  });

  return createUIMessageStreamResponse({
    stream: stream as ReadableStream<UIMessageChunk>,
  });
};

export const GET = getHandler;
