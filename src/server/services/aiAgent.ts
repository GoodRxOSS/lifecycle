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

import BaseService from './_service';
import GlobalConfigService from './globalConfig';
import { AIAgentCore } from './ai/service';
import { DebugContext, DebugMessage, StructuredDebugResponse } from './types/aiAgent';
import { StreamCallbacks } from './ai/types/stream';
import { ProviderType, ProviderFactory } from './ai/providers/factory';
import {
  GetK8sResourcesTool,
  GetPodLogsTool,
  GetFileTool,
  ListDirectoryTool,
  QueryDatabaseTool,
  GetCodefreshLogsTool,
  UpdateFileTool,
  PatchK8sResourceTool,
  GetIssueCommentTool,
} from './ai/tools';
import { getLogger } from 'server/lib/logger';

export default class AIAgentService extends BaseService {
  private service: AIAgentCore | null = null;
  private provider: ProviderType = 'anthropic';
  private currentMode: 'investigate' | 'fix' = 'investigate';

  async initialize(): Promise<void> {
    await this.initializeWithMode('investigate');
  }

  async initializeWithMode(mode: 'investigate' | 'fix', provider?: ProviderType, modelId?: string): Promise<void> {
    const globalConfig = GlobalConfigService.getInstance();
    const aiAgentConfig = await globalConfig.getConfig('aiAgent');

    if (!aiAgentConfig?.enabled) {
      throw new Error('AI Agent feature is not enabled in global_config');
    }

    if (provider && modelId) {
      const providerConfig = aiAgentConfig.providers.find((p: any) => p.name === provider);
      if (!providerConfig || !providerConfig.enabled) {
        throw new Error(`Provider ${provider} is not enabled`);
      }

      const modelConfig = providerConfig.models.find((m: any) => m.id === modelId);
      if (!modelConfig || !modelConfig.enabled) {
        throw new Error(`Model ${modelId} is not enabled for provider ${provider}`);
      }

      this.provider = provider;
    } else {
      const enabledProvider = aiAgentConfig.providers.find((p: any) => p.enabled);
      if (!enabledProvider) {
        throw new Error('No enabled providers found in configuration');
      }
      const defaultModel = enabledProvider.models.find((m: any) => m.default && m.enabled);
      if (!defaultModel) {
        throw new Error(`No default model found for provider ${enabledProvider.name}`);
      }
      this.provider = enabledProvider.name as ProviderType;
      modelId = defaultModel.id;
    }

    this.currentMode = mode;

    this.service = new AIAgentCore({
      provider: this.provider,
      modelId: modelId,
      db: this.db,
      redis: this.redis,
      requireToolConfirmation: mode === 'investigate',
      mode: mode,
    });
  }

  getMode(): 'investigate' | 'fix' {
    return this.currentMode;
  }

  private generateToolActivityMessage(toolName: string, toolArgs: any): string {
    const parts: string[] = [];

    switch (toolName) {
      case GetK8sResourcesTool.Name:
        parts.push(`Checking ${toolArgs.resource_type || 'resources'}`);
        if (toolArgs.namespace) parts.push(`in namespace ${toolArgs.namespace}`);
        break;

      case GetPodLogsTool.Name:
        parts.push(`Getting logs from pod ${toolArgs.pod_name}`);
        if (toolArgs.namespace) parts.push(`in ${toolArgs.namespace}`);
        break;

      case GetFileTool.Name:
        parts.push(`Reading file ${toolArgs.file_path || 'from repository'}`);
        if (toolArgs.repository_name) parts.push(`from ${toolArgs.repository_name}`);
        break;

      case ListDirectoryTool.Name:
        parts.push(`Listing files in ${toolArgs.directory_path || 'directory'}`);
        if (toolArgs.repository_name) parts.push(`from ${toolArgs.repository_name}`);
        break;

      case QueryDatabaseTool.Name:
        parts.push(`Querying ${toolArgs.table} table`);
        if (toolArgs.filters) parts.push(`with filters`);
        break;

      case GetCodefreshLogsTool.Name:
        if (toolArgs.service_name) {
          parts.push(`Getting build logs for ${toolArgs.service_name}`);
        } else {
          parts.push(`Getting pipeline logs`);
        }
        break;

      case UpdateFileTool.Name:
        parts.push(`Updating ${toolArgs.file_path || 'file'}`);
        if (toolArgs.commit_message) parts.push(`- ${toolArgs.commit_message}`);
        break;

      case PatchK8sResourceTool.Name:
        parts.push(`Patching ${toolArgs.resource_type}/${toolArgs.name}`);
        if (toolArgs.namespace) parts.push(`in ${toolArgs.namespace}`);
        break;

      case GetIssueCommentTool.Name:
        parts.push(`Reading issue/PR comments`);
        if (toolArgs.repository_name) parts.push(`from ${toolArgs.repository_name}`);
        break;

      default: {
        parts.push(toolName.replace(/_/g, ' '));
        const importantArgs = Object.entries(toolArgs)
          .filter(([key, val]) => val && !key.includes('token') && !key.includes('key'))
          .slice(0, 2);
        if (importantArgs.length > 0) {
          const argStr = importantArgs.map(([k, v]) => `${k}: ${v}`).join(', ');
          parts.push(`(${argStr})`);
        }
        break;
      }
    }

    return parts.join(' ');
  }

  private generateToolResultMessage(toolName: string, toolArgs: any, result: any): string {
    if (!result.success) {
      return `Failed to ${this.generateToolActivityMessage(toolName, toolArgs).toLowerCase()}`;
    }

    if (result.displayContent?.content) {
      const content = result.displayContent.content;
      if (typeof content === 'string' && content.length <= 100) {
        return content;
      }
    }

    return `✓ ${this.generateToolActivityMessage(toolName, toolArgs)}`;
  }

  async classifyUserIntent(userMessage: string, conversationHistory: DebugMessage[]): Promise<'investigate' | 'fix'> {
    try {
      const provider = ProviderFactory.create({ provider: this.provider });

      const conversationContext =
        conversationHistory.length > 0
          ? conversationHistory
              .filter((m) => {
                if (m.role === 'assistant' && m.content.trim().startsWith('[{') && m.content.includes('"toolCall"')) {
                  return false;
                }
                return true;
              })
              .slice(-4)
              .map((m) => {
                const content = m.content.length > 200 ? m.content.substring(0, 200) + '...' : m.content;
                return `${m.role}: ${content}`;
              })
              .join('\n\n')
          : 'No previous conversation';

      const classificationPrompt = `You are analyzing user intent in a debugging conversation. Based on the conversation history and the user's latest message, determine if they want to:
- INVESTIGATE: Understand, analyze, or get information about an issue
- FIX: Apply changes, commit fixes, or make modifications to code/resources

Conversation history:
${conversationContext}

Latest user message:
${userMessage}

Rules:
- If the user is asking questions, requesting explanations, or wants to understand something: respond INVESTIGATE
- If the user is confirming they want changes applied, asking to commit, or requesting fixes to be made: respond FIX
- Consider the full conversation context - if you previously suggested a fix and the user is now approving it, respond FIX
- Phrases like "yes", "do it", "go ahead", "apply that", "commit it", "fix it" in response to a proposed solution indicate FIX
- Questions like "why", "how", "what", "show me", "explain" indicate INVESTIGATE

Respond with ONLY the word INVESTIGATE or FIX, nothing else.`;

      let response = '';

      for await (const chunk of provider.streamCompletion(
        [{ role: 'user', content: classificationPrompt }],
        {
          systemPrompt: 'You are a precise intent classifier. Respond only with INVESTIGATE or FIX.',
          temperature: 0.1,
        },
        new AbortController().signal
      )) {
        if (chunk.type === 'text' && chunk.content) {
          response += chunk.content;
        }
      }

      const classification = response.trim().toUpperCase();

      if (classification.includes('FIX')) {
        return 'fix';
      } else {
        return 'investigate';
      }
    } catch (error: any) {
      getLogger().error(`AI: classifyUserIntent failed error=${error?.message}`);
      return 'investigate';
    }
  }

  async processQueryStream(
    userMessage: string,
    context: DebugContext,
    conversationHistory: DebugMessage[],
    onChunk: (chunk: string) => void,
    onActivity?: (activity: { type: string; message: string; details?: any }) => void,
    onToolConfirmation?: (details: {
      title: string;
      description: string;
      impact: string;
      confirmButtonText: string;
    }) => Promise<boolean>,
    mode?: 'investigate' | 'fix'
  ): Promise<{ response: string; isJson: boolean; totalInvestigationTimeMs: number }> {
    const effectiveMode = mode || 'investigate';

    if (!this.service || this.service.getModelInfo().model !== this.provider) {
      await this.initialize();
    }

    if (this.service && effectiveMode !== this.getMode()) {
      await this.initializeWithMode(effectiveMode);
    }

    const abortController = new AbortController();

    const callbacks: StreamCallbacks = {
      onTextChunk: (text) => onChunk(text),
      onThinking: (message) => onActivity?.({ type: 'thinking', message }),
      onToolCall: (tool, args) =>
        onActivity?.({
          type: 'tool_call',
          message: this.generateToolActivityMessage(tool, args),
        }),
      onToolResult: (result, toolName, toolArgs, toolDurationMs, totalDurationMs) =>
        onActivity?.({
          type: 'processing',
          message: this.generateToolResultMessage(toolName, toolArgs, result),
          details:
            toolDurationMs !== undefined || totalDurationMs !== undefined
              ? {
                  toolDurationMs: toolDurationMs,
                  totalDurationMs: totalDurationMs,
                }
              : undefined,
        }),
      onStructuredOutput: () => {},
      onError: (error) => onActivity?.({ type: 'error', message: error?.message || 'Error' }),
      onActivity: (activity) => onActivity?.(activity),
      onToolConfirmation: onToolConfirmation,
    };

    const result = await this.service!.processQuery(
      userMessage,
      context,
      conversationHistory,
      callbacks,
      abortController.signal
    );

    return {
      response: result.response,
      isJson: result.isJson,
      totalInvestigationTimeMs: result.metrics.duration,
    };
  }

  parseStructuredResponse(response: string): StructuredDebugResponse | null {
    try {
      let cleaned = response.trim();

      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '');
      }

      const parsed = JSON.parse(cleaned);

      if (parsed.type === 'investigation_complete' && Array.isArray(parsed.services)) {
        const fixesApplied = parsed.fixesApplied ?? false;
        return { ...parsed, fixesApplied } as StructuredDebugResponse;
      }

      return null;
    } catch (error) {
      return null;
    }
  }
}
