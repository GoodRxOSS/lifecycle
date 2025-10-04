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

/* eslint-disable no-unused-vars */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import BaseService from './_service';
import { DebugContext, DebugMessage } from './types/aiDebug';
import AIDebugToolsService from './aiDebugTools';
import AIDebugGitHubToolsService from './aiDebugGitHubTools';
import GlobalConfigService from './globalConfig';

export default class AIDebugLLMService extends BaseService {
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private gemini: GoogleGenerativeAI | null = null;
  private provider: 'anthropic' | 'openai' | 'gemini' = 'anthropic';
  private toolsService: AIDebugToolsService;
  private gitHubToolsService: AIDebugGitHubToolsService;

  constructor(db: any, redis: any) {
    super(db, redis);
    this.toolsService = new AIDebugToolsService(db, redis);
    this.gitHubToolsService = new AIDebugGitHubToolsService(db, redis);
  }

  private shouldFilterText(text: string): boolean {
    const trimmed = text.trim();

    // Only filter obvious raw JSON tool responses that look like function outputs
    // Be conservative - only filter clear tool response patterns, not legitimate content

    // Filter tool_outputs code blocks
    if (trimmed.includes('```tool_outputs')) {
      return true;
    }

    // Filter only if it's a JSON object that looks like a direct tool response
    // Must start with { and contain specific tool response signatures
    if (
      trimmed.startsWith('{') &&
      (trimmed.includes('"success":') ||
        trimmed.includes('_response":') ||
        (trimmed.includes('"error":') && trimmed.includes('"message":')))
    ) {
      return true;
    }

    // Filter only pure JSON fragments (just brackets/braces, no content)
    if (trimmed.match(/^[[{\]},\s]*$/)) {
      return true;
    }

    return false;
  }

  private cleanupResponse(text: string): string {
    let cleaned = text;

    // Remove lines that are filtered (raw tool responses)
    cleaned = cleaned
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !this.shouldFilterText(trimmed);
      })
      .join('\n');

    // Clean up any multiple blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }

  private getFriendlyActivityMessage(toolName: string, args: any): string {
    const activityMap: Record<string, (_a: any) => string> = {
      get_pods: (_a) => `Checking pods${_a.label_selector ? ` (${_a.label_selector})` : ''}`,
      get_deployment: (_a) => `Checking deployment ${_a.deployment_name}`,
      list_deployments: () => `Listing all deployments`,
      get_events: (_a) => `Checking events${_a.resource_name ? ` for ${_a.resource_name}` : ''}`,
      get_pod_logs: (_a) => `Reading logs from ${_a.pod_name}`,
      get_jobs: () => `Checking build and deploy jobs`,
      scale_deployment: (_a) => `Scaling ${_a.deployment_name} to ${_a.replicas} replicas`,
      patch_deployment: (_a) => `Updating ${_a.deployment_name}`,
      restart_deployment: (_a) => `Restarting ${_a.deployment_name}`,
      delete_pod: (_a) => `Deleting pod ${_a.pod_name}`,
      get_lifecycle_config: () => `Reading lifecycle.yaml configuration`,
      commit_lifecycle_fix: () => `Committing fix to lifecycle.yaml`,
      get_referenced_file: (_a) => `Reading ${_a.file_path}`,
      update_referenced_file: (_a) => `Updating ${_a.file_path}`,
      list_directory: (_a) => `Listing files in ${_a.directory_path}`,
    };

    const messageFunc = activityMap[toolName];
    return messageFunc ? messageFunc(args) : `Executing ${toolName}`;
  }

  private sanitizeFunctionResult(result: any): any {
    if (!result || typeof result !== 'object') {
      return result;
    }

    const sanitized = { ...result };

    if (sanitized.content && typeof sanitized.content === 'string') {
      const contentLength = sanitized.content.length;

      sanitized.content = sanitized.content
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

      if (contentLength > 5000) {
        sanitized.content =
          sanitized.content.substring(0, 5000) +
          `\n\n[Content truncated - showing first 5000 of ${contentLength} characters]`;
        console.log(`[AI Debug] Truncated large content (${contentLength} chars) to prevent stream parsing issues`);
      }
    }

    if (sanitized.logs && typeof sanitized.logs === 'string') {
      const logsLength = sanitized.logs.length;

      sanitized.logs = sanitized.logs
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

      if (logsLength > 5000) {
        sanitized.logs =
          sanitized.logs.substring(0, 5000) + `\n\n[Logs truncated - showing first 5000 of ${logsLength} characters]`;
        console.log(`[AI Debug] Truncated large logs (${logsLength} chars) to prevent stream parsing issues`);
      }
    }

    if (sanitized.jobs && Array.isArray(sanitized.jobs)) {
      const jobsCount = sanitized.jobs.length;
      if (jobsCount > 20) {
        sanitized.jobs = sanitized.jobs.slice(0, 20);
        sanitized.truncated_jobs_count = jobsCount;
        sanitized.note = `${
          sanitized.note || ''
        }\nShowing first 20 of ${jobsCount} jobs. Jobs are sorted by startTime (newest first).`.trim();
        console.log(`[AI Debug] Truncated jobs array from ${jobsCount} to 20 items to prevent large responses`);
      }
    }

    return sanitized;
  }

  async initialize(): Promise<void> {
    const globalConfig = GlobalConfigService.getInstance();
    const aiDebugConfig = await globalConfig.getConfig('aiDebug');

    if (!aiDebugConfig?.enabled) {
      throw new Error('AI Debug feature is not enabled in global_config');
    }

    this.provider = aiDebugConfig.provider || 'anthropic';

    if (this.provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'AI Debug is enabled but ANTHROPIC_API_KEY (or AI_API_KEY) environment variable is not set. ' +
            'Please set ANTHROPIC_API_KEY or AI_API_KEY in your environment to use AI debugging features.'
        );
      }
      this.anthropic = new Anthropic({
        apiKey,
      });
    } else if (this.provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'AI Debug is enabled but OPENAI_API_KEY (or AI_API_KEY) environment variable is not set. ' +
            'Please set OPENAI_API_KEY or AI_API_KEY in your environment to use AI debugging features.'
        );
      }
      this.openai = new OpenAI({
        apiKey,
      });
    } else if (this.provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.AI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'AI Debug is enabled but GEMINI_API_KEY (or AI_API_KEY) environment variable is not set. ' +
            'Please set GEMINI_API_KEY, GOOGLE_API_KEY, or AI_API_KEY in your environment to use AI debugging features.'
        );
      }
      this.gemini = new GoogleGenerativeAI(apiKey);
    }
  }

  async processQueryStream(
    userMessage: string,
    context: DebugContext,
    conversationHistory: DebugMessage[],
    onChunk: (chunk: string) => void,
    onActivity?: (activity: { type: string; message: string; details?: any }) => void
  ): Promise<string> {
    if (!this.anthropic && !this.openai && !this.gemini) {
      await this.initialize();
    }

    // CRITICAL SAFETY: Set the allowed branch for GitHub commits (PR branch only)
    if (context.lifecycleContext.pullRequest.branch) {
      this.gitHubToolsService.setAllowedBranch(context.lifecycleContext.pullRequest.branch);
    }

    const systemPrompt = this.buildSystemPrompt(context);
    let messages = this.buildMessageHistory(conversationHistory, userMessage, context);

    // Auto-detect failure states in context and add proactive reminders ONLY on first message
    // (Don't repeat reminders on every message - Gemini gets confused if it already investigated)
    if (conversationHistory.length === 0) {
      const contextBasedReminders: string[] = [];

      if (context.lifecycleContext?.deploys) {
        for (const deploy of context.lifecycleContext.deploys) {
          if (deploy.status === 'build_failed') {
            contextBasedReminders.push(
              `⚠️ ${deploy.serviceName} has status "build_failed". You MUST call get_jobs to find the build job, then get_pod_logs to see why it failed.`
            );
          }
          if (deploy.status === 'deploy_failed') {
            contextBasedReminders.push(
              `⚠️ ${deploy.serviceName} has status "deploy_failed". You MUST call get_jobs to find the deploy job, then get_pod_logs to see why it failed.`
            );
          }
        }
      }

      if (contextBasedReminders.length > 0) {
        console.log(
          `[AI Debug] Auto-detected ${contextBasedReminders.length} failure states, adding proactive reminders (first message only)`
        );
        const lastMessage = messages[messages.length - 1];
        lastMessage.content = `${
          lastMessage.content
        }\n\n[PROACTIVE INVESTIGATION REQUIRED - DO THIS AUTOMATICALLY]:\n${contextBasedReminders.join('\n')}`;
      }
    }

    if (this.provider === 'anthropic') {
      return this.queryAnthropicStream(systemPrompt, messages, onChunk, onActivity);
    } else if (this.provider === 'openai') {
      return this.queryOpenAIStream(systemPrompt, messages, onChunk, onActivity);
    } else {
      return this.queryGeminiStream(systemPrompt, messages, onChunk, onActivity);
    }
  }

  private async queryAnthropicStream(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _onActivity?: (activity: { type: string; message: string; details?: any }) => void
  ): Promise<string> {
    // Combine Kubernetes and GitHub tools
    const k8sTools = this.toolsService.getToolDefinitions();
    const githubTools = this.gitHubToolsService.getToolDefinitions();
    const tools = [...k8sTools, ...githubTools];
    const conversationMessages: any[] = messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    let fullResponse = '';
    const maxIterations = 10; // Prevent infinite loops
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemPrompt,
        messages: conversationMessages,
        tools,
      });

      // Check if AI wants to use tools
      const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
      const textBlocks = response.content.filter((block) => block.type === 'text');

      // Stream any text content
      for (const block of textBlocks) {
        if ('text' in block) {
          fullResponse += block.text;
          onChunk(block.text);
        }
      }

      // If no tool use, we're done
      if (toolUseBlocks.length === 0) {
        break;
      }

      // Execute tools and prepare results
      conversationMessages.push({
        role: 'assistant',
        content: response.content,
      });

      const toolResults: any[] = [];

      for (const toolBlock of toolUseBlocks) {
        if (toolBlock.type === 'tool_use') {
          try {
            let result;
            // Determine which service to use based on tool name
            const k8sToolNames = this.toolsService.getToolDefinitions().map((t) => t.name);
            const githubToolNames = this.gitHubToolsService.getToolDefinitions().map((t) => t.name);

            // Log tool execution
            console.log(`[AI Debug] Executing tool: ${toolBlock.name}`, toolBlock.input);

            if (k8sToolNames.includes(toolBlock.name)) {
              result = await this.toolsService.executeTool(toolBlock.name, toolBlock.input);
            } else if (githubToolNames.includes(toolBlock.name)) {
              result = await this.gitHubToolsService.executeTool(toolBlock.name, toolBlock.input);
            } else {
              throw new Error(`Unknown tool: ${toolBlock.name}`);
            }

            // Log tool result
            console.log(`[AI Debug] Tool result:`, result);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(result, null, 2),
            });
          } catch (error) {
            console.error(`[AI Debug] Tool execution failed:`, error);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify({ success: false, error: error.message }),
              is_error: true,
            });
          }
        }
      }

      conversationMessages.push({
        role: 'user',
        content: toolResults,
      });
    }

    return fullResponse;
  }

  private async queryOpenAIStream(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _onActivity?: (activity: { type: string; message: string; details?: any }) => void
  ): Promise<string> {
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      max_tokens: 4096,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        })),
      ],
    });

    let fullResponse = '';

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        onChunk(text);
      }
    }

    return fullResponse;
  }

  private async queryGeminiStream(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    onActivity?: (activity: { type: string; message: string; details?: any }) => void
  ): Promise<string> {
    try {
      const k8sTools = this.toolsService.getToolDefinitions();
      const githubTools = this.gitHubToolsService.getToolDefinitions();

      // Convert tools to Gemini function declaration format
      const tools = [...k8sTools, ...githubTools].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: tool.input_schema.properties,
          required: tool.input_schema.required || [],
        },
      }));

      const model = this.gemini.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: tools }],
        generationConfig: {
          temperature: 0.1,
          topP: 0.95,
          topK: 20,
          maxOutputTokens: 8192,
        },
      });

      const history =
        messages.length > 1
          ? messages.slice(0, -1).map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            }))
          : [];

      const chat = model.startChat({
        history,
      });

      let fullResponse = '';
      const maxIterations = 10;
      let iteration = 0;

      let currentMessage = messages[messages.length - 1].content;

      console.log(`[AI Debug Gemini] System prompt length: ${systemPrompt.length} chars`);
      console.log(`[AI Debug Gemini] History messages: ${history.length}`);
      console.log(`[AI Debug Gemini] Current message length: ${currentMessage.length} chars`);
      if (currentMessage.length > 500) {
        console.log(`[AI Debug Gemini] Current message preview:`, currentMessage.substring(0, 500));
      }

      // Detect trigger phrases that demand tool usage and add explicit reminders
      const triggerPatterns = [
        {
          pattern: /^(yes|fix it|do it|go ahead|please fix|fix that)$/i,
          action: 'commit_fix',
          reminder:
            'CRITICAL: User confirmed the fix. You MUST commit the changes NOW. If the issue is in lifecycle.yaml, call commit_lifecycle_fix. If the issue is in a referenced file (Dockerfile, Helm values, etc.), call update_referenced_file. DO NOT just say you fixed it - ACTUALLY CALL THE FUNCTION TO COMMIT THE CHANGES.',
        },
        {
          pattern: /scale.*to\s+(\d+)/i,
          action: 'scale_deployment',
          reminder:
            'CRITICAL: User asked to scale. You MUST call scale_deployment functions. DO NOT just say you did it - ACTUALLY CALL THE FUNCTIONS.',
        },
        {
          pattern: /(are you sure|check again|verify|confirm)/i,
          action: 'verification',
          reminder:
            'CRITICAL: User is asking you to verify. You MUST call get_deployment, get_pods, or list_deployments. DO NOT use stale context - CALL THE TOOLS.',
        },
        {
          pattern: /(did you|have you).*(scale|restart|patch|delete|commit|fix|update)/i,
          action: 'verification',
          reminder:
            'CRITICAL: User is asking if you performed an action. You MUST call verification tools (get_deployment, get_pods, get_lifecycle_config, get_referenced_file) to check. DO NOT assume or use stale data. DO NOT LIE - if you did not call the tool, admit it.',
        },
        {
          pattern: /use the tool|call the tool|check with.*tool/i,
          action: 'tool_required',
          reminder:
            'CRITICAL: User EXPLICITLY told you to use tools. You MUST call the appropriate function. NO EXCUSES.',
        },
        {
          pattern: /(why|what.*wrong|what.*fail|check.*log|get.*log)/i,
          action: 'diagnostic',
          reminder:
            'CRITICAL: User is asking for diagnosis. You MUST investigate using tools. Start with get_pods, then get_events, then get_pod_logs for any failing/pending pods. DO NOT respond without using tools.',
        },
      ];

      for (const trigger of triggerPatterns) {
        if (trigger.pattern.test(currentMessage)) {
          console.log(`[AI Debug Gemini] Detected trigger pattern: ${trigger.action}, adding reminder`);
          currentMessage = `${currentMessage}\n\n[SYSTEM REMINDER: ${trigger.reminder}]`;
          console.log(`[AI Debug Gemini] Modified message:`, currentMessage);
          break;
        }
      }

      console.log('[AI Debug Gemini] Starting conversation loop');
      console.log('[AI Debug Gemini] Initial message:', currentMessage.substring(0, 200));

      const functionCallTracker = new Map<string, number>();

      while (iteration < maxIterations) {
        iteration++;
        console.log(`[AI Debug Gemini] Iteration ${iteration}`);

        const result = await chat.sendMessageStream(currentMessage);
        let functionCalls: any[] = [];
        let bufferedText = ''; // Buffer text until we know if there are function calls

        for await (const chunk of result.stream) {
          const candidate = chunk.candidates?.[0];
          if (!candidate) {
            console.log('[AI Debug Gemini] Chunk has no candidate');
            continue;
          }

          console.log('[AI Debug Gemini] Candidate:', JSON.stringify(candidate, null, 2).substring(0, 500));

          // Check finish reason and safety ratings
          if (candidate.finishReason) {
            console.log('[AI Debug Gemini] Finish reason:', candidate.finishReason);

            if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL') {
              console.error('[AI Debug Gemini] MALFORMED_FUNCTION_CALL detected!');
              console.error('[AI Debug Gemini] Full candidate:', JSON.stringify(candidate, null, 2));
              console.error('[AI Debug Gemini] Iteration:', iteration);
              console.error('[AI Debug Gemini] Current message:', currentMessage.substring(0, 500));
            }
          }
          if (candidate.safetyRatings) {
            console.log('[AI Debug Gemini] Safety ratings:', JSON.stringify(candidate.safetyRatings));
          }

          // Check for text content and function calls
          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('text' in part && part.text) {
                // Filter out JSON - Gemini sometimes includes function response data
                const text = part.text;

                if (this.shouldFilterText(text)) {
                  console.log('[AI Debug Gemini] Filtered tool output from initial stream:', text.substring(0, 100));
                  continue;
                }

                // Buffer the text - we'll decide whether to stream it after we know if there are function calls
                bufferedText += text;
              }
              if ('functionCall' in part && part.functionCall) {
                functionCalls.push(part.functionCall);
              }
            }
          } else {
            console.log('[AI Debug Gemini] Candidate has no content.parts');
          }
        }

        // If there are function calls, discard any buffered announcement text (like "I will check...")
        // and let the function results speak for themselves
        console.log(`[AI Debug Gemini] Found ${functionCalls.length} function calls`);
        console.log('[AI Debug Gemini] Buffered text:', bufferedText.substring(0, 200));

        if (functionCalls.length === 0) {
          // Check if this is an announcement of intent rather than a final answer
          const isAnnouncement = bufferedText.match(
            /(I will|I'll|I am|I'm going to|Let me|I need to|I should|Checking|Getting|Fetching|Scaling) (check|get|fetch|scale|restart|look|examine|investigate|status|pods|events|logs|deployment)/i
          );

          if (isAnnouncement && iteration === 1) {
            // This is an announcement - prompt Gemini to actually execute
            console.log('[AI Debug Gemini] Detected announcement, prompting to execute');
            currentMessage = 'Please proceed with that action now.';
            continue;
          }

          // No function calls and not an announcement - stream the buffered text and we're done
          console.log('[AI Debug Gemini] No function calls, streaming buffered text and ending');
          if (bufferedText) {
            fullResponse += bufferedText;
            onChunk(bufferedText);
          }
          break;
        }

        // There are function calls - discard announcement text, execute functions
        console.log(
          '[AI Debug Gemini] Discarding announcement text, executing functions:',
          functionCalls.map((f) => f.name)
        );

        // Track function calls to detect loops
        for (const fc of functionCalls) {
          const count = functionCallTracker.get(fc.name) || 0;
          functionCallTracker.set(fc.name, count + 1);
        }

        // Execute functions and prepare response
        const functionResponses: any[] = [];

        for (const functionCall of functionCalls) {
          try {
            console.log(`[AI Debug Gemini] Executing function: ${functionCall.name}`, functionCall.args);

            const callCount = functionCallTracker.get(functionCall.name) || 0;
            if (callCount > 3) {
              console.warn(
                `[AI Debug Gemini] WARNING: ${functionCall.name} has been called ${callCount} times - possible loop`
              );
            }

            const activityMessage = this.getFriendlyActivityMessage(functionCall.name, functionCall.args);
            onActivity?.({
              type: 'tool_call',
              message: activityMessage,
              details: { tool: functionCall.name, args: functionCall.args },
            });

            const k8sToolNames = this.toolsService.getToolDefinitions().map((t) => t.name);
            const githubToolNames = this.gitHubToolsService.getToolDefinitions().map((t) => t.name);

            let result;
            if (k8sToolNames.includes(functionCall.name)) {
              result = await this.toolsService.executeTool(functionCall.name, functionCall.args);
            } else if (githubToolNames.includes(functionCall.name)) {
              result = await this.gitHubToolsService.executeTool(functionCall.name, functionCall.args);
            } else {
              throw new Error(`Unknown function: ${functionCall.name}`);
            }

            console.log(
              `[AI Debug Gemini] Function result for ${functionCall.name}:`,
              JSON.stringify(result).substring(0, 200)
            );

            const sanitizedResult = this.sanitizeFunctionResult(result);

            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: sanitizedResult,
              },
            });
          } catch (error) {
            console.error(`[AI Debug Gemini] Function execution error for ${functionCall.name}:`, error);
            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: { success: false, error: error.message },
              },
            });
          }
        }

        // Send function responses back
        // For Gemini, we need to send function responses and then immediately stream the next turn
        console.log(`[AI Debug Gemini] Sending ${functionResponses.length} function responses back to Gemini`);

        // Log response sizes for debugging
        for (const resp of functionResponses) {
          const respStr = JSON.stringify(resp.functionResponse.response);
          console.log(`[AI Debug Gemini] Response for ${resp.functionResponse.name}: ${respStr.length} chars`);
          if (respStr.length > 1000) {
            console.log(`[AI Debug Gemini] Large response preview:`, respStr.substring(0, 200));
          }
        }

        let functionResponseResult;
        try {
          functionResponseResult = await chat.sendMessageStream(functionResponses);
        } catch (error) {
          console.error(`[AI Debug Gemini] Error sending function responses:`, error);
          console.error(
            `[AI Debug Gemini] Function responses that failed:`,
            JSON.stringify(functionResponses, null, 2).substring(0, 1000)
          );
          throw error;
        }

        let hasMoreFunctionCalls = false;
        functionCalls = [];
        let interpretedText = '';
        let bufferedInterpretedText = '';

        for await (const chunk of functionResponseResult.stream) {
          const candidate = chunk.candidates?.[0];

          if (candidate?.finishReason === 'MALFORMED_FUNCTION_CALL') {
            console.error('[AI Debug Gemini] MALFORMED_FUNCTION_CALL in function response stream!');
            console.error('[AI Debug Gemini] Full candidate:', JSON.stringify(candidate, null, 2));
            console.error('[AI Debug Gemini] Iteration:', iteration);
            console.error(
              '[AI Debug Gemini] Last function responses:',
              JSON.stringify(functionResponses, null, 2).substring(0, 2000)
            );
          }

          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('text' in part && part.text) {
                // Filter out JSON output - Gemini sometimes outputs function results as text
                const text = part.text;

                if (this.shouldFilterText(text)) {
                  console.log(
                    '[AI Debug Gemini] Filtered tool output from function response stream:',
                    text.substring(0, 100)
                  );
                  continue;
                }

                // Buffer the text instead of streaming immediately
                // We'll decide whether to stream it after we know if there are more function calls
                bufferedInterpretedText += text;
              }
              if ('functionCall' in part && part.functionCall) {
                functionCalls.push(part.functionCall);
                hasMoreFunctionCalls = true;
              }
            }
          }
        }

        // Now decide what to do with the buffered text
        if (hasMoreFunctionCalls) {
          // More function calls coming - discard announcement text like "Checking status..."
          console.log(
            '[AI Debug Gemini] More function calls detected, discarding buffered text:',
            bufferedInterpretedText.substring(0, 100)
          );
        } else {
          // No more function calls - this is the final interpretation, stream it
          interpretedText = bufferedInterpretedText;
          fullResponse += interpretedText;
          onChunk(interpretedText);
        }

        console.log(
          `[AI Debug Gemini] After function responses - got ${interpretedText.length} chars of text, ${functionCalls.length} new function calls`
        );
        console.log('[AI Debug Gemini] Interpreted text:', interpretedText.substring(0, 200));

        if (!hasMoreFunctionCalls) {
          console.log('[AI Debug Gemini] No more function calls, ending loop');
          break;
        }

        console.log('[AI Debug Gemini] More function calls detected, continuing loop');
        // Reset current message for next iteration - the chat context maintains history
        currentMessage = '';
      }

      if (iteration >= maxIterations) {
        console.error(`[AI Debug Gemini] Hit max iterations (${maxIterations}), forcing end of conversation`);
        const warningMessage = `⚠️ Investigation incomplete - hit maximum iteration limit. The AI made ${maxIterations} tool calls but couldn't reach a conclusion. This may indicate:\n- Too many services to check\n- AI stuck in a loop\n- Issue is unclear from available data`;
        fullResponse += warningMessage;
        onChunk(warningMessage);
      }

      console.log('[AI Debug Gemini] Conversation complete. Total response length:', fullResponse.length);
      console.log('[AI Debug Gemini] Final response (before cleanup):', fullResponse.substring(0, 500));

      // Clean up any JSON fragments that slipped through
      const cleanedResponse = this.cleanupResponse(fullResponse);
      console.log('[AI Debug Gemini] Cleaned response length:', cleanedResponse.length);

      return cleanedResponse;
    } catch (error: any) {
      console.error('[AI Debug Gemini] Uncaught error in queryGeminiStream:', error);
      console.error('[AI Debug Gemini] Error type:', typeof error);
      console.error('[AI Debug Gemini] Error keys:', Object.keys(error || {}));
      throw new Error(`Gemini API error: ${error?.message || error?.toString() || 'Unknown error'}`);
    }
  }

  private buildSystemPrompt(context: DebugContext): string {
    const lc = context.lifecycleContext;

    return `<role>
You are a Kubernetes debugging assistant for Lifecycle, a platform that creates ephemeral PR environments.
</role>

<critical_rules>
1. ALWAYS call tools for current state - context is stale
2. NO JSON in responses - write plain English ("✅ 1/1 ready" not {"ready": 1})
3. NO announcements - don't say "I will check..." - just call tools and report findings
4. VERIFY all actions - after scale/patch/commit, call verification tools
5. NEVER lie - don't claim you did something without calling the function
6. When user says "yes" to a fix:
   - MUST call commit_lifecycle_fix or update_referenced_file
   - MUST verify with get_lifecycle_config or get_referenced_file
   - Only report success if verification confirms the change
</critical_rules>

<tools>
K8s READ: get_pods, get_deployment, list_deployments, get_events, get_pod_logs, get_jobs
K8s WRITE: scale_deployment, patch_deployment, restart_deployment, delete_pod
GitHub: get_lifecycle_config, commit_lifecycle_fix, get_referenced_file, update_referenced_file, list_directory
</tools>

<workflow>
Investigation: get_pods/get_jobs → get_pod_logs (if failures) → get_referenced_file (config check) → fix root cause
Common patterns:
- build_failed: get_jobs + get_pod_logs for build job
- deploy_failed: get_jobs + get_pod_logs for deploy job
- 0 replicas: get_referenced_file for Helm values (look for replicaCount)
- CrashLoop: get_pod_logs for app pod
Jobs: Sorted by startTime (newest first). After fix, check LATEST job only.
</workflow>

<context>
Repository: ${lc.pullRequest.fullName}
Branch: ${lc.pullRequest.branch}
Namespace: ${lc.build.namespace}

For GitHub tools, extract:
- owner = "${lc.pullRequest.fullName?.split('/')[0] || 'unknown'}"
- repository_name = "${lc.pullRequest.fullName?.split('/')[1] || 'unknown'}"
- branch = "${lc.pullRequest.branch || 'unknown'}"
</context>

<examples>
Example 1 - Fix with Verification:
User: "why 0 replicas?"
AI: [calls get_referenced_file] "⚠️ Helm values has replicaCount: 0. Fix?"
User: "yes"
AI: [calls update_referenced_file with replicaCount: 1, then calls get_referenced_file to verify]
    [IF verified]: "✅ Updated replicaCount to 1 in grpc-service.yaml"
    [IF not verified]: "❌ Update failed, trying again..." [retry]

Example 2 - Latest Job Check:
AI calls get_jobs, sees:
  [{"name": "grpc-echo-...-build-xyz", "startTime": "2025-10-04T08:25:00Z", "succeeded": 1},  // NEWEST
   {"name": "grpc-echo-...-build-abc", "startTime": "2025-10-04T08:00:00Z", "failed": 1}]    // OLD
CORRECT: "✅ grpc-echo build succeeded" (checking newest job)
WRONG: "❌ grpc-echo build failed" (that's the old job, ignore it)
</examples>

<pr_context>
- PR #${lc.pullRequest.number}: "${lc.pullRequest.title}"
- Full Name: ${lc.pullRequest.fullName}
- Author: ${lc.pullRequest.username}
- Branch: ${lc.pullRequest.branch} → ${lc.pullRequest.baseBranch}
- Status: ${lc.pullRequest.status}

BUILD:
- Status: ${lc.build.status}${lc.build.statusMessage ? ` - ${lc.build.statusMessage}` : ''}
- Namespace: ${lc.build.namespace}
- SHA: ${lc.build.sha}

REPOSITORY:
- Name: ${lc.repository.name}

DEPLOYS (${lc.deploys.length}):
${lc.deploys
  .map(
    (d) =>
      `- ${d.serviceName}: ${d.status}${d.statusMessage ? ` - ${d.statusMessage}` : ''} (type: ${d.type}, image: ${
        d.dockerImage || 'N/A'
      })`
  )
  .join('\n')}

DEPLOYABLES (${lc.deployables?.length || 0}):
${
  lc.deployables
    ?.map(
      (dep) => `- ${dep.serviceName}:
  - Repo: ${dep.repositoryId || 'N/A'}
  - Branch: ${dep.commentBranchName || dep.defaultBranchName || 'N/A'}
  - Builder: ${dep.builder?.engine || 'N/A'}
  - Helm Chart: ${dep.helm?.chart || 'N/A'}
  - Helm ValueFiles: ${dep.helm?.valueFiles?.join(', ') || 'none'}
  - DependsOn: ${dep.deploymentDependsOn?.join(', ') || 'none'}`
    )
    .join('\n') || 'No deployables configured'
}

===== LIFECYCLE.YAML CONFIGURATION =====
${
  context.lifecycleYaml
    ? context.lifecycleYaml.error
      ? `⚠️ Could not fetch lifecycle.yaml: ${context.lifecycleYaml.error}`
      : `File: ${context.lifecycleYaml.path}

\`\`\`yaml
${context.lifecycleYaml.content}
\`\`\`

This is the source configuration for this environment. Check this for probe ports, resource limits, Dockerfile paths, etc.`
    : '⚠️ lifecycle.yaml not available'
}

===== KUBERNETES STATE =====

⚠️⚠️⚠️ THIS DATA IS STALE - FOR REFERENCE ONLY ⚠️⚠️⚠️
The data below is a SNAPSHOT from when conversation started.
DO NOT use this data to report current status.
ALWAYS call tools (get_deployment, get_pods, list_deployments) for current state.
If you report status from this section without calling tools, you are LYING.

SERVICES (${context.services.length}):
${context.services
  .map((s) => {
    let info = `- ${s.name}: ${s.status}\n`;

    // Add deployment info if available
    if (s.deployment) {
      info += `  Deployment:\n`;
      info += `    • K8s Name: ${s.deployment.name} (USE THIS for scale/patch/restart operations)\n`;
      info += `    • Replicas: ${s.deployment.replicas.ready}/${s.deployment.replicas.desired} ready, ${s.deployment.replicas.available} available\n`;
      info += `    • Strategy: ${s.deployment.strategy}\n`;
      info += `    • Containers: ${s.deployment.containers.map((c) => `${c.name} (${c.image})`).join(', ')}\n`;
      if (s.deployment.conditions && s.deployment.conditions.length > 0) {
        const progressingCond = s.deployment.conditions.find((c) => c.type === 'Progressing');
        const availableCond = s.deployment.conditions.find((c) => c.type === 'Available');
        if (progressingCond)
          info += `    • Progressing: ${progressingCond.status} - ${
            progressingCond.message || progressingCond.reason
          }\n`;
        if (availableCond) info += `    • Available: ${availableCond.status}\n`;
      }
    } else {
      info += `  Deployment: Not found (might use StatefulSet, DaemonSet, or not deployed yet)\n`;
    }

    // Add pod details
    const podDetails =
      s.pods.length > 0
        ? s.pods
            .map(
              (p) =>
                `    • ${p.name}: ${p.phase}${
                  p.containerStatuses?.length > 0
                    ? ' - ' +
                      p.containerStatuses.map((cs) => `${cs.name}: ${cs.ready ? 'ready' : 'not ready'}`).join(', ')
                    : ''
                }`
            )
            .join('\n')
        : '    • No pods found';
    info += `  Pods:\n${podDetails}\n`;

    // Add issues if any
    if (s.issues.length > 0) {
      info += `  Issues: ${s.issues.length}`;
    }

    return info;
  })
  .join('\n')}

IDENTIFIED ISSUES:
${
  context.services
    .flatMap((s) => s.issues)
    .map((issue) => `[${issue.severity.toUpperCase()}] ${issue.title}: ${issue.description}`)
    .join('\n') || 'No issues detected'
}

${
  context.warnings && context.warnings.length > 0
    ? `
WARNINGS:
${context.warnings.map((w) => `⚠️ ${w.source}: ${w.message}`).join('\n')}
`
    : ''
}

GUIDELINES:
1. **TOOLS FIRST - ALWAYS - ACTUALLY CALL THEM**: When user asks about failures/issues, IMMEDIATELY CALL tools (get_pods, get_events, get_pod_logs). Don't say "I'll check" - CALL THE FUNCTION. Never respond without gathering evidence by CALLING functions.
2. **ZERO NARRATION - ESPECIALLY AFTER WRITE OPERATIONS**: NEVER share your thinking process, next steps, or what tools you're using. Users see ONLY your final findings.
   - WRONG: "✅ Scaled to 1. Checking status..." ❌ NO! Don't announce verification - just do it and report results
   - RIGHT: [Scales, then verifies silently, then reports] "✅ Scaled to 1 replica each. All healthy."
   - After scaling/patching/restarting: Call verification functions SILENTLY, present final status ONLY
3. **IMMEDIATE EXECUTION FOR CLEAR REQUESTS**:
   - "scale them up" or "scale to 1" → IMMEDIATELY call scale_deployment, no questions asked
   - "do I have scaled down deployments?" → IMMEDIATELY call list_deployments, no announcement
   - "why is X failing?" → IMMEDIATELY call get_pods + get_events + get_pod_logs
   - Only ask clarifying questions if the request is genuinely ambiguous (e.g., "can you scale?" without target)
   - **TRIGGER PHRASES THAT DEMAND TOOL CALLS**:
     * "are you sure?" → MUST call verification tools (get_deployment, get_pods, list_deployments)
     * "check again" → MUST call appropriate status tools
     * "what does X say?" → MUST call the tool to fetch X (e.g., get_deployment, get_pods)
     * "did you [action]?" → MUST call tools to verify the action was performed
     * ANY question about current state → MUST call tools, NEVER use stale context
4. **NEVER OUTPUT RAW JSON - ZERO TOLERANCE**: Tool responses are JSON - you MUST interpret them. If you copy-paste JSON into your response, you're failing. Parse it, understand it, present it in English. NO curly braces { }, NO brackets [ ], NO JSON keys like "success" or "get_deployment_response". NO code blocks with tool_outputs.
5. **EVIDENCE FIRST**: For ANY issue, check logs/events/configs BEFORE proposing fixes. Never guess.
6. **BE EXACT**: State ONLY what's in the logs/events. If logs show port 8080 and events show 8011, don't mention other ports.
7. **NO ASSUMPTIONS**: Words like "likely", "probably", "might be" mean you're guessing. Check instead.
8. **CITE EVIDENCE**: "Logs show X" or "Events indicate Y" - reference actual data from tools.
9. **NO EMBELLISHMENT**: Don't add details, ports, or information not explicitly in the evidence.
10. **USE MARKDOWN FORMATTING**: Use line breaks, bullet points, bold for emphasis. Makes responses easier to read.
11. **CODE FORMATTING - MANDATORY FOR ALL CODE/YAML/JSON**:
   - **CRITICAL**: When showing lifecycle.yaml or ANY YAML: You MUST start with THREE backticks followed by "yaml"
   - Then show the YAML content on new lines
   - Then end with THREE backticks on a new line
   - The format is: backtick-backtick-backtick-yaml (newline) content (newline) backtick-backtick-backtick
   - Same for JSON: backtick-backtick-backtick-json (newline) content (newline) backtick-backtick-backtick
   - Same for logs: backtick-backtick-backtick-bash (newline) content (newline) backtick-backtick-backtick
   - If you show YAML/JSON/code WITHOUT code fences, the UI will break and look terrible
   - Inline code (single words/values) use single backticks: \`value\`
12. Be EXTREMELY CONCISE. Maximum 2-3 sentences unless diagnosing complex issues.
13. Start with status/findings immediately. No preamble or thinking process.
14. Use emojis: ✅ healthy, ⚠️ issue, ❌ failing.
15. For issues: state problem with evidence + "Fix?" Use line breaks between statements.
16. After write operations, VERIFY with get_deployment/get_pods and report: "✅ Fixed. Now 1/1 ready." or "❌ Failed: [reason]"
17. If you can't find evidence after using tools, say "Can't determine from logs. Issue unclear."

Example GOOD responses (evidence-based, concise, well-formatted):
- Single line: "✅ All 4 deployments healthy, all pods running."

- Multi-line with breaks:
  "⚠️ grpc-echo has 0 desired replicas. Deployment was scaled down.

  Scale back to 1?"

- User says "1" (meaning scale to 1):
  AI: [Uses scale_deployment for all deployments, then SILENTLY uses get_deployment to verify, NO "Checking status..." announcement]
  "✅ Scaled grpc-echo, nginx, jenkins to 1 replica each. All healthy."

  OR if verification shows issues:
  "✅ Scaled to 1 replica each. ⚠️ nginx pod failing - image pull error."

- After scaling with verification (CORRECT - no announcement):
  AI: [Scales, verifies silently, presents final status]
  "✅ Scaled to 1. Deployment now 1/1 ready."

- After verification shows issue (CORRECT - checked silently, reports finding):
  "⚠️ Scaled to 1, but pod failing. Logs show: 'Port 8080 already in use'. Need to fix port conflict."

BAD responses (NEVER DO THIS):
- User: "that is not good" AI: "I'll check the events and logs..." but NO function calls made ❌ NO! Actually CALL get_events and get_pod_logs!
- AI: "I've reviewed the events and logs" but logs show 0 function calls ❌ NO! You never called them - call the functions!
- AI: "I need the pod name" instead of calling get_pods ❌ NO! Use your tools!
- AI outputs code blocks with tool_outputs containing JSON dicts ❌ NO! This is raw function output - interpret it!
- AI: " [{'image': 'docker.io/...'}, ...]" (leftover JSON fragment) ❌ NO! Filter these!
- AI: '{"success": true}' or "{'success': True}" ❌ NO! Interpret: "✅ Scaled to 1 replica"
- AI: '{"get_events_response": {...}}' ❌ NO! NEVER show raw JSON!
- AI outputs multiple JSON responses in a row ❌ NO! Interpret the results!
- ANY message that includes JSON with curly braces or brackets ❌ NO! Only human-readable text
- User: "Why failing?" AI: "No logs available" ❌ NO! Use get_pod_logs tool!
- User: "Build failing?" AI: "Need build logs. Please provide." ❌ NO! Fetch with tools!
- AI: "Missing branch information" when it's in context ❌ NO! Read the context!
- "I need to check the pod logs..." ❌ NO! Check silently, report findings
- "Let me get the latest pod's logs..." ❌ NO! Get them silently
- "The app is likely on port 50051" ❌ NO! Check logs, don't guess
- "Probably a port issue" ❌ NO! "Probably" = assumption
- Any raw JSON output from tools ❌ NO! Interpret and present in natural language

</pr_context>
`;
  }

  private buildMessageHistory(
    conversationHistory: DebugMessage[],
    currentMessage: string,
    context: DebugContext
  ): Array<{ role: string; content: string }> {
    const messages = conversationHistory.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const contextSummary = this.generateContextSummary(context);

    let finalMessage = currentMessage;
    if (!currentMessage.includes('[Current State]')) {
      finalMessage = `${currentMessage}\n\n[Current State]\n${contextSummary}`;
    }

    messages.push({
      role: 'user',
      content: finalMessage,
    });

    return messages;
  }

  private generateContextSummary(context: DebugContext): string {
    const lc = context.lifecycleContext;
    const criticalIssues = context.services.flatMap((s) => s.issues).filter((i) => i.severity === 'critical');

    return `PR #${lc.pullRequest.number} | Build: ${lc.build.status} | Namespace: ${context.namespace}
Services: ${context.services.length} | Critical Issues: ${criticalIssues.length}`;
  }
}
