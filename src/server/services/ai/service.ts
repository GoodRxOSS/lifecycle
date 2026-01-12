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

import { LLMProvider, Message } from './types/provider';
import { ProviderFactory, ProviderType } from './providers/factory';
import { ToolRegistry } from './tools/registry';
import { ToolOrchestrator } from './orchestration/orchestrator';
import { ToolSafetyManager } from './orchestration/safety';
import { ConversationManager } from './conversation/manager';
import { StreamCallbacks } from './types/stream';
import { ResponseHandler } from './streaming/responseHandler';
import { AIAgentPromptBuilder } from './prompts/builder';
import {
  GetK8sResourcesTool,
  GetPodLogsTool,
  GetLifecycleLogsTool,
  PatchK8sResourceTool,
  QueryDatabaseTool,
  GetFileTool,
  UpdateFileTool,
  ListDirectoryTool,
  GetIssueCommentTool,
  GetCodefreshLogsTool,
  K8sClient,
  DatabaseClient,
  GitHubClient,
} from './tools';
import { DebugContext, DebugMessage } from '../types/aiAgent';
import { getLogger } from 'server/lib/logger/index';

export interface AIAgentConfig {
  provider: ProviderType;
  modelId?: string;
  db: any;
  redis: any;
  requireToolConfirmation?: boolean;
  mode?: 'investigate' | 'fix';
}

export interface ProcessQueryResult {
  response: string;
  isJson: boolean;
  metrics: {
    iterations: number;
    toolCalls: number;
    duration: number;
  };
}

export class AIAgentCore {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private orchestrator: ToolOrchestrator;
  private promptBuilder: AIAgentPromptBuilder;
  private conversationManager: ConversationManager;
  private mode: 'investigate' | 'fix';

  private k8sClient: K8sClient;
  private databaseClient: DatabaseClient;
  private githubClient: GitHubClient;

  constructor(config: AIAgentConfig) {
    this.k8sClient = new K8sClient();
    this.databaseClient = new DatabaseClient(config.db);
    this.githubClient = new GitHubClient();

    this.provider = ProviderFactory.create({
      provider: config.provider,
      modelId: config.modelId,
    });
    this.mode = config.mode || 'investigate';

    this.toolRegistry = new ToolRegistry();
    this.registerAllTools();

    const safetyManager = new ToolSafetyManager(config.requireToolConfirmation ?? true);
    this.orchestrator = new ToolOrchestrator(this.toolRegistry, safetyManager);

    this.promptBuilder = new AIAgentPromptBuilder();
    this.conversationManager = new ConversationManager();
  }

  async processQuery(
    userMessage: string,
    context: DebugContext,
    conversationHistory: DebugMessage[],
    callbacks: StreamCallbacks,
    signal: AbortSignal
  ): Promise<ProcessQueryResult> {
    const startTime = Date.now();

    try {
      if (context.lifecycleContext.pullRequest.branch) {
        this.githubClient.setAllowedBranch(context.lifecycleContext.pullRequest.branch);
      }

      if (context.lifecycleYaml?.content) {
        const referencedFiles = this.githubClient.extractReferencedFilesFromYaml(context.lifecycleYaml.content);
        referencedFiles.push('lifecycle.yaml');
        referencedFiles.push('lifecycle.yml');
        this.githubClient.setReferencedFiles(referencedFiles);
      }

      const messages: Message[] = conversationHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      if (await this.conversationManager.shouldCompress(messages)) {
        getLogger().info(
          `AIAgentCore: compressing conversation fromMessageCount=${messages.length} buildUuid=${context.buildUuid}`
        );
        const state = await this.conversationManager.compress(messages, this.provider, context.buildUuid);
        messages.splice(0, messages.length - 1);
        messages.unshift({
          role: 'user',
          content: this.conversationManager.buildPromptFromState(state),
        });
        getLogger().info(
          `AIAgentCore: conversation compressed toMessageCount=${messages.length} buildUuid=${context.buildUuid}`
        );
      }

      const conversationHistoryForBuilder: DebugMessage[] = messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: Date.now(),
      }));

      const prompt = this.promptBuilder.build({
        provider: this.provider.name as ProviderType,
        debugContext: context,
        conversationHistory: conversationHistoryForBuilder,
        userMessage,
      });

      const responseHandler = new ResponseHandler(callbacks, context.buildUuid);

      const enhancedCallbacks: StreamCallbacks = {
        ...callbacks,
        onTextChunk: (text) => {
          responseHandler.handleChunk(text);
        },
      };

      const messagesForOrchestrator: Message[] = prompt.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      const result = await this.orchestrator.executeToolLoop(
        this.provider,
        prompt.systemPrompt,
        messagesForOrchestrator,
        this.toolRegistry.getAll(),
        enhancedCallbacks,
        signal,
        context.buildUuid
      );

      const finalResult = responseHandler.getResult();

      const duration = Date.now() - startTime;

      getLogger().info(
        `AIAgentCore: query processing ${result.success ? 'completed' : 'failed'} iterations=${
          result.metrics.iterations
        } toolCalls=${result.metrics.toolCalls} duration=${duration}ms isJson=${finalResult.isJson} buildUuid=${
          context.buildUuid
        }`
      );

      return {
        response: result.response || result.error || finalResult.response,
        isJson: finalResult.isJson,
        metrics: result.metrics,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;

      getLogger().error(
        `AIAgentCore: query processing error duration=${duration}ms error=${error?.message} buildUuid=${context.buildUuid}`
      );

      throw error;
    }
  }

  private registerAllTools(): void {
    const k8sTools = [
      new GetK8sResourcesTool(this.k8sClient),
      new GetPodLogsTool(this.k8sClient),
      new GetLifecycleLogsTool(this.k8sClient),
      new PatchK8sResourceTool(this.k8sClient),
      new QueryDatabaseTool(this.databaseClient),
    ];

    const githubTools = [
      new GetFileTool(this.githubClient),
      new UpdateFileTool(this.githubClient),
      new ListDirectoryTool(this.githubClient),
      new GetIssueCommentTool(this.githubClient),
    ];

    const codefreshTools = [new GetCodefreshLogsTool()];

    let allTools = [...k8sTools, ...githubTools, ...codefreshTools];

    if (this.mode === 'investigate') {
      const writingToolNames = [UpdateFileTool.Name, PatchK8sResourceTool.Name];
      allTools = allTools.filter((tool) => !writingToolNames.includes(tool.name));
    }

    this.toolRegistry.registerMultiple(allTools);
  }

  getProviderName(): string {
    return this.provider.name;
  }

  getModelInfo() {
    return this.provider.getModelInfo();
  }
}
