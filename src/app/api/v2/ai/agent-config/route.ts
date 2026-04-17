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
import {
  aiAgentAdditiveRulesUpdateSchema,
  aiAgentApprovalPolicyUpdateSchema,
  aiAgentConfigPatchSchema,
  aiAgentConfigSchema,
} from 'server/lib/validation/aiAgentConfigSchemas';
import { AIAgentConfigValidationError } from 'server/lib/validation/aiAgentConfigValidator';
import type { ApprovalPolicyConfig } from 'server/services/types/aiAgentConfig';

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
 *   patch:
 *     summary: Patch global AI agent configuration
 *     description: >
 *       Updates one patchable global AI agent configuration section without replacing
 *       the rest of the configuration. Supported patch targets are additive rules and
 *       approval policy. Approval policy updates replace that section with the provided
 *       value, so omitting defaultMode or rules clears them. This avoids revalidating
 *       unrelated provider/model settings.
 *     tags:
 *       - AI Agent Config
 *     operationId: patchGlobalAIAgentConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AIAgentConfigPatchRequest'
 *     responses:
 *       '200':
 *         description: Updated global AI agent configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAIAgentConfigSuccessResponse'
 *       '400':
 *         description: Validation error
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
    if (error instanceof AIAgentConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }

  const updatedConfig = await service.getGlobalConfig();
  return successResponse(updatedConfig, { status: 200 }, req);
};

const patchHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const validator = new JsonSchema.Validator();
  const result = validator.validate(body, aiAgentConfigPatchSchema);

  if (!result.valid) {
    const messages = result.errors.map((e) => e.stack).join('; ');
    return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
  }

  const service = AIAgentConfigService.getInstance();

  try {
    if ('additiveRules' in (body as Record<string, unknown>)) {
      const additiveRulesResult = validator.validate(body, aiAgentAdditiveRulesUpdateSchema);
      if (!additiveRulesResult.valid) {
        const messages = additiveRulesResult.errors.map((e) => e.stack).join('; ');
        return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
      }

      const updatedConfig = await service.updateGlobalAdditiveRules(
        (body as { additiveRules: string[] }).additiveRules
      );
      return successResponse(updatedConfig, { status: 200 }, req);
    }

    const approvalPolicyResult = validator.validate(body, aiAgentApprovalPolicyUpdateSchema);
    if (!approvalPolicyResult.valid) {
      const messages = approvalPolicyResult.errors.map((e) => e.stack).join('; ');
      return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
    }

    const updatedConfig = await service.updateGlobalApprovalPolicy(
      (body as { approvalPolicy: ApprovalPolicyConfig }).approvalPolicy
    );
    return successResponse(updatedConfig, { status: 200 }, req);
  } catch (error) {
    if (error instanceof AIAgentConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
export const PATCH = createApiHandler(patchHandler);
