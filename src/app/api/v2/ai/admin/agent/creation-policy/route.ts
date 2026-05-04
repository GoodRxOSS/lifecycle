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
import { errorResponse, successResponse } from 'server/lib/response';
import { AgentRuntimeConfigValidationError } from 'server/lib/validation/agentRuntimeConfigValidator';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import type { CustomAgentCreationPolicyConfig } from 'server/services/types/agentRuntimeConfig';

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCustomAgentCreationPolicy(body: unknown): CustomAgentCreationPolicyConfig | Error {
  if (!isRecord(body)) {
    return new Error('Request body must be an object.');
  }

  const customAgentCreationPolicy = body.customAgentCreationPolicy;
  if (!isRecord(customAgentCreationPolicy)) {
    return new Error('Request body must include customAgentCreationPolicy.');
  }

  if (
    customAgentCreationPolicy.capabilityAvailability !== undefined &&
    !isRecord(customAgentCreationPolicy.capabilityAvailability)
  ) {
    return new Error('customAgentCreationPolicy.capabilityAvailability must be an object.');
  }

  return customAgentCreationPolicy as CustomAgentCreationPolicyConfig;
}

async function buildResponse() {
  const config = await AgentRuntimeConfigService.getInstance().getGlobalConfig();

  return {
    customAgentCreationPolicy: config.customAgentCreationPolicy || {},
  };
}

/**
 * @openapi
 * /api/v2/ai/admin/agent/creation-policy:
 *   get:
 *     summary: Get custom-agent creation policy
 *     description: Returns the global policy that controls who can create custom agents and which capabilities are available during custom-agent creation.
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminCustomAgentCreationPolicy
 *     responses:
 *       '200':
 *         description: Custom-agent creation policy.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminCustomAgentCreationPolicySuccessResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Update custom-agent creation policy
 *     description: Updates the global policy that controls who can create custom agents and which capabilities are available during custom-agent creation.
 *     tags:
 *       - Agent Admin
 *     operationId: updateAdminCustomAgentCreationPolicy
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAdminCustomAgentCreationPolicyRequest'
 *     responses:
 *       '200':
 *         description: Updated custom-agent creation policy.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminCustomAgentCreationPolicySuccessResponse'
 *       '400':
 *         description: Validation error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  return successResponse(await buildResponse(), { status: 200 }, req);
};

const putHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const customAgentCreationPolicy = readCustomAgentCreationPolicy(body);
  if (customAgentCreationPolicy instanceof Error) {
    return errorResponse(customAgentCreationPolicy, { status: 400 }, req);
  }

  try {
    await AgentRuntimeConfigService.getInstance().updateGlobalCustomAgentCreationPolicy(customAgentCreationPolicy);
  } catch (error) {
    if (error instanceof AgentRuntimeConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }

  return successResponse(await buildResponse(), { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
export const PUT = createApiHandler(putHandler, { roles: ['admin'] });
