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
import { getLogger } from 'server/lib/logger/index';

export interface ConversationState {
  summary: string;
  identifiedIssues: Array<{
    service: string;
    issue: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  investigatedServices: string[];
  toolsUsed: string[];
  currentTask: string;
  tokenCount: number;
  messageCount: number;
  compressionLevel: number;
}

export class ConversationManager {
  private readonly COMPRESSION_THRESHOLD = 80000;

  async shouldCompress(messages: Message[]): Promise<boolean> {
    const tokenCount = await this.estimateTokens(messages);
    return tokenCount > this.COMPRESSION_THRESHOLD;
  }

  async compress(messages: Message[], llmProvider: LLMProvider, buildUuid?: string): Promise<ConversationState> {
    getLogger().info(`AI: compression starting messageCount=${messages.length} buildUuid=${buildUuid || 'none'}`);
    const compressionPrompt = `
Analyze this debugging conversation and create a structured summary.

Extract:
1. What issues have been identified
2. Which services have been investigated
3. What tools were used
4. Current task/focus
5. Key findings

Return JSON matching ConversationState schema.

Conversation:
${this.formatMessages(messages)}
`;

    const chunks: StreamChunk[] = [];
    for await (const chunk of llmProvider.streamCompletion([{ role: 'user', content: compressionPrompt }], {
      systemPrompt: 'You are a conversation summarizer.',
      maxTokens: 2000,
    })) {
      chunks.push(chunk);
    }

    const responseText = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.content)
      .join('');

    const state: ConversationState = JSON.parse(responseText);
    state.tokenCount = await this.estimateTokens([{ role: 'user', content: JSON.stringify(state) }]);
    state.messageCount = messages.length;
    state.compressionLevel = 1;

    getLogger().info(
      `AIAgentConversationManager: compression complete messageCount=${messages.length} tokenCount=${state.tokenCount} issueCount=${state.identifiedIssues.length} serviceCount=${state.investigatedServices.length}`
    );

    return state;
  }

  buildPromptFromState(state: ConversationState): string {
    return `
# Conversation Context (Compressed)

## Summary
${state.summary}

## Identified Issues
${state.identifiedIssues.map((i) => `- **${i.service}**: ${i.issue} (${i.confidence} confidence)`).join('\n')}

## Already Investigated
Services: ${state.investigatedServices.join(', ')}
Tools used: ${state.toolsUsed.join(', ')}

## Current Task
${state.currentTask}

Continue the investigation from this point.
`;
  }

  private async estimateTokens(messages: Message[]): Promise<number> {
    const text = messages.map((m) => m.content).join(' ');
    return Math.ceil(text.length / 4);
  }

  private formatMessages(messages: Message[]): string {
    return messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
  }
}
