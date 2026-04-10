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
import { NextRequest, NextResponse } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { agentSessionControlPlaneConfigSchema } from 'server/lib/validation/agentSessionConfigSchemas';
import { AgentSessionConfigValidationError } from 'server/lib/validation/agentSessionConfigValidator';
import AgentSessionConfigService from 'server/services/agentSessionConfig';

export const dynamic = 'force-dynamic';

function parseRepoFullName(segments: string[]): string {
  if (segments.length < 2) {
    throw new Error('Invalid repository fullName. Expected format: owner/repo');
  }

  const normalized = normalizeRepoFullName(segments.join('/'));
  if ((normalized.match(/\//g) || []).length !== 1) {
    throw new Error('Invalid repository fullName. Expected format: owner/repo');
  }

  return normalized;
}

/**
 * @openapi
 * /api/v2/ai/config/agent-session/repos/{owner}/{repo}:
 *   parameters:
 *     - in: path
 *       name: owner
 *       required: true
 *       schema:
 *         type: string
 *     - in: path
 *       name: repo
 *       required: true
 *       schema:
 *         type: string
 *   get:
 *     summary: Get repository Agent Session configuration override
 *     tags:
 *       - Agent Session Config
 *     operationId: getRepoAgentSessionConfig
 *     responses:
 *       '200':
 *         description: Repository Agent Session configuration override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetRepoAgentSessionConfigSuccessResponse'
 *   put:
 *     summary: Update repository Agent Session configuration override
 *     tags:
 *       - Agent Session Config
 *     operationId: putRepoAgentSessionConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentSessionControlPlaneConfig'
 *     responses:
 *       '200':
 *         description: Updated repository Agent Session configuration override
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetRepoAgentSessionConfigSuccessResponse'
 *       '400':
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Delete repository Agent Session configuration override
 *     tags:
 *       - Agent Session Config
 *     operationId: deleteRepoAgentSessionConfig
 *     responses:
 *       '204':
 *         description: Override deleted
 */
const getHandler = async (req: NextRequest, { params }: { params: { fullName: string[] } }) => {
  let repoFullName: string;
  try {
    repoFullName = parseRepoFullName(params.fullName);
  } catch {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

  const config = (await AgentSessionConfigService.getInstance().getRepoConfig(repoFullName)) || {};
  return successResponse({ repoFullName, config }, { status: 200 }, req);
};

const putHandler = async (req: NextRequest, { params }: { params: { fullName: string[] } }) => {
  let repoFullName: string;
  try {
    repoFullName = parseRepoFullName(params.fullName);
  } catch {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

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
    const config = await AgentSessionConfigService.getInstance().setRepoConfig(repoFullName, body as any);
    return successResponse({ repoFullName, config }, { status: 200 }, req);
  } catch (error) {
    if (error instanceof AgentSessionConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }
};

const deleteHandler = async (req: NextRequest, { params }: { params: { fullName: string[] } }) => {
  let repoFullName: string;
  try {
    repoFullName = parseRepoFullName(params.fullName);
  } catch {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

  await AgentSessionConfigService.getInstance().deleteRepoConfig(repoFullName);
  return new NextResponse(null, { status: 204 });
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
export const DELETE = createApiHandler(deleteHandler);
