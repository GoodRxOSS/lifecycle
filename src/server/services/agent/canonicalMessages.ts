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

import { v4 as uuid } from 'uuid';
import type { AgentUIMessage } from './types';

export type CanonicalAgentMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'file_ref'; path?: string | null; url?: string | null; mediaType?: string | null; title?: string | null }
  | { type: 'source_ref'; url?: string | null; title?: string | null; sourceType?: string | null };

export type CanonicalAgentInputMessage = {
  id?: string;
  clientMessageId?: string | null;
  role: 'user' | 'assistant' | 'system';
  parts: CanonicalAgentMessagePart[];
};

export type CanonicalAgentRunMessageInput = {
  clientMessageId?: string | null;
  parts: CanonicalAgentMessagePart[];
};

export type CanonicalAgentMessage = {
  id: string;
  clientMessageId: string | null;
  threadId: string;
  runId: string | null;
  role: 'user' | 'assistant';
  parts: CanonicalAgentMessagePart[];
  createdAt: string | null;
};

export type AgentRunRuntimeOptions = {
  maxIterations?: number;
};

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function normalizeCanonicalAgentMessagePart(value: unknown): CanonicalAgentMessagePart | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const part = value as Record<string, unknown>;
  switch (part.type) {
    case 'text': {
      const text = normalizeText(part.text);
      return text ? { type: 'text', text } : null;
    }
    case 'reasoning': {
      const text = normalizeText(part.text);
      return text ? { type: 'reasoning', text } : null;
    }
    case 'file_ref': {
      const path = normalizeText(part.path);
      const url = normalizeText(part.url);
      if (!path && !url) {
        return null;
      }

      return {
        type: 'file_ref',
        path,
        url,
        mediaType: normalizeText(part.mediaType),
        title: normalizeText(part.title),
      };
    }
    case 'source_ref': {
      const url = normalizeText(part.url);
      const title = normalizeText(part.title);
      if (!url && !title) {
        return null;
      }

      return {
        type: 'source_ref',
        url,
        title,
        sourceType: normalizeText(part.sourceType),
      };
    }
    default:
      return null;
  }
}

export function isCanonicalAgentMessagePart(value: unknown): value is CanonicalAgentMessagePart {
  return normalizeCanonicalAgentMessagePart(value) !== null;
}

export function normalizeCanonicalAgentMessageParts(value: unknown): CanonicalAgentMessagePart[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parts: CanonicalAgentMessagePart[] = [];
  for (const part of value) {
    pushPart(parts, normalizeCanonicalAgentMessagePart(part));
  }

  return parts;
}

function pushPart(parts: CanonicalAgentMessagePart[], part: CanonicalAgentMessagePart | null): void {
  if (part) {
    parts.push(part);
  }
}

export function getCanonicalPartsFromUiMessage(message: AgentUIMessage): CanonicalAgentMessagePart[] {
  const parts: CanonicalAgentMessagePart[] = [];

  for (const rawPart of message.parts || []) {
    if (!rawPart || typeof rawPart !== 'object') {
      continue;
    }

    const part = rawPart as Record<string, unknown>;
    const partType = typeof part.type === 'string' ? part.type : '';

    if (partType === 'text') {
      pushPart(
        parts,
        (() => {
          const text = normalizeText(part.text);
          return text ? { type: 'text', text } : null;
        })()
      );
      continue;
    }

    if (partType === 'reasoning') {
      pushPart(
        parts,
        (() => {
          const text = normalizeText(part.text);
          return text ? { type: 'reasoning', text } : null;
        })()
      );
      continue;
    }

    if (partType === 'file') {
      pushPart(
        parts,
        normalizeCanonicalAgentMessagePart({
          type: 'file_ref',
          path: normalizeText(part.filename) || normalizeText(part.path),
          url: normalizeText(part.url),
          mediaType: normalizeText(part.mediaType),
          title: normalizeText(part.filename) || normalizeText(part.title),
        })
      );
      continue;
    }

    if (partType === 'source-url' || partType === 'source-document') {
      pushPart(
        parts,
        normalizeCanonicalAgentMessagePart({
          type: 'source_ref',
          url: normalizeText(part.url),
          title: normalizeText(part.title),
          sourceType: partType === 'source-document' ? 'document' : 'url',
        })
      );
    }
  }

  return parts;
}

export function toUiMessageFromCanonicalInput(
  message: CanonicalAgentInputMessage,
  metadata?: Record<string, unknown>
): AgentUIMessage {
  const parts = [] as AgentUIMessage['parts'];

  for (const part of message.parts) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text } as AgentUIMessage['parts'][number]);
      continue;
    }

    if (part.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: part.text } as AgentUIMessage['parts'][number]);
      continue;
    }

    if (part.type === 'file_ref') {
      parts.push({
        type: 'file',
        ...(part.path ? { path: part.path, filename: part.title || part.path } : {}),
        ...(part.url ? { url: part.url } : {}),
        ...(part.mediaType ? { mediaType: part.mediaType } : {}),
      } as AgentUIMessage['parts'][number]);
      continue;
    }

    parts.push({
      type: part.sourceType === 'document' ? 'source-document' : 'source-url',
      ...(part.url ? { url: part.url } : {}),
      ...(part.title ? { title: part.title } : {}),
    } as AgentUIMessage['parts'][number]);
  }

  return {
    id: typeof message.id === 'string' && message.id.trim() ? message.id : uuid(),
    role: message.role,
    parts,
    metadata: metadata || {},
  } as AgentUIMessage;
}
