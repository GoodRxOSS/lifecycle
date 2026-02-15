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

import crypto from 'crypto';
import { LLMProvider, StreamChunk } from '../types/provider';
import { Tool, ToolCall } from '../types/tool';
import { StreamCallbacks } from '../types/stream';
import { ToolRegistry } from '../tools/registry';
import { ToolSafetyManager } from './safety';
import { LoopDetector } from './loopProtection';
import { getLogger } from 'server/lib/logger';
import { RetryBudget, createClassifiedError, ErrorCategory } from '../errors';
import type { ClassifiedError } from '../errors';
import { createProviderPolicy } from '../resilience';
import { isBrokenCircuitError } from 'cockatiel';
import { ConversationMessage, ToolCallPart, ToolResultPart } from '../types/message';

export interface OrchestrationResult {
  success: boolean;
  response?: string;
  error?: string;
  cancelled?: boolean;
  classifiedError?: ClassifiedError;
  metrics: {
    iterations: number;
    toolCalls: number;
    duration: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export class ToolOrchestrator {
  private loopDetector: LoopDetector;

  constructor(private toolRegistry: ToolRegistry, private safetyManager: ToolSafetyManager) {
    this.loopDetector = new LoopDetector();
  }

  async executeToolLoop(
    provider: LLMProvider,
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: Tool[],
    callbacks: StreamCallbacks,
    signal: AbortSignal,
    buildUuid?: string
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    let iteration = 0;
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let fullResponse = '';
    const protection = this.loopDetector.getProtection();

    this.loopDetector.reset();

    const retryBudget = new RetryBudget(10);
    const policy = createProviderPolicy(provider.name, retryBudget);

    while (iteration < protection.maxIterations) {
      if (signal.aborted) {
        return {
          success: false,
          error: 'Operation cancelled by user',
          cancelled: true,
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime, totalInputTokens, totalOutputTokens),
        };
      }

      iteration++;

      const iterationStartTime = Date.now();
      const chunks: StreamChunk[] = [];
      try {
        await policy.execute(async () => {
          chunks.length = 0;
          for await (const chunk of provider.streamCompletion(messages, { systemPrompt, tools, callbacks }, signal)) {
            chunks.push(chunk);

            if (chunk.type === 'text' && chunk.content) {
              fullResponse += chunk.content;
              callbacks.onTextChunk(chunk.content);
            }
          }
        });
      } catch (error: any) {
        if (isBrokenCircuitError(error)) {
          getLogger().warn(
            `AI: circuit breaker rejected request provider=${provider.name} buildUuid=${buildUuid || 'none'}`
          );
          const classified: ClassifiedError = {
            category: ErrorCategory.TRANSIENT,
            original: error instanceof Error ? error : new Error(String(error)),
            retryable: true,
            providerName: provider.name,
            retryAfter: null,
          };
          return {
            success: false,
            error: 'Provider circuit breaker is open',
            classifiedError: classified,
            metrics: this.buildMetrics(iteration, totalToolCalls, startTime, totalInputTokens, totalOutputTokens),
          };
        }

        const hasPartialResults = fullResponse.length > 0 || chunks.length > 0;

        if (hasPartialResults) {
          getLogger().warn(
            `AI: stream error with partial results, preserving partialTextLen=${fullResponse.length} chunkCount=${
              chunks.length
            } buildUuid=${buildUuid || 'none'} error=${error.message}`
          );
          return {
            success: true,
            response: fullResponse || 'The response was interrupted. Here is what was generated before the error.',
            error: `Stream interrupted: ${error.message}`,
            classifiedError: createClassifiedError(provider.name, error),
            metrics: this.buildMetrics(iteration, totalToolCalls, startTime, totalInputTokens, totalOutputTokens),
          };
        }

        getLogger().error(
          `AI: stream error buildUuid=${buildUuid || 'none'} error=${error.message} budgetUsed=${retryBudget.used}`
        );
        return {
          success: false,
          error: error.message || 'Provider error',
          classifiedError: createClassifiedError(provider.name, error),
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime, totalInputTokens, totalOutputTokens),
        };
      }

      const usageChunk = chunks.find((c) => c.usage);
      if (usageChunk?.usage) {
        totalInputTokens += usageChunk.usage.inputTokens;
        totalOutputTokens += usageChunk.usage.outputTokens;
      }

      const llmThinkTime = Date.now() - iterationStartTime;
      const toolCalls = this.extractToolCalls(chunks);

      if (toolCalls.length === 0) {
        return {
          success: true,
          response: fullResponse,
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime, totalInputTokens, totalOutputTokens),
        };
      }

      totalToolCalls += toolCalls.length;
      if (totalToolCalls > protection.maxToolCalls) {
        getLogger().warn(
          `AI: tool call limit exceeded totalToolCalls=${totalToolCalls} maxToolCalls=${
            protection.maxToolCalls
          } buildUuid=${buildUuid || 'none'}`
        );
        return {
          success: false,
          error:
            `Tool call limit exceeded (${protection.maxToolCalls}). ` +
            `The investigation is too broad. Try asking about specific services.`,
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime, totalInputTokens, totalOutputTokens),
        };
      }

      const toolCallParts: ToolCallPart[] = toolCalls.map((tc) => ({
        type: 'tool_call' as const,
        toolCallId: tc.id || crypto.randomBytes(16).toString('hex'),
        name: tc.name,
        arguments: tc.arguments,
        ...(tc.metadata ? { metadata: tc.metadata } : {}),
      }));

      messages.push({
        role: 'assistant',
        parts: toolCallParts,
      });

      const toolResultParts: ToolResultPart[] = new Array(toolCalls.length);

      const loopDetectedIndices = new Set<number>();
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const repeatCount = this.loopDetector.countRepeatedCalls(toolCall.name, toolCall.arguments, iteration);

        if (repeatCount >= protection.maxRepeatedCalls) {
          const loopError = {
            success: false,
            error: {
              message:
                `This tool has been called ${repeatCount} times with the same arguments. ` +
                `This suggests a loop. Please try a different approach.`,
              code: 'LOOP_DETECTED',
              recoverable: false,
              suggestedAction: this.loopDetector.getLoopHint(toolCall.name, toolCall.arguments),
            },
          };

          toolResultParts[i] = {
            type: 'tool_result' as const,
            toolCallId: toolCallParts[i].toolCallId,
            name: toolCall.name,
            result: loopError,
          };

          const totalDuration = i === 0 ? llmThinkTime : 0;
          callbacks.onToolResult(
            loopError,
            toolCall.name,
            toolCall.arguments,
            0,
            totalDuration,
            toolCallParts[i].toolCallId
          );

          console.warn(`[Loop Detection] ${toolCall.name} called ${repeatCount} times`, {
            args: toolCall.arguments,
            iteration,
          });

          loopDetectedIndices.add(i);
        }
      }

      const executeIndices = toolCalls.map((_, i) => i).filter((i) => !loopDetectedIndices.has(i));

      for (const i of executeIndices) {
        this.loopDetector.recordCall(toolCalls[i].name, toolCalls[i].arguments, iteration);
        callbacks.onToolCall(toolCalls[i].name, toolCalls[i].arguments, toolCallParts[i].toolCallId);
      }

      getLogger().info(
        `AI: executing tools=[${executeIndices
          .map((i) => toolCalls[i].name)
          .join(',')}] iteration=${iteration} buildUuid=${buildUuid || 'none'}`
      );

      const settled = await Promise.allSettled(
        executeIndices.map(async (i) => {
          if (signal.aborted) {
            return {
              index: i,
              result: {
                success: false,
                error: { message: 'Operation cancelled during tool execution', code: 'CANCELLED', recoverable: false },
              },
              toolDuration: 0,
            };
          }
          const toolStartTime = Date.now();
          const result = await this.safetyManager.safeExecute(
            this.toolRegistry.get(toolCalls[i].name)!,
            toolCalls[i].arguments,
            callbacks,
            signal,
            buildUuid
          );
          const toolDuration = Date.now() - toolStartTime;
          return { index: i, result, toolDuration };
        })
      );

      for (const entry of settled) {
        if (entry.status === 'fulfilled') {
          const { index, result, toolDuration } = entry.value;
          const totalDuration = index === 0 && !loopDetectedIndices.has(0) ? llmThinkTime + toolDuration : toolDuration;
          toolResultParts[index] = {
            type: 'tool_result' as const,
            toolCallId: toolCallParts[index].toolCallId,
            name: toolCalls[index].name,
            result,
          };
          callbacks.onToolResult(
            result,
            toolCalls[index].name,
            toolCalls[index].arguments,
            toolDuration,
            totalDuration,
            toolCallParts[index].toolCallId
          );
          if (!result.success) {
            getLogger().warn(
              `AI: tool failed tool=${toolCalls[index].name} error=${result.error?.message} code=${
                result.error?.code
              } duration=${toolDuration}ms buildUuid=${buildUuid || 'none'}`
            );
          } else {
            getLogger().info(
              `AI: tool completed tool=${toolCalls[index].name} success=true duration=${toolDuration}ms buildUuid=${
                buildUuid || 'none'
              }`
            );
          }
        } else {
          const idx = executeIndices[settled.indexOf(entry)];
          const errorResult = {
            success: false,
            error: { message: entry.reason?.message || 'Unknown error', code: 'EXECUTION_ERROR', recoverable: true },
          };
          toolResultParts[idx] = {
            type: 'tool_result' as const,
            toolCallId: toolCallParts[idx].toolCallId,
            name: toolCalls[idx].name,
            result: errorResult,
          };
          callbacks.onToolResult(
            errorResult,
            toolCalls[idx].name,
            toolCalls[idx].arguments,
            0,
            idx === 0 ? llmThinkTime : 0,
            toolCallParts[idx].toolCallId
          );
          getLogger().error(
            `AI: tool crashed tool=${toolCalls[idx].name} error=${entry.reason?.message} buildUuid=${
              buildUuid || 'none'
            }`
          );
        }
      }

      messages.push({
        role: 'user',
        parts: toolResultParts,
      });
    }

    getLogger().warn(
      `AI: iteration limit reached iteration=${iteration} maxIterations=${
        protection.maxIterations
      } totalToolCalls=${totalToolCalls} buildUuid=${buildUuid || 'none'}`
    );
    return {
      success: false,
      error:
        `Investigation incomplete - hit iteration limit (${protection.maxIterations}). ` +
        `This may indicate the issue is complex or unclear from available data.`,
      metrics: this.buildMetrics(iteration, totalToolCalls, startTime, totalInputTokens, totalOutputTokens),
    };
  }

  private extractToolCalls(chunks: StreamChunk[]): ToolCall[] {
    return chunks.filter((c) => c.type === 'tool_call' && c.toolCalls).flatMap((c) => c.toolCalls || []);
  }

  private buildMetrics(iterations: number, toolCalls: number, startTime: number, inputTokens = 0, outputTokens = 0) {
    return {
      iterations,
      toolCalls,
      duration: Date.now() - startTime,
      inputTokens,
      outputTokens,
    };
  }
}
