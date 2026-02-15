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

import { GoogleGenAI, type Candidate, type Content, type FunctionCall, type FunctionDeclaration } from '@google/genai';
import { BaseLLMProvider } from './base';
import { ModelInfo, CompletionOptions, StreamChunk } from '../types/provider';
import { ConversationMessage, TextPart, ToolCallPart, ToolResultPart } from '../types/message';
import { Tool, ToolCall } from '../types/tool';
import { getLogger } from 'server/lib/logger';
import { ErrorCategory } from '../errors';

export class GeminiProvider extends BaseLLMProvider {
  name = 'gemini';
  private client: GoogleGenAI;
  private modelId: string;

  constructor(modelId?: string, apiKey?: string) {
    super();
    this.modelId = modelId || 'gemini-2.5-flash';
    const key = this.validateApiKey(apiKey, 'Gemini');
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async *streamCompletion(
    messages: ConversationMessage[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk> {
    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    const tools = options.tools?.map((t) => this.formatToolDefinition(t)) as FunctionDeclaration[] | undefined;

    if (tools) {
      getLogger().info(`GeminiProvider: sending toolCount=${tools.length} tools=${tools.map((t) => t.name).join(',')}`);
    }

    const history = this.formatHistory(messages.slice(0, -1)) as Content[];

    const isThinkingModel = this.modelId.includes('2.5') || this.modelId.includes('3.');

    const chat = this.client.chats.create({
      model: this.modelId,
      config: {
        systemInstruction: options.systemPrompt,
        tools: tools ? [{ functionDeclarations: tools }] : undefined,
        temperature: options.temperature || 0.1,
        topP: 0.95,
        ...(isThinkingModel ? {} : { topK: 40 }),
        maxOutputTokens: options.maxTokens || 65536,
      },
      history,
    });

    const lastMsg = messages[messages.length - 1];
    const toolResultParts = lastMsg?.parts.filter((p): p is ToolResultPart => p.type === 'tool_result') || [];

    let message: string | Array<{ functionResponse: { name: string; response: Record<string, unknown> } }>;
    if (toolResultParts.length > 0) {
      message = toolResultParts.map((part) => {
        let responseObj: Record<string, unknown>;
        if (part.result.success) {
          const raw = part.result.agentContent || JSON.stringify(part.result);
          try {
            responseObj = JSON.parse(raw);
            if (Array.isArray(responseObj)) {
              responseObj = { items: responseObj };
            }
          } catch {
            responseObj = { content: raw };
          }
        } else {
          responseObj = {
            error: part.result.error?.message || 'Tool execution failed',
            success: false,
          };
        }
        return {
          functionResponse: {
            name: part.name,
            response: responseObj,
          },
        };
      });
    } else {
      message = lastMsg
        ? lastMsg.parts
            .filter((p): p is TextPart => p.type === 'text')
            .map((p) => p.content)
            .join(' ')
        : '';
    }
    const stream = await chat.sendMessageStream({ message });

    let accumulatedText = '';
    const functionCalls: Array<FunctionCall & { thoughtSignature?: string }> = [];
    let lastCandidate: Candidate | null = null;
    let lastRawChunk: any = null;

    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const candidate = chunk.candidates?.[0];
      if (!candidate) {
        continue;
      }

      lastCandidate = candidate;
      lastRawChunk = chunk;

      if (candidate.finishReason === 'STOP' && (!candidate.content?.parts || candidate.content.parts.length === 0)) {
        getLogger().error(
          `GeminiProvider: returned STOP with no content safetyRatings=${JSON.stringify(candidate.safetyRatings)}`
        );
      }

      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if ('text' in part && part.text) {
            accumulatedText += part.text;
            yield {
              type: 'text',
              content: part.text,
            };
          }

          if ('functionCall' in part && part.functionCall) {
            functionCalls.push({
              ...part.functionCall,
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            });
          }
        }
      }
    }

    if (lastCandidate?.finishReason === 'MALFORMED_FUNCTION_CALL') {
      const error: Error & { category?: ErrorCategory; retryable?: boolean } = new Error(
        'Gemini generated a malformed function call. This is a transient model error.'
      );
      error.category = ErrorCategory.TRANSIENT;
      error.retryable = true;
      throw error;
    }

    if (accumulatedText.length === 0 && functionCalls.length === 0) {
      getLogger().error(`GeminiProvider: empty response finishReason=${lastCandidate?.finishReason}`);

      const error = new Error(
        `Gemini returned an empty response. This may be due to: ` +
          `(1) The system prompt being too large (${options.systemPrompt?.length || 0} chars), ` +
          `(2) Too many tools (${options.tools?.length || 0}), or ` +
          `(3) Incompatible tool definitions. ` +
          `finishReason: ${lastCandidate?.finishReason}`
      );
      const categorizedError: Error & { category?: ErrorCategory; retryable?: boolean } = error;
      if (lastCandidate?.finishReason === 'STOP') {
        categorizedError.category = ErrorCategory.AMBIGUOUS;
      } else {
        categorizedError.category = ErrorCategory.TRANSIENT;
      }
      categorizedError.retryable = true;
      throw categorizedError;
    }

    if (functionCalls.length > 0) {
      const toolCalls = this.parseToolCall(functionCalls);
      yield {
        type: 'tool_call',
        toolCalls,
      };
    }

    if (lastRawChunk?.usageMetadata) {
      yield {
        type: 'text',
        usage: {
          inputTokens: lastRawChunk.usageMetadata.promptTokenCount || 0,
          outputTokens: lastRawChunk.usageMetadata.candidatesTokenCount || 0,
        },
      };
    }
  }

  formatHistory(messages: ConversationMessage[]): unknown[] {
    const history: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      const toolCallParts = msg.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      const toolResultParts = msg.parts.filter((p): p is ToolResultPart => p.type === 'tool_result');

      if (toolCallParts.length > 0) {
        history.push({
          role: 'model' as const,
          parts: toolCallParts.map((part) => ({
            functionCall: { name: part.name, args: part.arguments },
            ...(part.metadata?.thoughtSignature ? { thoughtSignature: part.metadata.thoughtSignature as string } : {}),
          })),
        });
      } else if (toolResultParts.length > 0) {
        const responseParts = toolResultParts.map((part) => {
          let responseObj: Record<string, unknown>;
          if (part.result.success) {
            const raw = part.result.agentContent || JSON.stringify(part.result);
            try {
              responseObj = JSON.parse(raw);
              if (Array.isArray(responseObj)) {
                responseObj = { items: responseObj };
              }
            } catch {
              responseObj = { content: raw };
            }
          } else {
            responseObj = {
              error: part.result.error?.message || 'Tool execution failed',
              success: false,
            };
          }
          return { functionResponse: { name: part.name, response: responseObj } };
        });
        history.push({
          role: 'user' as const,
          parts: responseParts,
        });
      } else {
        const textContent = msg.parts
          .filter((p): p is TextPart => p.type === 'text')
          .map((p) => p.content)
          .join(' ');

        history.push({
          role: msg.role === 'assistant' ? ('model' as const) : ('user' as const),
          parts: [{ text: textContent }],
        });
      }
    }

    return history;
  }

  supportsTools(): boolean {
    return true;
  }

  getModelInfo(): ModelInfo {
    return {
      model: this.modelId,
      maxTokens: 1000000,
    };
  }

  formatToolDefinition(tool: Tool): unknown {
    return {
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: {
        type: 'object',
        properties: tool.parameters.properties || {},
        required: tool.parameters.required || [],
      },
    };
  }

  parseToolCall(content: unknown): ToolCall[] {
    if (!Array.isArray(content)) {
      return [];
    }

    return content.map((fc: FunctionCall & { thoughtSignature?: string }) => {
      let name = fc.name || '';
      if (name.startsWith('default_api:')) {
        name = name.substring('default_api:'.length);
      }
      return {
        name,
        arguments: fc.args || {},
        ...(fc.thoughtSignature ? { metadata: { thoughtSignature: fc.thoughtSignature } } : {}),
      };
    });
  }
}
