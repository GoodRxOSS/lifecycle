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
import { BaseLLMProvider } from './base';
import { ModelInfo, CompletionOptions, StreamChunk, Message } from '../types/provider';
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
    messages: Message[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk> {
    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    const anthropicMessages = messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const tools = options.tools?.map((t) => this.formatToolDefinition(t)) as any[] | undefined;

    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: options.maxTokens || 4096,
      system: options.systemPrompt,
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
      .filter((c: any) => c.type === 'tool_use')
      .map((c: any) => ({
        name: c.name,
        arguments: c.input,
        id: c.id,
      }));
  }
}
