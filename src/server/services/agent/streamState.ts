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

import type { UIMessageChunk } from 'ai';
import type { AgentUIDataParts, AgentUIMessageMetadata } from './types';

export type AgentUiMessageChunk = UIMessageChunk<AgentUIMessageMetadata, AgentUIDataParts>;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripFileChangesFromJsonText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed) || !Array.isArray(parsed.fileChanges)) {
      return text;
    }

    const next = { ...parsed };
    delete next.fileChanges;
    return JSON.stringify(next, null, 2);
  } catch {
    return text;
  }
}

function sanitizeToolOutputContentItem(item: unknown): unknown {
  if (!isRecord(item)) {
    return item;
  }

  let changed = false;
  const nextItem: Record<string, unknown> = { ...item };

  if (Array.isArray(nextItem.fileChanges)) {
    delete nextItem.fileChanges;
    changed = true;
  }

  if (typeof nextItem.text === 'string') {
    const sanitizedText = stripFileChangesFromJsonText(nextItem.text);
    if (sanitizedText !== nextItem.text) {
      nextItem.text = sanitizedText;
      changed = true;
    }
  }

  return changed ? nextItem : item;
}

function sanitizeToolOutput(output: unknown): unknown {
  if (!isRecord(output)) {
    return output;
  }

  let changed = false;
  const nextOutput: Record<string, unknown> = { ...output };

  if (Array.isArray(nextOutput.fileChanges)) {
    delete nextOutput.fileChanges;
    changed = true;
  }

  if (Array.isArray(nextOutput.content)) {
    const nextContent = nextOutput.content.map((item) => sanitizeToolOutputContentItem(item));
    if (nextContent.some((item, index) => item !== nextOutput.content?.[index])) {
      nextOutput.content = nextContent;
      changed = true;
    }
  }

  return changed ? nextOutput : output;
}

function getCanonicalFileChangeToolCallIds(chunks: AgentUiMessageChunk[]): Set<string> {
  const toolCallIds = new Set<string>();

  for (const chunk of chunks) {
    if (!isRecord(chunk) || chunk.type !== 'data-file-change' || !isRecord(chunk.data)) {
      continue;
    }

    if (typeof chunk.data.toolCallId === 'string' && chunk.data.toolCallId.trim()) {
      toolCallIds.add(chunk.data.toolCallId);
    }
  }

  return toolCallIds;
}

export function sanitizeAgentRunStreamChunks(chunks: AgentUiMessageChunk[]): AgentUiMessageChunk[] {
  if (!chunks.length) {
    return [];
  }

  const canonicalFileChangeToolCallIds = getCanonicalFileChangeToolCallIds(chunks);
  if (canonicalFileChangeToolCallIds.size === 0) {
    return chunks.map((chunk) => cloneValue(chunk));
  }

  return chunks.map((rawChunk) => {
    const chunk = cloneValue(rawChunk);
    if (!isRecord(chunk) || chunk.type !== 'tool-output-available') {
      return chunk;
    }

    if (typeof chunk.toolCallId !== 'string' || !canonicalFileChangeToolCallIds.has(chunk.toolCallId)) {
      return chunk;
    }

    const sanitizedOutput = sanitizeToolOutput(chunk.output);
    if (sanitizedOutput === chunk.output) {
      return chunk;
    }

    return {
      ...chunk,
      output: sanitizedOutput,
    } as AgentUiMessageChunk;
  });
}

export function sanitizeAgentRunStreamState(streamState?: Record<string, unknown> | null): Record<string, unknown> {
  if (!streamState || typeof streamState !== 'object') {
    return {};
  }

  const nextState = cloneValue(streamState);
  const rawChunks = Array.isArray(nextState.chunks) ? nextState.chunks : [];
  const sanitizedChunks = sanitizeAgentRunStreamChunks(rawChunks as AgentUiMessageChunk[]);

  if (sanitizedChunks.length > 0) {
    nextState.chunks = sanitizedChunks;
  }

  const finishChunk = sanitizedChunks.find((chunk) => isRecord(chunk) && chunk.type === 'finish');
  if (
    typeof nextState.finishReason === 'string' &&
    isRecord(finishChunk) &&
    finishChunk.finishReason === nextState.finishReason
  ) {
    delete nextState.finishReason;
  }

  return nextState;
}
