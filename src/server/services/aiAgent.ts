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
import AIAgentConfigService from './aiAgentConfig';
import { AIAgentCore } from './ai/service';
import { DebugContext, DebugMessage, StructuredDebugResponse } from './types/aiAgent';
import { StreamCallbacks } from './ai/types/stream';
import { ProviderType } from './ai/providers/factory';
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
import type { AIChatEvidenceEvent } from 'shared/types/aiChat';
import { extractEvidence, generateResultPreview } from './ai/evidence/extractor';

export default class AIAgentService extends BaseService {
  private service: AIAgentCore | null = null;
  private provider: ProviderType = 'anthropic';
  private modelId?: string;
  private modelPricing?: { inputCostPerMillion: number; outputCostPerMillion: number };
  private currentMode: 'investigate' | 'fix' = 'investigate';
  private repoFullName?: string;

  async initialize(repoFullName?: string): Promise<void> {
    await this.initializeWithMode('investigate', undefined, undefined, repoFullName);
  }

  async initializeWithMode(
    mode: 'investigate' | 'fix',
    provider?: ProviderType,
    modelId?: string,
    repoFullName?: string
  ): Promise<void> {
    getLogger().info(`AI: initializeWithMode called mode=${mode} provider=${provider} modelId=${modelId}`);

    if (repoFullName) {
      this.repoFullName = repoFullName;
    }
    const aiAgentConfigService = AIAgentConfigService.getInstance();
    const aiAgentConfig = await aiAgentConfigService.getEffectiveConfig(this.repoFullName);

    if (!aiAgentConfig?.enabled) {
      throw new Error('AI Agent feature is not enabled in global_config');
    }

    if (provider && modelId) {
      getLogger().info(`AI: explicit provider selection provider=${provider} modelId=${modelId}`);
      const providerConfig = aiAgentConfig.providers.find((p: any) => p.name === provider);
      if (!providerConfig || !providerConfig.enabled) {
        throw new Error(`Provider ${provider} is not enabled`);
      }

      const modelConfig = providerConfig.models.find((m: any) => m.id === modelId);
      if (!modelConfig || !modelConfig.enabled) {
        throw new Error(`Model ${modelId} is not enabled for provider ${provider}`);
      }

      this.provider = provider;
      this.modelId = modelId;
      this.modelPricing =
        modelConfig.inputCostPerMillion != null && modelConfig.outputCostPerMillion != null
          ? {
              inputCostPerMillion: modelConfig.inputCostPerMillion,
              outputCostPerMillion: modelConfig.outputCostPerMillion,
            }
          : undefined;
      getLogger().info(`AI: provider set to ${this.provider} modelId=${this.modelId}`);
    } else {
      getLogger().info(`AI: no provider/modelId provided, using defaults`);
      const enabledProvider = aiAgentConfig.providers.find((p: any) => p.enabled);
      if (!enabledProvider) {
        throw new Error('No enabled providers found in configuration');
      }
      const defaultModel = enabledProvider.models.find((m: any) => m.default && m.enabled);
      if (!defaultModel) {
        throw new Error(`No default model found for provider ${enabledProvider.name}`);
      }
      this.provider = enabledProvider.name as ProviderType;
      this.modelId = defaultModel.id;
      this.modelPricing =
        defaultModel.inputCostPerMillion != null && defaultModel.outputCostPerMillion != null
          ? {
              inputCostPerMillion: defaultModel.inputCostPerMillion,
              outputCostPerMillion: defaultModel.outputCostPerMillion,
            }
          : undefined;
      getLogger().info(`AI: using default provider=${this.provider} modelId=${this.modelId}`);
    }

    this.currentMode = mode;

    getLogger().info(`AI: creating AIAgentCore with provider=${this.provider} modelId=${this.modelId}`);
    this.service = new AIAgentCore({
      provider: this.provider,
      modelId: this.modelId,
      db: this.db,
      redis: this.redis,
      requireToolConfirmation: mode === 'investigate',
      mode: mode,
      additiveRules: aiAgentConfig.additiveRules,
      systemPromptOverride: aiAgentConfig.systemPromptOverride,
      excludedTools: aiAgentConfig.excludedTools,
      excludedFilePatterns: aiAgentConfig.excludedFilePatterns,
      allowedWritePatterns: aiAgentConfig.allowedWritePatterns,
      modelPricing: this.modelPricing,
      maxIterations: aiAgentConfig.maxIterations,
      maxToolCalls: aiAgentConfig.maxToolCalls,
      maxRepeatedCalls: aiAgentConfig.maxRepeatedCalls,
      compressionThreshold: aiAgentConfig.compressionThreshold,
      observationMaskingRecencyWindow: aiAgentConfig.observationMaskingRecencyWindow,
      observationMaskingTokenThreshold: aiAgentConfig.observationMaskingTokenThreshold,
      toolExecutionTimeout: aiAgentConfig.toolExecutionTimeout,
      toolOutputMaxChars: aiAgentConfig.toolOutputMaxChars,
      retryBudget: aiAgentConfig.retryBudget,
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
        return `✓ ${content}`;
      }
    }

    return `✓ ${this.generateToolActivityMessage(toolName, toolArgs)}`;
  }

  async processQueryStream(
    userMessage: string,
    context: DebugContext,
    conversationHistory: DebugMessage[],
    onChunk: (chunk: string) => void,
    onActivity?: (activity: {
      type: string;
      message: string;
      details?: any;
      toolCallId?: string;
      resultPreview?: string;
    }) => void,
    onEvidence?: (event: AIChatEvidenceEvent) => void,
    onToolConfirmation?: (details: {
      title: string;
      description: string;
      impact: string;
      confirmButtonText: string;
    }) => Promise<boolean>,
    mode?: 'investigate' | 'fix',
    onDebugEvent?: (event: any) => void
  ): Promise<{ response: string; isJson: boolean; totalInvestigationTimeMs: number }> {
    const effectiveMode = mode || 'investigate';

    if (!this.service) {
      getLogger().warn('AI: processQueryStream called without initialized service, using defaults');
      await this.initialize(this.repoFullName);
    }

    if (this.service && effectiveMode !== this.getMode()) {
      getLogger().info(
        `AI: mode changed from ${this.getMode()} to ${effectiveMode}, reinitializing with same provider/model`
      );
      await this.initializeWithMode(effectiveMode, this.provider, this.modelId, this.repoFullName);
    }

    const abortController = new AbortController();

    const callbacks: StreamCallbacks = {
      onTextChunk: (text) => onChunk(text),
      onThinking: (message) => onActivity?.({ type: 'thinking', message }),
      onToolCall: (tool, args, toolCallId) => {
        onActivity?.({
          type: 'tool_call',
          message: this.generateToolActivityMessage(tool, args),
          toolCallId,
        });
        onDebugEvent?.({ type: 'debug_tool_call', toolCallId, toolName: tool, toolArgs: args });
      },
      onToolResult: (result, toolName, toolArgs, toolDurationMs, totalDurationMs, toolCallId) => {
        const argsRecord = toolArgs as Record<string, unknown>;
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
          toolCallId,
          resultPreview: generateResultPreview(toolName, argsRecord, result),
        });
        onDebugEvent?.({ type: 'debug_tool_result', toolCallId, toolName, toolResult: result, toolDurationMs });
        if (onEvidence) {
          try {
            const evidenceEvents = extractEvidence(toolName, argsRecord, result, {
              toolCallId: toolCallId || '',
              repositoryOwner: context.lifecycleContext?.pullRequest?.fullName?.split('/')[0],
              repositoryName: context.lifecycleContext?.pullRequest?.fullName?.split('/')[1],
              commitSha: context.lifecycleContext?.pullRequest?.latestCommit,
            });
            for (const ev of evidenceEvents) {
              onEvidence(ev);
            }
          } catch {
            // evidence extraction must never disrupt the tool loop
          }
        }
      },
      onError: (error) => onActivity?.({ type: 'error', message: error?.message || 'Error' }),
      onActivity: (activity) => onActivity?.(activity),
      onToolConfirmation: onToolConfirmation,
    };

    const result = await this.service!.processQuery(
      userMessage,
      context,
      conversationHistory,
      callbacks,
      abortController.signal,
      onDebugEvent
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
