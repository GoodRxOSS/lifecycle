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
import { type ChatCompletionMessageParam, type ChatCompletionTool } from 'openai/resources/chat/completions';
import { BaseLLMProvider } from './base';
import { ModelInfo, CompletionOptions, StreamChunk } from '../types/provider';
import { ConversationMessage, TextPart, ToolCallPart, ToolResultPart } from '../types/message';
import { Tool, ToolCall } from '../types/tool';
import { ErrorCategory } from '../errors';

interface AccumulatedToolCall {
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

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
    messages: ConversationMessage[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk> {
    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    const openaiMessages = [
      { role: 'system' as const, content: options.systemPrompt },
      ...(this.formatHistory(messages) as ChatCompletionMessageParam[]),
    ];

    const tools = options.tools?.map((t) => this.formatToolDefinition(t)) as ChatCompletionTool[] | undefined;

    const stream = await this.client.chat.completions.create({
      model: this.modelId,
      max_tokens: options.maxTokens || 250000,
      stream: true,
      stream_options: { include_usage: true },
      messages: openaiMessages,
      tools: tools || undefined,
    });

    let accumulatedToolCalls: AccumulatedToolCall[] = [];
    let finalUsage: { prompt_tokens: number; completion_tokens: number } | null = null;

    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      if (chunk.usage) {
        finalUsage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
        };
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

    if (finalUsage) {
      yield {
        type: 'text',
        usage: {
          inputTokens: finalUsage.prompt_tokens,
          outputTokens: finalUsage.completion_tokens,
        },
      };
    }
  }

  formatHistory(messages: ConversationMessage[]): unknown[] {
    const result: unknown[] = [];

    for (const msg of messages) {
      const toolCallParts = msg.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      const toolResultParts = msg.parts.filter((p): p is ToolResultPart => p.type === 'tool_result');
      const textParts = msg.parts.filter((p): p is TextPart => p.type === 'text');

      if (msg.role === 'system') {
        const textContent = textParts.map((p) => p.content).join(' ');
        result.push({ role: 'system' as const, content: textContent });
      } else if (toolCallParts.length > 0) {
        result.push({
          role: 'assistant' as const,
          content: null,
          tool_calls: toolCallParts.map((p) => ({
            id: p.toolCallId,
            type: 'function',
            function: { name: p.name, arguments: JSON.stringify(p.arguments) },
          })),
        });
      } else if (toolResultParts.length > 0) {
        for (const p of toolResultParts) {
          result.push({
            role: 'tool' as const,
            tool_call_id: p.toolCallId,
            content: p.result.agentContent || JSON.stringify(p.result),
          });
        }
      } else {
        const textContent = textParts.map((p) => p.content).join(' ');
        result.push({ role: msg.role as 'user' | 'assistant', content: textContent });
      }
    }

    return result;
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

    return content.map((tc: AccumulatedToolCall) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (parseError) {
        const error: Error & { category?: ErrorCategory; retryable?: boolean } = new Error(
          `OpenAI returned malformed tool call arguments for ${tc.function.name}: ${parseError}`
        );
        error.category = ErrorCategory.TRANSIENT;
        error.retryable = true;
        throw error;
      }
      return {
        name: tc.function.name,
        arguments: args,
        id: tc.id,
      };
    });
  }
}
