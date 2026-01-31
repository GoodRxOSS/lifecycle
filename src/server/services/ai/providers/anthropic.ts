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

import Anthropic from '@anthropic-ai/sdk';
import {
  type MessageParam,
  type Tool as AnthropicTool,
  type ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { BaseLLMProvider } from './base';
import { ModelInfo, CompletionOptions, StreamChunk } from '../types/provider';
import { ConversationMessage, TextPart, ToolCallPart, ToolResultPart } from '../types/message';
import { Tool, ToolCall } from '../types/tool';

export class AnthropicProvider extends BaseLLMProvider {
  name = 'anthropic';
  private client: Anthropic;
  private modelId: string;

  constructor(modelId?: string, apiKey?: string) {
    super();
    this.modelId = modelId || 'claude-sonnet-4-5-20250929';
    const key = this.validateApiKey(apiKey, 'Anthropic');
    this.client = new Anthropic({ apiKey: key });
  }

  async *streamCompletion(
    messages: ConversationMessage[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk> {
    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    const anthropicMessages = this.formatHistory(messages) as MessageParam[];

    const tools = options.tools?.map((t) => this.formatToolDefinition(t)) as AnthropicTool[] | undefined;

    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: options.maxTokens || 4096,
      system: options.systemPrompt
        ? [{ type: 'text' as const, text: options.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
        : undefined,
      messages: anthropicMessages,
      tools: tools || [],
    });

    const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
    const textBlocks = response.content.filter((block) => block.type === 'text');

    for (const block of textBlocks) {
      if ('text' in block && block.text) {
        yield {
          type: 'text',
          content: block.text,
        };
      }
    }

    if (toolUseBlocks.length > 0) {
      const toolCalls = this.parseToolCall(toolUseBlocks);
      yield {
        type: 'tool_call',
        toolCalls,
      };
    }
  }

  formatHistory(messages: ConversationMessage[]): unknown[] {
    const result: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      const toolCallParts = msg.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      const toolResultParts = msg.parts.filter((p): p is ToolResultPart => p.type === 'tool_result');
      const textParts = msg.parts.filter((p): p is TextPart => p.type === 'text');

      if (toolCallParts.length > 0) {
        result.push({
          role: 'assistant' as const,
          content: toolCallParts.map((p) => ({
            type: 'tool_use',
            id: p.toolCallId,
            name: p.name,
            input: p.arguments,
          })),
        });
      } else if (toolResultParts.length > 0) {
        result.push({
          role: 'user' as const,
          content: toolResultParts.map((p) => ({
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            content: p.result.agentContent || JSON.stringify(p.result),
          })),
        });
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
      maxTokens: 200000,
    };
  }

  formatToolDefinition(tool: Tool): unknown {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    };
  }

  parseToolCall(content: unknown): ToolCall[] {
    if (!Array.isArray(content)) {
      return [];
    }

    return content
      .filter((c: ToolUseBlock) => c.type === 'tool_use')
      .map((c: ToolUseBlock) => ({
        name: c.name,
        arguments: c.input as Record<string, unknown>,
        id: c.id,
      }));
  }
}
