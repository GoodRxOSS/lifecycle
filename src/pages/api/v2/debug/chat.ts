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
import AIDebugService from 'server/services/aiDebug';
import AIDebugConversationService from 'server/services/aiDebugConversation';
import AIDebugLLMService from 'server/services/aiDebugLLM';
import GlobalConfigService from 'server/services/globalConfig';
import rootLogger from 'server/lib/logger';

const logger = rootLogger.child({ filename: 'api/v2/debug/chat' });

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
    const aiDebugConfig = await globalConfig.getConfig('aiDebug');

    if (!aiDebugConfig?.enabled) {
      res.write(
        `data: ${JSON.stringify({
          error: 'AI Debugging is not enabled',
          code: 'AI_DEBUG_DISABLED',
        })}\n\n`
      );
      return res.end();
    }

    const { buildUuid, message, clearHistory } = req.body;

    if (!buildUuid || !message) {
      return res.status(400).json({
        error: 'Missing required fields: buildUuid and message',
      });
    }

    const aiDebugService = new AIDebugService(defaultDb, defaultRedis);
    const conversationService = new AIDebugConversationService(defaultDb, defaultRedis);
    const llmService = new AIDebugLLMService(defaultDb, defaultRedis);

    try {
      await llmService.initialize();
    } catch (error) {
      logger.error({ error }, 'Failed to initialize LLM service');
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
      context = await aiDebugService.gatherFullContext(buildUuid);

      if (context.warnings || context.errors) {
        res.write(
          `data: ${JSON.stringify({
            type: 'context_status',
            warnings: context.warnings,
            errors: context.errors,
          })}\n\n`
        );
      }
    } catch (error) {
      logger.error({ error, buildUuid }, 'Failed to gather context');
      res.write(
        `data: ${JSON.stringify({
          error: `Build not found: ${error.message}`,
          code: 'CONTEXT_ERROR',
        })}\n\n`
      );
      return res.end();
    }

    let aiResponse = '';
    try {
      res.write(`data: ${JSON.stringify({ type: 'stream_start' })}\n\n`);

      aiResponse = await llmService.processQueryStream(
        message,
        context,
        conversationHistory,
        (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        },
        (activity) => {
          res.write(`data: ${JSON.stringify({ ...activity, type: 'activity' })}\n\n`);
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        }
      );

      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
    } catch (error: any) {
      logger.error({ error, errorMessage: error?.message, errorStack: error?.stack }, 'LLM query failed');

      // Check if it's a rate limit error
      if (error?.status === 429 || error?.error?.error?.type === 'rate_limit_error') {
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
    });

    await conversationService.addMessage(buildUuid, {
      role: 'assistant',
      content: aiResponse,
      timestamp: Date.now(),
    });

    res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
    res.end();
  } catch (error: any) {
    logger.error(
      { error, errorMessage: error?.message, errorStack: error?.stack },
      'Unexpected error in AI debug chat'
    );
    res.write(`data: ${JSON.stringify({ error: error?.message || 'Internal error' })}\n\n`);
    res.end();
  }
}
