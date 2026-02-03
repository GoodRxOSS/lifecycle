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

/**
 * @openapi
 * /api/v2/ai/agent-config/repos:
 *   get:
 *     summary: List all repository AI agent config overrides
 *     description: Returns an array of all repository-level AI agent configuration overrides.
 *     tags:
 *       - AI Agent Config
 *     operationId: listRepoAIAgentConfigs
 *     responses:
 *       '200':
 *         description: Array of repository config overrides
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListRepoAIAgentConfigsSuccessResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const service = AIAgentConfigService.getInstance();
  const configs = await service.listRepoConfigs();
  getLogger().info('AIAgentConfig: repo configs listed via=api count=' + configs.length);
  return successResponse(configs, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
