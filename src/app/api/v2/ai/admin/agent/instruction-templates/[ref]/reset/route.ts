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
import { errorResponse, successResponse } from 'server/lib/response';
import InstructionTemplateService, {
  InstructionTemplateServiceError,
} from 'server/services/agent/InstructionTemplateService';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/admin/agent/instruction-templates/{ref}/reset:
 *   post:
 *     summary: Reset an agent instruction template override
 *     description: Clears admin-managed override content so the system-owned default becomes effective.
 *     tags:
 *       - Agent Admin
 *     operationId: resetAdminAgentInstructionTemplate
 *     parameters:
 *       - in: path
 *         name: ref
 *         required: true
 *         schema:
 *           type: string
 *         description: Stable instruction template ref such as `system:debug`.
 *     responses:
 *       '200':
 *         description: Reset instruction template.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MutateAdminAgentInstructionTemplateSuccessResponse'
 *       '400':
 *         description: Invalid template ref.
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
const postHandler = async (req: NextRequest, { params }: { params: Promise<{ ref: string }> }) => {
  const routeParams = await params;
  try {
    await InstructionTemplateService.seedSystemTemplates();
    const template = await InstructionTemplateService.resetOverride(decodeURIComponent(routeParams.ref));
    return successResponse({ template }, { status: 200 }, req);
  } catch (error) {
    if (error instanceof InstructionTemplateServiceError) {
      return errorResponse(error, { status: error.statusCode === 404 ? 404 : 400 }, req);
    }
    throw error;
  }
};

export const POST = createApiHandler(postHandler, { roles: ['admin'] });
