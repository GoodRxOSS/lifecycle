/**
 * Copyright 2026 GoodRx, Inc.
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
import AgentSessionConfigService from 'server/services/agentSessionConfig';

/**
 * @openapi
 * /api/v2/ai/config/agent-session/effective:
 *   get:
 *     summary: Get effective global Agent Session configuration
 *     tags:
 *       - Agent Session Config
 *     operationId: getEffectiveGlobalAgentSessionConfig
 *     responses:
 *       '200':
 *         description: Effective global Agent Session configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetEffectiveGlobalAgentSessionConfigSuccessResponse'
 */
const getHandler = async (req: NextRequest) => {
  const config = await AgentSessionConfigService.getInstance().getEffectiveConfig();
  return successResponse(config, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
