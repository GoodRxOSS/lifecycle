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
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import InstructionTemplateService, {
  InstructionTemplateServiceError,
} from 'server/services/agent/InstructionTemplateService';

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @openapi
 * /api/v2/ai/admin/agent/instruction-templates/{ref}/override:
 *   put:
 *     summary: Override an agent instruction template
 *     description: Saves admin-managed override content for a system-owned instruction template.
 *     tags:
 *       - Agent Admin
 *     operationId: overrideAdminAgentInstructionTemplate
 *     parameters:
 *       - in: path
 *         name: ref
 *         required: true
 *         schema:
 *           type: string
 *         description: Stable instruction template ref such as `system:debug`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAgentInstructionTemplateOverrideRequest'
 *     responses:
 *       '200':
 *         description: Updated instruction template.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MutateAdminAgentInstructionTemplateSuccessResponse'
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
 *       '404':
 *         description: Instruction template not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const putHandler = async (req: NextRequest, { params }: { params: { ref: string } }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  if (!isRecord(body) || typeof body.content !== 'string') {
    return errorResponse(new Error('Request body must include content.'), { status: 400 }, req);
  }

  try {
    await InstructionTemplateService.seedSystemTemplates();
    const template = await InstructionTemplateService.updateOverride(decodeURIComponent(params.ref), {
      content: body.content,
      updatedBy: getRequestUserIdentity(req)?.userId || null,
    });
    return successResponse({ template }, { status: 200 }, req);
  } catch (error) {
    if (error instanceof InstructionTemplateServiceError) {
      return errorResponse(error, { status: error.statusCode === 404 ? 404 : 400 }, req);
    }
    throw error;
  }
};

export const PUT = createApiHandler(putHandler, { roles: ['admin'] });
