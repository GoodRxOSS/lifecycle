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
  agentRuntimeAdditiveRulesUpdateSchema,
  agentRuntimeRepoOverrideSchema,
} from 'server/lib/validation/agentRuntimeConfigSchemas';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { AgentRuntimeConfigValidationError } from 'server/lib/validation/agentRuntimeConfigValidator';

export const dynamic = 'force-dynamic';

function parseFullNameParams(segments: string[]): { fullName: string; isEffective: boolean } {
  if (segments.length < 2) {
    throw new Error('Invalid repository fullName. Expected format: owner/repo');
  }

  let isEffective = false;
  const parts = [...segments];

  if (parts[parts.length - 1] === 'effective') {
    isEffective = true;
    parts.pop();
    if (parts.length < 2) {
      throw new Error('Invalid repository fullName. Expected format: owner/repo');
    }
  }

  const raw = parts.join('/');
  const fullName = normalizeRepoFullName(raw);

  if ((fullName.match(/\//g) || []).length !== 1) {
    throw new Error('Invalid repository fullName. Expected format: owner/repo');
  }

  return { fullName, isEffective };
}

/**
 * @openapi
 * /api/v2/ai/agent/runtime-config/repos/{owner}/{repo}:
 *   get:
 *     summary: Get repository agent runtime config override
 *     description: >
 *       Returns the raw per-repository Agent runtime configuration override (not merged
 *       with the global config). This shows only the fields that are explicitly
 *       overridden for this repository. Returns 404 if no override exists.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: getRepoAgentRuntimeConfig
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository owner
 *         example: example-org
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository name
 *         example: example-repo
 *     responses:
 *       '200':
 *         description: Repository agent runtime config override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetRepoAgentRuntimeConfigSuccessResponse'
 *       '404':
 *         description: No config override found for the repository
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
 *
 * /api/v2/ai/agent/runtime-config/repos/{owner}/{repo}/effective:
 *   get:
 *     summary: Get effective (merged) agent runtime config for repository
 *     description: >
 *       Returns the fully merged configuration for a repository. The merge applies
 *       the repository override on top of the global config using these rules:
 *       scalar fields (enabled, maxMessagesPerSession, sessionTTL, systemPromptOverride)
 *       are replaced by the repo value when present; array fields (additiveRules,
 *       excludedTools, excludedFilePatterns) are merged additively (union of global
 *       and repo arrays). Provider settings and performance tuning parameters are
 *       always taken from the global config (not overridable per-repo).
 *       If no repo override exists, this returns the global config unchanged.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: getEffectiveAgentRuntimeConfig
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository owner
 *         example: example-org
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository name
 *         example: example-repo
 *     responses:
 *       '200':
 *         description: Effective merged Agent runtime configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetEffectiveAgentRuntimeConfigSuccessResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { fullName: string[] } }) => {
  let parsed: { fullName: string; isEffective: boolean };
  try {
    parsed = parseFullNameParams(params.fullName);
  } catch {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

  const service = AgentRuntimeConfigService.getInstance();

  if (parsed.isEffective) {
    const result = await service.getEffectiveConfig(parsed.fullName);
    getLogger().info('AgentRuntimeConfig: effective config read repo=' + parsed.fullName + ' via=api');
    return successResponse({ repoFullName: parsed.fullName, effectiveConfig: result }, { status: 200 }, req);
  }

  const result = await service.getRepoConfig(parsed.fullName);
  if (!result) {
    return errorResponse(
      new Error('No config override found for repository: ' + parsed.fullName),
      { status: 404 },
      req
    );
  }

  getLogger().info('AgentRuntimeConfig: repo config read repo=' + parsed.fullName + ' via=api');
  return successResponse({ repoFullName: parsed.fullName, config: result }, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/agent/runtime-config/repos/{owner}/{repo}:
 *   put:
 *     summary: Create or update repository agent runtime config override
 *     description: >
 *       Upserts a per-repository Agent runtime configuration override. Only include
 *       the fields you want to override — omitted fields will continue to inherit
 *       from the global config. Validation enforces the same limits as the global
 *       config (prompt length, pattern count, core tool restrictions). The request
 *       body is validated against the AgentRuntimeRepoOverride schema.
 *       Changes take effect immediately and invalidate cached effective configs.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: putRepoAgentRuntimeConfig
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository owner
 *         example: example-org
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository name
 *         example: example-repo
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentRuntimeRepoOverride'
 *     responses:
 *       '200':
 *         description: Updated repository agent runtime config override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetRepoAgentRuntimeConfigSuccessResponse'
 *       '400':
 *         description: >
 *           Validation error. Possible reasons: JSON schema violation,
 *           systemPromptOverride exceeds maximum length, excluded tool is a core tool,
 *           invalid exclusion pattern, overly broad file pattern.
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
 *     summary: Update repository additive rules
 *     description: >
 *       Updates only the additiveRules field for a repository override while preserving
 *       any other repository-specific settings that already exist.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: patchRepoAgentRuntimeAdditiveRules
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentRuntimeAdditiveRulesUpdateRequest'
 *     responses:
 *       '200':
 *         description: Updated repository agent runtime config override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetRepoAgentRuntimeConfigSuccessResponse'
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
const putHandler = async (req: NextRequest, { params }: { params: { fullName: string[] } }) => {
  let parsed: { fullName: string; isEffective: boolean };
  try {
    parsed = parseFullNameParams(params.fullName);
  } catch {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

  if (parsed.isEffective) {
    return errorResponse(
      new Error('Cannot PUT to the effective config endpoint. Use the repo config endpoint instead.'),
      { status: 400 },
      req
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const validator = new JsonSchema.Validator();
  const result = validator.validate(body, agentRuntimeRepoOverrideSchema);

  if (!result.valid) {
    const messages = result.errors.map((e) => e.stack).join('; ');
    return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
  }

  const service = AgentRuntimeConfigService.getInstance();

  try {
    await service.setRepoConfig(parsed.fullName, body as any);
  } catch (error) {
    if (error instanceof AgentRuntimeConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }

  const updated = await service.getRepoConfig(parsed.fullName);
  getLogger().info('AgentRuntimeConfig: repo config updated repo=' + parsed.fullName + ' via=api');
  return successResponse({ repoFullName: parsed.fullName, config: updated }, { status: 200 }, req);
};

const patchHandler = async (req: NextRequest, { params }: { params: { fullName: string[] } }) => {
  let parsed: { fullName: string; isEffective: boolean };
  try {
    parsed = parseFullNameParams(params.fullName);
  } catch {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

  if (parsed.isEffective) {
    return errorResponse(
      new Error('Cannot PATCH the effective config endpoint. Use the repo config endpoint instead.'),
      { status: 400 },
      req
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const validator = new JsonSchema.Validator();
  const result = validator.validate(body, agentRuntimeAdditiveRulesUpdateSchema);

  if (!result.valid) {
    const messages = result.errors.map((e) => e.stack).join('; ');
    return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
  }

  const service = AgentRuntimeConfigService.getInstance();

  try {
    const updated = await service.updateRepoAdditiveRules(
      parsed.fullName,
      (body as { additiveRules: string[] }).additiveRules
    );
    getLogger().info('AgentRuntimeConfig: repo additive rules updated repo=' + parsed.fullName + ' via=api');
    return successResponse({ repoFullName: parsed.fullName, config: updated }, { status: 200 }, req);
  } catch (error) {
    if (error instanceof AgentRuntimeConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }
};

/**
 * @openapi
 * /api/v2/ai/agent/runtime-config/repos/{owner}/{repo}:
 *   delete:
 *     summary: Delete repository agent runtime config override
 *     description: >
 *       Soft-deletes the per-repository Agent runtime configuration override.
 *       After deletion, the repository reverts to using the global config only.
 *       The override can be recreated later with a PUT request.
 *     tags:
 *       - Agent Runtime Config
 *     operationId: deleteRepoAgentRuntimeConfig
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository owner
 *         example: goodrx
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *         description: The repository name
 *         example: lifecycle
 *     responses:
 *       '200':
 *         description: Repository config override deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessApiResponse'
 *       '400':
 *         description: Invalid request (e.g. cannot delete the /effective endpoint)
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
const deleteHandler = async (req: NextRequest, { params }: { params: { fullName: string[] } }) => {
  let parsed: { fullName: string; isEffective: boolean };
  try {
    parsed = parseFullNameParams(params.fullName);
  } catch {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

  if (parsed.isEffective) {
    return errorResponse(new Error('Cannot DELETE the effective config endpoint.'), { status: 400 }, req);
  }

  const service = AgentRuntimeConfigService.getInstance();
  await service.deleteRepoConfig(parsed.fullName);
  getLogger().info('AgentRuntimeConfig: repo config deleted repo=' + parsed.fullName + ' via=api');
  return successResponse({ repoFullName: parsed.fullName, deleted: true }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler, { roles: ['admin'] });
export const PATCH = createApiHandler(patchHandler, { roles: ['admin'] });
export const DELETE = createApiHandler(deleteHandler, { roles: ['admin'] });
