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

import JsonSchema from 'jsonschema';
import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { agentSessionControlPlaneConfigSchema } from 'server/lib/validation/agentSessionConfigSchemas';
import { AgentSessionConfigValidationError } from 'server/lib/validation/agentSessionConfigValidator';
import AgentSessionConfigService from 'server/services/agentSessionConfig';

/**
 * @openapi
 * /api/v2/ai/config/agent-session:
 *   get:
 *     summary: Get global Agent Session configuration
 *     tags:
 *       - Agent Session Config
 *     operationId: getGlobalAgentSessionConfig
 *     responses:
 *       '200':
 *         description: Global Agent Session configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAgentSessionConfigSuccessResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Update global Agent Session configuration
 *     tags:
 *       - Agent Session Config
 *     operationId: updateGlobalAgentSessionConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentSessionControlPlaneConfig'
 *     responses:
 *       '200':
 *         description: Updated global Agent Session configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAgentSessionConfigSuccessResponse'
 *       '400':
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const config = await AgentSessionConfigService.getInstance().getGlobalConfig();
  return successResponse(config, { status: 200 }, req);
};

const putHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const validator = new JsonSchema.Validator();
  const result = validator.validate(body, agentSessionControlPlaneConfigSchema);
  if (!result.valid) {
    const messages = result.errors.map((entry) => entry.stack).join('; ');
    return errorResponse(new Error(`Validation failed: ${messages}`), { status: 400 }, req);
  }

  try {
    const config = await AgentSessionConfigService.getInstance().setGlobalConfig(body as any);
    return successResponse(config, { status: 200 }, req);
  } catch (error) {
    if (error instanceof AgentSessionConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
