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
import { aiAgentRepoOverrideSchema } from 'server/lib/validation/aiAgentConfigSchemas';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';

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
 * /api/v2/ai/agent-config/repos/{owner}/{repo}:
 *   get:
 *     summary: Get repository AI agent config override
 *     description: >
 *       Returns the raw per-repository AI agent configuration override (not merged
 *       with the global config). This shows only the fields that are explicitly
 *       overridden for this repository. Returns 404 if no override exists.
 *     tags:
 *       - AI Agent Config
 *     operationId: getRepoAIAgentConfig
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
 *         description: Repository AI agent config override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetRepoAIAgentConfigSuccessResponse'
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
 * /api/v2/ai/agent-config/repos/{owner}/{repo}/effective:
 *   get:
 *     summary: Get effective (merged) AI agent config for repository
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
 *       - AI Agent Config
 *     operationId: getEffectiveAIAgentConfig
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
 *         description: Effective merged AI agent configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetEffectiveAIAgentConfigSuccessResponse'
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

  const service = AIAgentConfigService.getInstance();

  if (parsed.isEffective) {
    const result = await service.getEffectiveConfig(parsed.fullName);
    getLogger().info('AIAgentConfig: effective config read repo=' + parsed.fullName + ' via=api');
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

  getLogger().info('AIAgentConfig: repo config read repo=' + parsed.fullName + ' via=api');
  return successResponse({ repoFullName: parsed.fullName, config: result }, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/agent-config/repos/{owner}/{repo}:
 *   put:
 *     summary: Create or update repository AI agent config override
 *     description: >
 *       Upserts a per-repository AI agent configuration override. Only include
 *       the fields you want to override — omitted fields will continue to inherit
 *       from the global config. Validation enforces the same limits as the global
 *       config (prompt length, pattern count, core tool restrictions). The request
 *       body is validated against the AIAgentRepoOverride schema.
 *       Changes take effect immediately and invalidate cached effective configs.
 *     tags:
 *       - AI Agent Config
 *     operationId: putRepoAIAgentConfig
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AIAgentRepoOverride'
 *     responses:
 *       '200':
 *         description: Updated repository AI agent config override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetRepoAIAgentConfigSuccessResponse'
 *       '400':
 *         description: >
 *           Validation error. Possible reasons: JSON schema violation,
 *           systemPromptOverride exceeds maximum length, excluded tool is a core tool,
 *           invalid exclusion pattern, overly broad file pattern.
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
  const result = validator.validate(body, aiAgentRepoOverrideSchema);

  if (!result.valid) {
    const messages = result.errors.map((e) => e.stack).join('; ');
    return errorResponse(new Error('Validation failed: ' + messages), { status: 400 }, req);
  }

  const service = AIAgentConfigService.getInstance();

  try {
    await service.setRepoConfig(parsed.fullName, body as any);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('exceeds maximum') ||
        error.message.includes('core tool') ||
        error.message.includes('exclusion pattern') ||
        error.message.includes('not allowed') ||
        error.message.includes('Overly broad'))
    ) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }

  const updated = await service.getRepoConfig(parsed.fullName);
  getLogger().info('AIAgentConfig: repo config updated repo=' + parsed.fullName + ' via=api');
  return successResponse({ repoFullName: parsed.fullName, config: updated }, { status: 200 }, req);
};

/**
 * @openapi
 * /api/v2/ai/agent-config/repos/{owner}/{repo}:
 *   delete:
 *     summary: Delete repository AI agent config override
 *     description: >
 *       Soft-deletes the per-repository AI agent configuration override.
 *       After deletion, the repository reverts to using the global config only.
 *       The override can be recreated later with a PUT request.
 *     tags:
 *       - AI Agent Config
 *     operationId: deleteRepoAIAgentConfig
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

  const service = AIAgentConfigService.getInstance();
  await service.deleteRepoConfig(parsed.fullName);
  getLogger().info('AIAgentConfig: repo config deleted repo=' + parsed.fullName + ' via=api');
  return successResponse({ repoFullName: parsed.fullName, deleted: true }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
export const DELETE = createApiHandler(deleteHandler);
