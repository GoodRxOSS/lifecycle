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

import { AgentWSServerMessage } from 'shared/types/agentSession';

export class JsonlParser {
  private buffer = '';
  private streamToolNames = new Map<number, string>();
  private currentTurnStartedAt: number | null = null;
  private currentTurnToolCalls = 0;
  private onMessage: (msg: AgentWSServerMessage) => void;

  constructor(onMessage: (msg: AgentWSServerMessage) => void) {
    this.onMessage = onMessage;
  }

  feed(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  private parseLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.onMessage({ type: 'chunk', content: line });
      return;
    }

    const mappedMessages = this.mapEvent(parsed);
    if (mappedMessages.length > 0) {
      mappedMessages.forEach((message) => this.onMessage(message));
      return;
    }

    if (
      parsed?.type === 'assistant' ||
      parsed?.type === 'system' ||
      parsed?.type === 'user' ||
      parsed?.type === 'result'
    ) {
      return;
    }

    this.onMessage({ type: 'chunk', content: line });
  }

  private mapEvent(event: any): AgentWSServerMessage[] {
    switch (event.type) {
      case 'assistant':
        return this.mapAssistantMessage(event.message);
      case 'result':
        return this.mapResultMessage(event);
      case 'stream_event':
        return this.mapStreamEvent(event.event);
      case 'tool_use':
        this.currentTurnToolCalls += 1;
        return [{ type: 'tool_use', tool: event.tool?.name || '', args: event.tool?.args || {} }];
      case 'tool_result':
        return [
          {
            type: 'phase',
            phase: 'reviewing_tool',
            label: event.tool ? `Reviewing ${event.tool} output` : 'Reviewing tool output',
            tool: event.tool || undefined,
          },
          {
            type: 'tool_result',
            tool: event.tool || '',
            result: event.result || '',
            success: event.success ?? true,
          },
        ];
      default:
        return [];
    }
  }

  private mapAssistantMessage(message: any): AgentWSServerMessage[] {
    const messageId = typeof message?.id === 'string' ? message.id : undefined;
    const content = message?.content;
    if (typeof content === 'string') {
      return content ? [{ type: 'chunk', content }] : [];
    }

    if (!Array.isArray(content)) {
      return [];
    }

    const mappedMessages: AgentWSServerMessage[] = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') {
        continue;
      }

      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        mappedMessages.push({ type: 'chunk', content: block.text });
        continue;
      }

      if (block.type === 'thinking') {
        mappedMessages.push({
          type: 'phase',
          phase: 'thinking',
          label: 'Thinking through next step',
        });
        continue;
      }

      if (block.type === 'tool_use') {
        this.currentTurnToolCalls += 1;
        mappedMessages.push({
          type: 'tool_use',
          tool: block.name || '',
          args: block.input || {},
        });
      }
    }

    const usageMessage = this.mapUsageMetrics(message?.usage, {
      scope: 'step',
      messageId,
      totalCostUsd: this.parseFiniteNumber(message?.total_cost_usd),
    });
    if (usageMessage) {
      mappedMessages.push(usageMessage);
    }

    return mappedMessages;
  }

  private mapResultMessage(event: any): AgentWSServerMessage[] {
    const usageMessage = this.mapUsageMetrics(event?.usage, {
      scope: 'session',
      totalCostUsd: this.parseFiniteNumber(event?.total_cost_usd),
    });

    if (event?.subtype === 'success') {
      this.streamToolNames.clear();
      this.currentTurnStartedAt = null;
      this.currentTurnToolCalls = 0;
      return usageMessage ? [usageMessage, { type: 'status', status: 'ready' }] : [{ type: 'status', status: 'ready' }];
    }

    if (Array.isArray(event?.errors) && event.errors.length > 0) {
      const content = event.errors.filter((error: unknown): error is string => typeof error === 'string').join('\n');
      const messages: AgentWSServerMessage[] = [];
      if (usageMessage) {
        messages.push(usageMessage);
      }
      if (content) {
        messages.push({ type: 'chunk', content });
      }
      return messages;
    }

    return usageMessage ? [usageMessage] : [];
  }

  private mapStreamEvent(event: any): AgentWSServerMessage[] {
    if (!event || typeof event !== 'object') {
      return [];
    }

    switch (event.type) {
      case 'message_start':
        this.currentTurnStartedAt = Date.now();
        this.currentTurnToolCalls = 0;
        return [{ type: 'status', status: 'working' }];
      case 'message_stop':
        this.streamToolNames.clear();
        this.currentTurnStartedAt = null;
        this.currentTurnToolCalls = 0;
        return [{ type: 'status', status: 'ready' }];
      case 'content_block_start': {
        const block = event.content_block;
        if (!block || typeof block !== 'object') {
          return [];
        }

        if (block.type === 'text') {
          return [{ type: 'phase', phase: 'drafting', label: 'Drafting response' }];
        }

        if (block.type === 'tool_use') {
          const index = typeof event.index === 'number' ? event.index : null;
          const toolName = typeof block.name === 'string' ? block.name : '';

          if (index != null && toolName) {
            this.streamToolNames.set(index, toolName);
          }

          return [
            {
              type: 'phase',
              phase: 'preparing_tool',
              label: toolName ? `Preparing ${toolName}` : 'Preparing tool',
              tool: toolName || undefined,
            },
          ];
        }

        return [];
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (!delta || typeof delta !== 'object') {
          return [];
        }

        if (delta.type === 'text_delta') {
          return [{ type: 'phase', phase: 'drafting', label: 'Drafting response' }];
        }

        if (delta.type === 'input_json_delta') {
          const toolName = typeof event.index === 'number' ? this.streamToolNames.get(event.index) : undefined;

          return [
            {
              type: 'phase',
              phase: 'preparing_tool',
              label: toolName ? `Preparing ${toolName} arguments` : 'Preparing tool arguments',
              tool: toolName,
            },
          ];
        }

        return [];
      }
      case 'content_block_stop': {
        if (typeof event.index !== 'number') {
          return [];
        }

        const toolName = this.streamToolNames.get(event.index);
        if (!toolName) {
          return [];
        }

        this.streamToolNames.delete(event.index);
        return [
          {
            type: 'phase',
            phase: 'running_tool',
            label: `Running ${toolName}`,
            tool: toolName,
          },
        ];
      }
      default:
        return [];
    }
  }

  private mapUsageMetrics(
    usage: any,
    options: {
      scope: 'step' | 'session';
      messageId?: string;
      totalCostUsd?: number | null;
    }
  ): AgentWSServerMessage | null {
    const totalCostUsd = options.totalCostUsd ?? null;

    if (!usage || typeof usage !== 'object') {
      if (totalCostUsd == null) {
        return null;
      }

      return {
        type: 'usage',
        scope: options.scope,
        ...(options.messageId ? { messageId: options.messageId } : {}),
        metrics: {
          iterations: 1,
          totalToolCalls: this.currentTurnToolCalls,
          totalDurationMs: this.currentTurnStartedAt != null ? Math.max(0, Date.now() - this.currentTurnStartedAt) : 0,
          totalCostUsd,
        },
      };
    }

    const inputTokens = this.parseFiniteNumber(usage.input_tokens);
    const outputTokens = this.parseFiniteNumber(usage.output_tokens);
    const cacheCreationInputTokens = this.parseFiniteNumber(usage.cache_creation_input_tokens);
    const cacheReadInputTokens = this.parseFiniteNumber(usage.cache_read_input_tokens);

    if (
      inputTokens == null &&
      outputTokens == null &&
      cacheCreationInputTokens == null &&
      cacheReadInputTokens == null &&
      totalCostUsd == null
    ) {
      return null;
    }

    const totalDurationMs = this.currentTurnStartedAt != null ? Math.max(0, Date.now() - this.currentTurnStartedAt) : 0;

    return {
      type: 'usage',
      scope: options.scope,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      metrics: {
        iterations: 1,
        totalToolCalls: this.currentTurnToolCalls,
        totalDurationMs,
        inputTokens: inputTokens ?? undefined,
        outputTokens: outputTokens ?? undefined,
        cacheCreationInputTokens: cacheCreationInputTokens ?? undefined,
        cacheReadInputTokens: cacheReadInputTokens ?? undefined,
        totalCostUsd: totalCostUsd ?? undefined,
      },
    };
  }

  private parseFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
