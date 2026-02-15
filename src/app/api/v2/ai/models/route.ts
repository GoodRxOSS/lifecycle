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
import { getLogger } from 'server/lib/logger';
import AIAgentConfigService from 'server/services/aiAgentConfig';
import { transformProviderModels } from 'server/services/ai/utils/modelTransformation';

/**
 * @openapi
 * /api/v2/ai/models:
 *   get:
 *     summary: Get available AI models
 *     description: >
 *       Returns a list of enabled AI models from the effective configuration.
 *       Each model entry includes the provider, model ID, display name, max tokens,
 *       and whether it is the default. Returns an empty array if the AI agent is disabled.
 *       Use this endpoint to populate a model-picker in the UI before calling the chat endpoint.
 *     tags:
 *       - AI Chat
 *     operationId: getAIModels
 *     responses:
 *       '200':
 *         description: List of available AI models. Empty array when AI is disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAIModelsSuccessResponse'
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
    return successResponse({ models: [] }, { status: 200 }, req);
  }

  if (!aiAgentConfig.providers || !Array.isArray(aiAgentConfig.providers)) {
    getLogger().warn('AI: config missing providers array');
    return successResponse({ models: [] }, { status: 200 }, req);
  }

  const models = transformProviderModels(aiAgentConfig.providers);

  getLogger().info(
    `AI: models endpoint returning ${models.length} models: ${models
      .map((m: any) => `${m.displayName}[provider=${m.provider}]`)
      .join(', ')}`
  );

  return successResponse({ models }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
