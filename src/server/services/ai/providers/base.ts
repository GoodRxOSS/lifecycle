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

import { LLMProvider, ModelInfo, CompletionOptions, StreamChunk } from '../types/provider';
import { ConversationMessage } from '../types/message';
import { Tool, ToolCall } from '../types/tool';
import { countTokens } from '../prompts/tokenCounter';

export abstract class BaseLLMProvider implements LLMProvider {
  abstract name: string;

  abstract streamCompletion(
    messages: ConversationMessage[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk>;

  abstract supportsTools(): boolean;
  abstract getModelInfo(): ModelInfo;
  abstract formatToolDefinition(tool: Tool): unknown;
  abstract parseToolCall(response: unknown): ToolCall[];
  abstract formatHistory(messages: ConversationMessage[]): unknown[];

  estimateTokens(text: string): number {
    return countTokens(text);
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
