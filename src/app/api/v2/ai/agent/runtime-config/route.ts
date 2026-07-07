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
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import JsonSchema from 'jsonschema';
import {
  agentRuntimeApprovalPolicyUpdateSchema,
  agentRuntimeConfigPatchSchema,
  agentRuntimeConfigSchema,
} from 'server/lib/validation/agentRuntimeConfigSchemas';
import { AgentRuntimeConfigValidationError } from 'server/lib/validation/agentRuntimeConfigValidator';
import type { ApprovalPolicyConfig } from 'server/services/types/agentRuntimeConfig';

/**
 * @openapi
 * /api/v2/ai/agent/runtime-config:
 *   get:
 *     summary: Get global Agent runtime configuration
 *     description: >
 *       Returns the current global Agent runtime configuration. This is the base configuration
 *       that applies to all repositories unless overridden by a per-repository config.
 *       The response includes provider settings, model definitions, session limits,
 *       tool exclusions, and performance tuning parameters.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: getGlobalAgentRuntimeConfig
 *     responses:
 *       '200':
 *         description: Global Agent runtime configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAgentRuntimeConfigSuccessResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const service = AgentRuntimeConfigService.getInstance();
  const config = await service.getGlobalConfig();
  getLogger().info('AgentRuntimeConfig: global config read via=api');
  return successResponse(config, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/agent/runtime-config:
 *   put:
 *     summary: Update global Agent runtime configuration
 *     description: >
 *       Validates and replaces the global Agent runtime configuration. The full AgentRuntimeConfig
 *       object must be provided (this is a full replacement, not a patch). Validation
 *       enforces limits on systemPromptOverride length (max 50,000 chars), excludedFilePatterns
 *       count, and prevents exclusion of core tools. The updated configuration is returned.
 *       Changes take effect immediately and invalidate cached effective configs.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: updateGlobalAgentRuntimeConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentRuntimeConfig'
 *     responses:
 *       '200':
 *         description: Updated global Agent runtime configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAgentRuntimeConfigSuccessResponse'
 *       '400':
 *         description: >
 *           Validation error. Possible reasons: JSON schema violation,
 *           systemPromptOverride exceeds maximum length, excluded tool is a core tool,
 *           invalid exclusion pattern.
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
 *       '403':
 *         description: Forbidden
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
 *     summary: Patch global Agent runtime configuration
 *     description: >
 *       Updates one patchable global Agent runtime configuration section without replacing
 *       the rest of the configuration. Supported patch targets are additive rules and
 *       approval policy. Approval policy updates replace that section with the provided
 *       value, so omitting defaultMode or rules clears them. This avoids revalidating
 *       unrelated provider/model settings.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: patchGlobalAgentRuntimeConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentRuntimeConfigPatchRequest'
 *     responses:
 *       '200':
 *         description: Updated global Agent runtime configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetGlobalAgentRuntimeConfigSuccessResponse'
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
 *       '403':
 *         description: Forbidden
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
  const result = validator.validate(body, agentRuntimeConfigSchema);

  if (!result.valid) {
    const messages = result.errors.map((e) => e.stack).join('; ');
    return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
  }

  const service = AgentRuntimeConfigService.getInstance();

  try {
    await service.setGlobalConfig(body as any);
  } catch (error) {
    if (error instanceof AgentRuntimeConfigValidationError) {
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
  const result = validator.validate(body, agentRuntimeConfigPatchSchema);

  if (!result.valid) {
    const messages = result.errors.map((e) => e.stack).join('; ');
    return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
  }

  const service = AgentRuntimeConfigService.getInstance();

  try {
    const approvalPolicyResult = validator.validate(body, agentRuntimeApprovalPolicyUpdateSchema);
    if (!approvalPolicyResult.valid) {
      const messages = approvalPolicyResult.errors.map((e) => e.stack).join('; ');
      return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
    }

    const updatedConfig = await service.updateGlobalApprovalPolicy(
      (body as { approvalPolicy: ApprovalPolicyConfig }).approvalPolicy
    );
    return successResponse(updatedConfig, { status: 200 }, req);
  } catch (error) {
    if (error instanceof AgentRuntimeConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler, { roles: ['admin'] });
export const PATCH = createApiHandler(patchHandler, { roles: ['admin'] });
