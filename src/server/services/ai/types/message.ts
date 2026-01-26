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

import { ToolResult } from './tool';

export interface TextPart {
  type: 'text';
  content: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  result: ToolResult;
}

export type MessagePart = TextPart | ToolCallPart | ToolResultPart;

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
}

export function extractTextFromParts(parts: MessagePart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.content;
        case 'tool_call':
          return `[Tool: ${part.name}(${JSON.stringify(part.arguments)})]`;
        case 'tool_result':
          return `[Result: ${part.name} -> ${part.result.agentContent || JSON.stringify(part.result)}]`;
      }
    })
    .join(' ');
}

export function textMessage(role: ConversationMessage['role'], content: string): ConversationMessage {
  return { role, parts: [{ type: 'text', content }] };
}
