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

import AgentRunEvent from 'server/models/AgentRunEvent';
import { type AgentUiMessageChunk } from './streamChunks';
import { readString } from './runEventUtils';

export type ChunkEvent = {
  eventType: string;
  payload: Record<string, unknown>;
};

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};

  for (const key of keys) {
    if (source[key] !== undefined) {
      picked[key] = cloneValue(source[key]);
    }
  }

  return picked;
}

function compactChunk(fields: Record<string, unknown>): AgentUiMessageChunk {
  const chunk: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      chunk[key] = value;
    }
  }

  return chunk as AgentUiMessageChunk;
}

export function toChunkEvents(chunk: AgentUiMessageChunk): ChunkEvent[] {
  const chunkRecord = chunk as unknown as Record<string, unknown>;

  switch (chunk.type) {
    case 'start':
      return [
        {
          eventType: 'message.created',
          payload: {
            messageId: chunk.messageId,
            metadata: chunk.messageMetadata || {},
          },
        },
      ];
    case 'message-metadata':
      return [
        {
          eventType: 'message.metadata',
          payload: {
            metadata: cloneValue(chunk.messageMetadata || {}),
          },
        },
      ];
    case 'text-start':
      return [
        {
          eventType: 'message.part.started',
          payload: {
            partType: 'text',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'text-delta':
      return [
        {
          eventType: 'message.delta',
          payload: {
            partType: 'text',
            partId: chunk.id,
            delta: chunk.delta,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'text-end':
      return [
        {
          eventType: 'message.part.completed',
          payload: {
            partType: 'text',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'reasoning-start':
      return [
        {
          eventType: 'message.part.started',
          payload: {
            partType: 'reasoning',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'reasoning-delta':
      return [
        {
          eventType: 'message.delta',
          payload: {
            partType: 'reasoning',
            partId: chunk.id,
            delta: chunk.delta,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'reasoning-end':
      return [
        {
          eventType: 'message.part.completed',
          payload: {
            partType: 'reasoning',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'tool-input-start':
      return [
        {
          eventType: 'tool.call.input.started',
          payload: {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            ...pickDefined(chunkRecord, ['providerExecuted', 'providerMetadata', 'dynamic', 'title']),
          },
        },
      ];
    case 'tool-input-delta':
      return [
        {
          eventType: 'tool.call.input.delta',
          payload: {
            toolCallId: chunk.toolCallId,
            inputTextDelta: chunk.inputTextDelta,
          },
        },
      ];
    case 'tool-input-available':
    case 'tool-input-error':
      return [
        {
          eventType: 'tool.call.started',
          payload: {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            inputStatus: chunk.type === 'tool-input-error' ? 'error' : 'available',
            input: 'input' in chunk ? chunk.input : null,
            errorText: 'errorText' in chunk ? chunk.errorText : null,
            ...pickDefined(chunkRecord, ['providerExecuted', 'providerMetadata', 'dynamic', 'title']),
          },
        },
      ];
    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
      return [
        {
          eventType: 'tool.call.completed',
          payload: {
            toolCallId: chunk.toolCallId,
            output: 'output' in chunk ? chunk.output : null,
            errorText: 'errorText' in chunk ? chunk.errorText : null,
            status:
              chunk.type === 'tool-output-available'
                ? 'completed'
                : chunk.type === 'tool-output-denied'
                ? 'denied'
                : 'failed',
            ...pickDefined(chunkRecord, ['providerExecuted', 'providerMetadata', 'dynamic', 'preliminary']),
          },
        },
      ];
    case 'tool-approval-request':
      return [
        {
          eventType: 'approval.requested',
          payload: {
            ...pickDefined(chunkRecord, ['actionId']),
            approvalId: chunk.approvalId,
            toolCallId: chunk.toolCallId,
          },
        },
      ];
    case 'data-file-change':
      return [
        {
          eventType: 'tool.file_change',
          payload: {
            id: chunk.id,
            data: cloneValue(chunk.data),
            transient: chunk.transient,
          },
        },
      ];
    case 'source-url':
      return [
        {
          eventType: 'message.source',
          payload: {
            sourceType: 'url',
            sourceId: chunk.sourceId,
            url: chunk.url,
            ...pickDefined(chunkRecord, ['title', 'providerMetadata']),
          },
        },
      ];
    case 'source-document':
      return [
        {
          eventType: 'message.source',
          payload: {
            sourceType: 'document',
            sourceId: chunk.sourceId,
            mediaType: chunk.mediaType,
            title: chunk.title,
            ...pickDefined(chunkRecord, ['filename', 'providerMetadata']),
          },
        },
      ];
    case 'file':
      return [
        {
          eventType: 'message.file',
          payload: {
            url: chunk.url,
            mediaType: chunk.mediaType,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'start-step':
      return [
        {
          eventType: 'run.step.started',
          payload: {},
        },
      ];
    case 'finish-step':
      return [
        {
          eventType: 'run.step.completed',
          payload: {},
        },
      ];
    case 'finish':
      return [
        {
          eventType: 'run.finished',
          payload: {
            finishReason: chunk.finishReason,
            metadata: chunk.messageMetadata || {},
          },
        },
      ];
    case 'abort':
      return [
        {
          eventType: 'run.aborted',
          payload: {
            reason: chunk.reason,
          },
        },
      ];
    case 'error':
      return [
        {
          eventType: 'run.error',
          payload: {
            errorText: chunk.errorText,
          },
        },
      ];
  }

  return [];
}

function chunkFromMessagePartEvent(eventType: string, payload: Record<string, unknown>): AgentUiMessageChunk | null {
  const partType = readString(payload.partType);
  const partId = readString(payload.partId) || readString(payload.messageId);
  if ((partType !== 'text' && partType !== 'reasoning') || !partId) {
    return null;
  }

  const providerMetadata = payload.providerMetadata;

  if (eventType === 'message.part.started') {
    return compactChunk({
      type: partType === 'text' ? 'text-start' : 'reasoning-start',
      id: partId,
      providerMetadata,
    });
  }

  if (eventType === 'message.delta') {
    return compactChunk({
      type: partType === 'text' ? 'text-delta' : 'reasoning-delta',
      id: partId,
      delta: readString(payload.delta) || '',
      providerMetadata,
    });
  }

  if (eventType === 'message.part.completed') {
    return compactChunk({
      type: partType === 'text' ? 'text-end' : 'reasoning-end',
      id: partId,
      providerMetadata,
    });
  }

  return null;
}

function chunkFromToolStartedEvent(payload: Record<string, unknown>): AgentUiMessageChunk | null {
  const toolCallId = readString(payload.toolCallId);
  const toolName = readString(payload.toolName);
  if (!toolCallId || !toolName) {
    return null;
  }

  const inputStatus = readString(payload.inputStatus);
  return compactChunk({
    type: inputStatus === 'error' ? 'tool-input-error' : 'tool-input-available',
    toolCallId,
    toolName,
    input: payload.input,
    errorText: inputStatus === 'error' ? readString(payload.errorText) || 'Tool input failed.' : undefined,
    providerExecuted: readBoolean(payload.providerExecuted),
    providerMetadata: payload.providerMetadata,
    dynamic: readBoolean(payload.dynamic),
    title: readString(payload.title),
  });
}

function chunkFromToolCompletedEvent(payload: Record<string, unknown>): AgentUiMessageChunk | null {
  const toolCallId = readString(payload.toolCallId);
  if (!toolCallId) {
    return null;
  }

  const status = readString(payload.status);
  if (status === 'denied') {
    return compactChunk({
      type: 'tool-output-denied',
      toolCallId,
    });
  }

  if (status === 'failed') {
    return compactChunk({
      type: 'tool-output-error',
      toolCallId,
      errorText: readString(payload.errorText) || 'Tool execution failed.',
      providerExecuted: readBoolean(payload.providerExecuted),
      providerMetadata: payload.providerMetadata,
      dynamic: readBoolean(payload.dynamic),
    });
  }

  return compactChunk({
    type: 'tool-output-available',
    toolCallId,
    output: payload.output,
    providerExecuted: readBoolean(payload.providerExecuted),
    providerMetadata: payload.providerMetadata,
    dynamic: readBoolean(payload.dynamic),
    preliminary: readBoolean(payload.preliminary),
  });
}

export function chunkFromEvent(event: AgentRunEvent): AgentUiMessageChunk | null {
  const payload = asRecord(event.payload);

  switch (event.eventType) {
    case 'message.created':
      return compactChunk({
        type: 'start',
        messageId: readString(payload.messageId),
        messageMetadata: payload.metadata,
      });
    case 'message.metadata':
      return compactChunk({
        type: 'message-metadata',
        messageMetadata: payload.metadata || {},
      });
    case 'message.part.started':
    case 'message.delta':
    case 'message.part.completed':
      return chunkFromMessagePartEvent(event.eventType, payload);
    case 'tool.call.input.started': {
      const toolCallId = readString(payload.toolCallId);
      const toolName = readString(payload.toolName);
      if (!toolCallId || !toolName) {
        return null;
      }

      return compactChunk({
        type: 'tool-input-start',
        toolCallId,
        toolName,
        providerExecuted: readBoolean(payload.providerExecuted),
        providerMetadata: payload.providerMetadata,
        dynamic: readBoolean(payload.dynamic),
        title: readString(payload.title),
      });
    }
    case 'tool.call.input.delta': {
      const toolCallId = readString(payload.toolCallId);
      if (!toolCallId) {
        return null;
      }

      return compactChunk({
        type: 'tool-input-delta',
        toolCallId,
        inputTextDelta: readString(payload.inputTextDelta) || '',
      });
    }
    case 'tool.call.started':
      return chunkFromToolStartedEvent(payload);
    case 'tool.call.completed':
      return chunkFromToolCompletedEvent(payload);
    case 'approval.requested': {
      const approvalId = readString(payload.approvalId);
      const toolCallId = readString(payload.toolCallId);
      if (!approvalId || !toolCallId) {
        return null;
      }

      return compactChunk({
        type: 'tool-approval-request',
        actionId: readString(payload.actionId),
        approvalId,
        toolCallId,
      });
    }
    case 'tool.file_change':
      if (!payload.data) {
        return null;
      }

      return compactChunk({
        type: 'data-file-change',
        id: readString(payload.id),
        data: payload.data,
        transient: readBoolean(payload.transient),
      });
    case 'message.source':
      if (payload.sourceType === 'url') {
        const sourceId = readString(payload.sourceId);
        const url = readString(payload.url);
        if (!sourceId || !url) {
          return null;
        }

        return compactChunk({
          type: 'source-url',
          sourceId,
          url,
          title: readString(payload.title),
          providerMetadata: payload.providerMetadata,
        });
      }

      if (payload.sourceType === 'document') {
        const sourceId = readString(payload.sourceId);
        const mediaType = readString(payload.mediaType);
        const title = readString(payload.title);
        if (!sourceId || !mediaType || !title) {
          return null;
        }

        return compactChunk({
          type: 'source-document',
          sourceId,
          mediaType,
          title,
          filename: readString(payload.filename),
          providerMetadata: payload.providerMetadata,
        });
      }

      return null;
    case 'message.file': {
      const url = readString(payload.url);
      const mediaType = readString(payload.mediaType);
      if (!url || !mediaType) {
        return null;
      }

      return compactChunk({
        type: 'file',
        url,
        mediaType,
        providerMetadata: payload.providerMetadata,
      });
    }
    case 'run.step.started':
      return compactChunk({ type: 'start-step' });
    case 'run.step.completed':
      return compactChunk({ type: 'finish-step' });
    case 'run.finished':
      return compactChunk({
        type: 'finish',
        finishReason: readString(payload.finishReason),
        messageMetadata: payload.metadata,
      });
    case 'run.aborted':
      return compactChunk({
        type: 'abort',
        reason: readString(payload.reason),
      });
    case 'run.error':
      return compactChunk({
        type: 'error',
        errorText: readString(payload.errorText) || 'Agent run failed.',
      });
    case 'run.failed': {
      const error = asRecord(payload.error);
      return compactChunk({
        type: 'error',
        errorText: readString(error.message) || readString(payload.errorText) || 'Agent run failed.',
      });
    }
    default:
      return null;
  }
}
