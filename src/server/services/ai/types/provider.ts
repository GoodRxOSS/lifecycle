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

import { Tool, ToolCall } from './tool';
import { StreamCallbacks } from './stream';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface CompletionOptions {
  systemPrompt: string;
  tools?: Tool[];
  callbacks?: StreamCallbacks;
  maxTokens?: number;
  temperature?: number;
}

export type StreamChunkType = 'text' | 'tool_call' | 'thinking' | 'error';

export interface StreamChunk {
  type: StreamChunkType;
  content?: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
}

export interface ModelInfo {
  model: string;
  maxTokens: number;
}

export interface LLMProvider {
  name: string;

  streamCompletion(messages: Message[], options: CompletionOptions, signal?: AbortSignal): AsyncIterator<StreamChunk>;

  supportsTools(): boolean;
  getModelInfo(): ModelInfo;
  formatToolDefinition(tool: Tool): unknown;
  parseToolCall(response: unknown): ToolCall[];
  estimateTokens(text: string): number;
}
