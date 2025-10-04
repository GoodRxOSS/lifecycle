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

import OpenAI from 'openai';
import { BaseLLMProvider } from './base';
import { ModelInfo, CompletionOptions, StreamChunk, Message } from '../types/provider';
import { Tool, ToolCall } from '../types/tool';

export class OpenAIProvider extends BaseLLMProvider {
  name = 'openai';
  private client: OpenAI;
  private modelId: string;

  constructor(modelId?: string, apiKey?: string) {
    super();
    this.modelId = modelId || 'gpt-4o';
    const key = this.validateApiKey(apiKey, 'OpenAI');
    this.client = new OpenAI({ apiKey: key });
  }

  async *streamCompletion(
    messages: Message[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk> {
    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    const openaiMessages = [
      { role: 'system' as const, content: options.systemPrompt },
      ...messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      })),
    ];

    const tools = options.tools?.map((t) => this.formatToolDefinition(t)) as any[] | undefined;

    const stream = await this.client.chat.completions.create({
      model: this.modelId,
      max_tokens: options.maxTokens || 250000,
      stream: true,
      messages: openaiMessages,
      tools: tools || undefined,
    });

    let accumulatedToolCalls: any[] = [];

    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield {
          type: 'text',
          content: delta.content,
        };
      }

      if (delta?.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          if (!accumulatedToolCalls[toolCallDelta.index]) {
            accumulatedToolCalls[toolCallDelta.index] = {
              id: toolCallDelta.id,
              type: toolCallDelta.type,
              function: {
                name: toolCallDelta.function?.name || '',
                arguments: toolCallDelta.function?.arguments || '',
              },
            };
          } else {
            if (toolCallDelta.function?.name) {
              accumulatedToolCalls[toolCallDelta.index].function.name += toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              accumulatedToolCalls[toolCallDelta.index].function.arguments += toolCallDelta.function.arguments;
            }
          }
        }
      }
    }

    if (accumulatedToolCalls.length > 0) {
      const toolCalls = this.parseToolCall(accumulatedToolCalls);
      yield {
        type: 'tool_call',
        toolCalls,
      };
    }
  }

  supportsTools(): boolean {
    return true;
  }

  getModelInfo(): ModelInfo {
    return {
      model: this.modelId,
      maxTokens: 128000,
    };
  }

  formatToolDefinition(tool: Tool): unknown {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  parseToolCall(content: unknown): ToolCall[] {
    if (!Array.isArray(content)) {
      return [];
    }

    return content.map((tc: any) => ({
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
      id: tc.id,
    }));
  }
}
