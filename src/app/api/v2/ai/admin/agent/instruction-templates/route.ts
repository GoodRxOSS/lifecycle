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
import { successResponse } from 'server/lib/response';
import InstructionTemplateService from 'server/services/agent/InstructionTemplateService';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/admin/agent/instruction-templates:
 *   get:
 *     summary: List agent instruction templates
 *     description: Returns system-owned instruction templates with default, override, and effective prompt metadata.
 *     tags:
 *       - Agent Admin
 *     operationId: listAdminAgentInstructionTemplates
 *     responses:
 *       '200':
 *         description: System instruction templates.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListAdminAgentInstructionTemplatesSuccessResponse'
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
  await InstructionTemplateService.seedSystemTemplates();
  const templates = await InstructionTemplateService.listTemplates();
  return successResponse({ templates }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
