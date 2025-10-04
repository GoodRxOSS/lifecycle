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

import { LLMProvider, Message, StreamChunk } from '../types/provider';
import { Tool, ToolCall } from '../types/tool';
import { StreamCallbacks } from '../types/stream';
import { ToolRegistry } from '../tools/registry';
import { ToolSafetyManager } from './safety';
import { LoopDetector } from './loopProtection';
import rootLogger from 'server/lib/logger';

export interface OrchestrationResult {
  success: boolean;
  response?: string;
  error?: string;
  cancelled?: boolean;
  metrics: {
    iterations: number;
    toolCalls: number;
    duration: number;
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
    messages: Message[],
    tools: Tool[],
    callbacks: StreamCallbacks,
    signal: AbortSignal,
    buildUuid?: string
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    let iteration = 0;
    let totalToolCalls = 0;
    let fullResponse = '';
    const protection = this.loopDetector.getProtection();
    const logger = buildUuid
      ? rootLogger.child({ component: 'AIAgentOrchestrator', buildUuid })
      : rootLogger.child({ component: 'AIAgentOrchestrator' });

    this.loopDetector.reset();

    while (iteration < protection.maxIterations) {
      if (signal.aborted) {
        return {
          success: false,
          error: 'Operation cancelled by user',
          cancelled: true,
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime),
        };
      }

      iteration++;

      const iterationStartTime = Date.now();
      const chunks: StreamChunk[] = [];
      try {
        for await (const chunk of provider.streamCompletion(messages, { systemPrompt, tools, callbacks }, signal)) {
          chunks.push(chunk);

          if (chunk.type === 'text' && chunk.content) {
            fullResponse += chunk.content;
            callbacks.onTextChunk(chunk.content);
          }
        }
      } catch (error: any) {
        logger.error(`Stream error: ${error.message}`, error);
        return {
          success: false,
          error: error.message || 'Provider error',
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime),
        };
      }

      const llmThinkTime = Date.now() - iterationStartTime;
      const toolCalls = this.extractToolCalls(chunks);

      if (toolCalls.length === 0) {
        return {
          success: true,
          response: fullResponse,
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime),
        };
      }

      totalToolCalls += toolCalls.length;
      if (totalToolCalls > protection.maxToolCalls) {
        logger.warn(`Tool call limit exceeded: ${totalToolCalls} > ${protection.maxToolCalls}`);
        return {
          success: false,
          error:
            `Tool call limit exceeded (${protection.maxToolCalls}). ` +
            `The investigation is too broad. Try asking about specific services.`,
          metrics: this.buildMetrics(iteration, totalToolCalls, startTime),
        };
      }

      const toolResults: any[] = [];
      let isFirstTool = true;

      for (const toolCall of toolCalls) {
        if (signal.aborted) {
          return {
            success: false,
            error: 'Operation cancelled during tool execution',
            cancelled: true,
            metrics: this.buildMetrics(iteration, totalToolCalls, startTime),
          };
        }

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

          toolResults.push({
            toolCall,
            result: loopError,
          });

          const totalDuration = isFirstTool ? llmThinkTime : 0;
          callbacks.onToolResult(loopError, toolCall.name, toolCall.arguments, 0, totalDuration);
          isFirstTool = false;

          console.warn(`[Loop Detection] ${toolCall.name} called ${repeatCount} times`, {
            args: toolCall.arguments,
            iteration,
          });

          continue;
        }

        this.loopDetector.recordCall(toolCall.name, toolCall.arguments, iteration);

        callbacks.onToolCall(toolCall.name, toolCall.arguments);

        const toolStartTime = Date.now();
        const result = await this.safetyManager.safeExecute(
          this.toolRegistry.get(toolCall.name)!,
          toolCall.arguments,
          callbacks,
          signal,
          buildUuid
        );
        const toolDuration = Date.now() - toolStartTime;
        const totalDuration = isFirstTool ? llmThinkTime + toolDuration : toolDuration;
        isFirstTool = false;

        toolResults.push({ toolCall, result });
        callbacks.onToolResult(result, toolCall.name, toolCall.arguments, toolDuration, totalDuration);
      }

      messages.push({
        role: 'assistant',
        content: JSON.stringify(toolResults),
      });
    }

    logger.warn(
      `Tool loop hit iteration limit: ${iteration}/${protection.maxIterations}, totalToolCalls=${totalToolCalls}`
    );
    return {
      success: false,
      error:
        `Investigation incomplete - hit iteration limit (${protection.maxIterations}). ` +
        `This may indicate the issue is complex or unclear from available data.`,
      metrics: this.buildMetrics(iteration, totalToolCalls, startTime),
    };
  }

  private extractToolCalls(chunks: StreamChunk[]): ToolCall[] {
    return chunks.filter((c) => c.type === 'tool_call' && c.toolCalls).flatMap((c) => c.toolCalls || []);
  }

  private buildMetrics(iterations: number, toolCalls: number, startTime: number) {
    return {
      iterations,
      toolCalls,
      duration: Date.now() - startTime,
    };
  }
}
