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

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { BaseLLMProvider } from './base';
import { ModelInfo, CompletionOptions, StreamChunk, Message } from '../types/provider';
import { Tool, ToolCall } from '../types/tool';
import rootLogger from 'server/lib/logger';

const logger = rootLogger.child({ component: 'GeminiProvider' });

export class GeminiProvider extends BaseLLMProvider {
  name = 'gemini';
  private client: GoogleGenerativeAI;
  private modelId: string;

  constructor(modelId?: string, apiKey?: string) {
    super();
    this.modelId = modelId || 'gemini-2.5-flash';
    const key = this.validateApiKey(apiKey, 'Gemini');
    this.client = new GoogleGenerativeAI(key);
  }

  async *streamCompletion(
    messages: Message[],
    options: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterator<StreamChunk> {
    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    const tools = options.tools?.map((t) => this.formatToolDefinition(t)) as any[] | undefined;

    const model = this.client.getGenerativeModel({
      model: this.modelId,
      systemInstruction: options.systemPrompt,
      tools: tools ? [{ functionDeclarations: tools }] : undefined,
      generationConfig: {
        temperature: options.temperature || 0.1,
        topP: 0.95,
        topK: 20,
        maxOutputTokens: options.maxTokens || 65536,
      },
    });

    const history =
      messages.length > 1
        ? messages.slice(0, -1).flatMap((m) => {
            if (m.role === 'assistant' && m.content.trim().startsWith('[{') && m.content.includes('"toolCall"')) {
              try {
                const toolResults = JSON.parse(m.content);
                if (Array.isArray(toolResults) && toolResults.length > 0 && toolResults[0].toolCall) {
                  const messages: any[] = [];
                  for (const tr of toolResults) {
                    const toolName = tr.toolCall.name.startsWith('default_api:')
                      ? tr.toolCall.name
                      : `default_api:${tr.toolCall.name}`;

                    messages.push({
                      role: 'model' as const,
                      parts: [{ functionCall: { name: toolName, args: tr.toolCall.arguments } }],
                    });

                    let responseContent: string;
                    if (tr.result.success) {
                      responseContent = tr.result.agentContent || JSON.stringify(tr.result);
                      if (typeof responseContent === 'object') {
                        responseContent = JSON.stringify(responseContent);
                      }
                      try {
                        JSON.parse(responseContent);
                      } catch (e) {
                        logger.warn(
                          `Tool response is not valid JSON, sanitizing: ${responseContent.substring(0, 100)}...`
                        );
                        responseContent = JSON.stringify({ content: responseContent });
                      }
                    } else {
                      responseContent = JSON.stringify({
                        error: tr.result.error?.message || 'Tool execution failed',
                        success: false,
                      });
                    }

                    const response = { content: responseContent };

                    messages.push({
                      role: 'function' as const,
                      parts: [{ functionResponse: { name: toolName, response } }],
                    });
                  }
                  return messages;
                }
              } catch (e) {
                logger.warn(`Failed to parse tool results, treating as text: ${e.message}`);
              }
            }
            return [
              {
                role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
                parts: [{ text: m.content }],
              },
            ];
          })
        : [];

    const chat = model.startChat({ history });

    const currentMessage = messages[messages.length - 1]?.content || '';
    const result = await chat.sendMessageStream(currentMessage);

    let accumulatedText = '';
    const functionCalls: any[] = [];
    let lastCandidate: any = null;

    for await (const chunk of result.stream) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const candidate = chunk.candidates?.[0];
      if (!candidate) {
        continue;
      }

      lastCandidate = candidate;

      if (candidate.finishReason === 'STOP' && (!candidate.content?.parts || candidate.content.parts.length === 0)) {
        logger.error(
          `Gemini returned STOP with no content. Safety ratings: ${JSON.stringify(
            candidate.safetyRatings
          )}, full candidate: ${JSON.stringify(candidate)}`
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
            functionCalls.push(part.functionCall);
          }
        }
      }
    }

    const response = await result.response;

    if (accumulatedText.length === 0 && functionCalls.length === 0) {
      let responseText = 'N/A';
      try {
        responseText = (response as any).text();
      } catch (e) {
        responseText = `Error getting text: ${e.message}`;
      }
      logger.error(
        `Gemini returned empty response. Last candidate: ${JSON.stringify(
          lastCandidate
        )}, promptFeedback: ${JSON.stringify((response as any).promptFeedback)}, response.text: ${responseText}`
      );
      logger.error(
        `Full response object keys: ${Object.keys(response)}, candidates: ${JSON.stringify(
          (response as any).candidates
        )}`
      );

      throw new Error(
        `Gemini returned an empty response. This may be due to: ` +
          `(1) The system prompt being too large (${options.systemPrompt?.length || 0} chars), ` +
          `(2) Too many tools (${options.tools?.length || 0}), or ` +
          `(3) Incompatible tool definitions. ` +
          `finishReason: ${lastCandidate?.finishReason}, ` +
          `promptFeedback: ${JSON.stringify((response as any).promptFeedback)}`
      );
    }

    if (functionCalls.length > 0) {
      const toolCalls = this.parseToolCall(functionCalls);
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
      maxTokens: 1000000,
    };
  }

  formatToolDefinition(tool: Tool): unknown {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: tool.parameters.properties || {},
        required: tool.parameters.required || [],
      },
    };
  }

  parseToolCall(content: unknown): ToolCall[] {
    if (!Array.isArray(content)) {
      return [];
    }

    return content.map((fc: any) => {
      let name = fc.name;
      if (name.startsWith('default_api:')) {
        name = name.substring('default_api:'.length);
      }
      return {
        name,
        arguments: fc.args,
      };
    });
  }
}
