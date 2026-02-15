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
import { errorResponse, successResponse } from 'server/lib/response';
import { getLogger } from 'server/lib/logger';
import AIAgentConfigService from 'server/services/aiAgentConfig';
import JsonSchema from 'jsonschema';
import { aiAgentConfigSchema } from 'server/lib/validation/aiAgentConfigSchemas';

/**
 * @openapi
 * /api/v2/ai/agent-config:
 *   get:
 *     summary: Get global AI agent configuration
 *     description: >
 *       Returns the current global AI agent configuration. This is the base configuration
 *       that applies to all repositories unless overridden by a per-repository config.
 *       The response includes provider settings, model definitions, session limits,
 *       tool exclusions, and performance tuning parameters.
 *     tags:
 *       - AI Agent Config
 *     operationId: getGlobalAIAgentConfig
 *     responses:
 *       '200':
 *         description: Global AI agent configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAIAgentConfigSuccessResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const service = AIAgentConfigService.getInstance();
  const config = await service.getGlobalConfig();
  getLogger().info('AIAgentConfig: global config read via=api');
  return successResponse(config, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/agent-config:
 *   put:
 *     summary: Update global AI agent configuration
 *     description: >
 *       Validates and replaces the global AI agent configuration. The full AIAgentConfig
 *       object must be provided (this is a full replacement, not a patch). Validation
 *       enforces limits on systemPromptOverride length (max 50,000 chars), excludedFilePatterns
 *       count, and prevents exclusion of core tools. The updated configuration is returned.
 *       Changes take effect immediately and invalidate cached effective configs.
 *     tags:
 *       - AI Agent Config
 *     operationId: updateGlobalAIAgentConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AIAgentConfig'
 *     responses:
 *       '200':
 *         description: Updated global AI agent configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAIAgentConfigSuccessResponse'
 *       '400':
 *         description: >
 *           Validation error. Possible reasons: JSON schema violation,
 *           systemPromptOverride exceeds maximum length, excluded tool is a core tool,
 *           invalid exclusion pattern.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const putHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const validator = new JsonSchema.Validator();
  const result = validator.validate(body, aiAgentConfigSchema);

  if (!result.valid) {
    const messages = result.errors.map((e) => e.stack).join('; ');
    return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
  }

  const service = AIAgentConfigService.getInstance();

  try {
    await service.setGlobalConfig(body as any);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('exceeds maximum') ||
        error.message.includes('core tool') ||
        error.message.includes('exclusion pattern'))
    ) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }

  const updatedConfig = await service.getGlobalConfig();
  return successResponse(updatedConfig, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
