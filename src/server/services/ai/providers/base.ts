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

import { LLMProvider, ModelInfo, CompletionOptions, StreamChunk, Message } from '../types/provider';
import { Tool, ToolCall } from '../types/tool';

export abstract class BaseLLMProvider implements LLMProvider {
  abstract name: string;

  abstract streamCompletion(
    messages: Message[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk>;

  abstract supportsTools(): boolean;
  abstract getModelInfo(): ModelInfo;
  abstract formatToolDefinition(tool: Tool): unknown;
  abstract parseToolCall(response: unknown): ToolCall[];

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected buildMessages(messages: Message[], systemPrompt: string): Message[] {
    return [{ role: 'system' as const, content: systemPrompt }, ...messages];
  }

  protected validateApiKey(apiKey: string | undefined, providerName: string): string {
    if (!apiKey) {
      throw new Error(
        `${providerName} API key is required. ` +
          `Please set the appropriate environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or AI_API_KEY).`
      );
    }
    return apiKey;
  }
}
