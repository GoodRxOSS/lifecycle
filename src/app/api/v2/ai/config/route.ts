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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse } from 'server/lib/response';
import AIAgentConfigService from 'server/services/aiAgentConfig';

/**
 * @openapi
 * /api/v2/ai/config:
 *   get:
 *     summary: Check AI agent configuration status
 *     description: Returns whether AI is enabled, which provider is active, and if API keys are configured.
 *     tags:
 *       - AI Chat
 *     operationId: getAIConfig
 *     responses:
 *       '200':
 *         description: AI configuration status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAIConfigSuccessResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const aiAgentConfigService = AIAgentConfigService.getInstance();
  const aiAgentConfig = await aiAgentConfigService.getEffectiveConfig();

  if (!aiAgentConfig?.enabled) {
    return successResponse({ enabled: false }, { status: 200 }, req);
  }

  const enabledProvider = aiAgentConfig.providers?.find((p: any) => p.enabled);
  const provider = enabledProvider?.name || 'anthropic';
  const apiKeySet = provider === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY;

  return successResponse({ enabled: true, provider, configured: apiKeySet }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
