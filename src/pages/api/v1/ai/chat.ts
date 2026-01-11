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

import { NextApiRequest, NextApiResponse } from 'next';
import { defaultDb, defaultRedis } from 'server/lib/dependencies';
import AIAgentContextService from 'server/services/ai/context/gatherer';
import AIAgentConversationService from 'server/services/ai/conversation/storage';
import AIAgentService from 'server/services/aiAgent';
import GlobalConfigService from 'server/services/globalConfig';
import { getLogger } from 'server/lib/logger/index';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const globalConfig = GlobalConfigService.getInstance();
    const aiAgentConfig = await globalConfig.getConfig('aiAgent');

    if (!aiAgentConfig?.enabled) {
      res.write(
        `data: ${JSON.stringify({
          error: 'AI Agent is not enabled',
          code: 'AI_AGENT_DISABLED',
        })}\n\n`
      );
      return res.end();
    }

    const { buildUuid, message, clearHistory, provider, modelId, isSystemAction } = req.body;

    if (!buildUuid || !message) {
      return res.status(400).json({
        error: 'Missing required fields: buildUuid and message',
      });
    }

    const aiAgentContextService = new AIAgentContextService(defaultDb, defaultRedis);
    const conversationService = new AIAgentConversationService(defaultDb, defaultRedis);
    const llmService = new AIAgentService(defaultDb, defaultRedis);

    try {
      if (provider && modelId) {
        await llmService.initializeWithMode('investigate', provider, modelId);
      } else {
        await llmService.initialize();
      }
    } catch (error) {
      getLogger({ buildUuid }).error({ error }, 'Failed to initialize LLM service');
      res.write(
        `data: ${JSON.stringify({
          error: error.message,
          code: 'LLM_INIT_ERROR',
        })}\n\n`
      );
      return res.end();
    }

    if (clearHistory) {
      await conversationService.clearConversation(buildUuid);
    }

    const conversation = await conversationService.getConversation(buildUuid);
    const conversationHistory = conversation?.messages || [];

    let context;
    try {
      context = await aiAgentContextService.gatherFullContext(buildUuid);
    } catch (error) {
      getLogger({ buildUuid }).error({ error }, 'Failed to gather context');
      res.write(
        `data: ${JSON.stringify({
          error: `Build not found: ${error.message}`,
          code: 'CONTEXT_ERROR',
        })}\n\n`
      );
      return res.end();
    }

    let aiResponse = '';
    let isJsonResponse = false;
    let totalInvestigationTimeMs = 0;
    try {
      const mode = await llmService.classifyUserIntent(message, conversationHistory);
      getLogger({ buildUuid }).info(`Classified user intent as: ${mode}`);

      const result = await llmService.processQueryStream(
        message,
        context,
        conversationHistory,
        (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        },
        (activity) => {
          res.write(`data: ${JSON.stringify(activity)}\n\n`);
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        },
        undefined,
        mode
      );

      aiResponse = result.response;
      isJsonResponse = result.isJson;
      totalInvestigationTimeMs = result.totalInvestigationTimeMs;

      // If this is a JSON investigation response, send it as a special complete_json event
      // This ensures frontend receives the cleaned JSON instead of trying to parse accumulated chunks
      if (isJsonResponse) {
        // Inject repository info into the JSON response for GitHub links
        try {
          const parsed = JSON.parse(aiResponse);
          if (parsed.type === 'investigation_complete' && context.lifecycleContext?.pullRequest) {
            const fullName = context.lifecycleContext.pullRequest.fullName;
            const branch = context.lifecycleContext.pullRequest.branch;
            if (fullName && branch) {
              const [owner, name] = fullName.split('/');
              parsed.repository = { owner, name, branch };

              // Ensure all string fields are properly escaped for JSON serialization
              const sanitizeForJson = (obj: any): any => {
                if (typeof obj === 'string') {
                  // Already properly escaped by backend - no need to re-escape
                  return obj;
                } else if (Array.isArray(obj)) {
                  return obj.map((item) => sanitizeForJson(item));
                } else if (obj && typeof obj === 'object') {
                  const sanitized: any = {};
                  for (const key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                      sanitized[key] = sanitizeForJson(obj[key]);
                    }
                  }
                  return sanitized;
                }
                return obj;
              };

              const sanitized = sanitizeForJson(parsed);
              aiResponse = JSON.stringify(sanitized, null, 2);

              // Validate the final JSON before sending
              JSON.parse(aiResponse); // This will throw if invalid
            }
          }
        } catch (e) {
          getLogger({ buildUuid }).error(
            { error: e instanceof Error ? e.message : String(e), responseLength: aiResponse.length },
            'JSON validation failed for investigation response'
          );
          // Convert to plain text message
          aiResponse =
            '⚠️ Investigation completed but response formatting failed. Please try asking a more specific question.';
          isJsonResponse = false; // Treat as plain text
        }

        if (isJsonResponse) {
          res.write(
            `data: ${JSON.stringify({ type: 'complete_json', content: aiResponse, totalInvestigationTimeMs })}\n\n`
          );
        }
      }
    } catch (error: any) {
      getLogger({ buildUuid }).error({ error }, 'LLM query failed');

      // Check if it's a rate limit error
      if (
        error?.status === 429 ||
        error?.error?.error?.type === 'rate_limit_error' ||
        error?.message?.includes('RATE_LIMIT_EXCEEDED') ||
        error?.message?.includes('quota exceeded')
      ) {
        res.write(
          `data: ${JSON.stringify({
            error:
              'Rate limit exceeded. Please wait a moment and try again. The AI service is currently handling many requests.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: 60,
          })}\n\n`
        );
      } else {
        res.write(
          `data: ${JSON.stringify({
            error: error?.message || error?.toString() || 'AI service error',
            code: 'LLM_API_ERROR',
          })}\n\n`
        );
      }
      res.end();
      return;
    }

    await conversationService.addMessage(buildUuid, {
      role: 'user',
      content: message,
      timestamp: Date.now(),
      isSystemAction,
    });

    await conversationService.addMessage(buildUuid, {
      role: 'assistant',
      content: aiResponse,
      timestamp: Date.now(),
    });

    res.write(`data: ${JSON.stringify({ type: 'complete', totalInvestigationTimeMs })}\n\n`);
    res.end();
  } catch (error: any) {
    getLogger().error({ error }, 'Unexpected error in AI agent chat');
    res.write(`data: ${JSON.stringify({ error: error?.message || 'Internal error' })}\n\n`);
    res.end();
  }
}
