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
import InstructionRuleService, {
  InstructionRuleServiceError,
  type InstructionRuleInput,
} from 'server/services/agent/InstructionRuleService';

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @openapi
 * /api/v2/ai/admin/agent/instruction-rules:
 *   get:
 *     summary: List agent instruction rules for a scope
 *     description: Returns the instruction rules for the global scope, or for one repository when the repository query parameter is set.
 *     tags:
 *       - Agent Admin
 *     operationId: listAdminAgentInstructionRules
 *     parameters:
 *       - in: query
 *         name: repository
 *         required: false
 *         schema:
 *           type: string
 *         description: Repository full name (owner/name). Omit for the global scope.
 *     responses:
 *       '200':
 *         description: Instruction rules for the scope.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListAdminAgentInstructionRulesSuccessResponse'
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
 *     summary: Replace agent instruction rules for a scope
 *     description: Replaces the full instruction rule list for the global scope or one repository. Rule order defines injection order.
 *     tags:
 *       - Agent Admin
 *     operationId: replaceAdminAgentInstructionRules
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ReplaceAdminAgentInstructionRulesRequest'
 *     responses:
 *       '200':
 *         description: Saved instruction rules for the scope.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListAdminAgentInstructionRulesSuccessResponse'
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
  const repository = req.nextUrl.searchParams.get('repository');
  const rules = await InstructionRuleService.listRules(repository);
  return successResponse({ rules }, { status: 200 }, req);
};

const putHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  if (!isRecord(body) || !Array.isArray(body.rules)) {
    return errorResponse(new Error('Request body must include a rules array.'), { status: 400 }, req);
  }
  if (body.repository !== undefined && body.repository !== null && typeof body.repository !== 'string') {
    return errorResponse(new Error('repository must be a string when provided.'), { status: 400 }, req);
  }
  for (const rule of body.rules) {
    if (!isRecord(rule) || typeof rule.agentRef !== 'string' || typeof rule.content !== 'string') {
      return errorResponse(new Error('Each rule must include agentRef and content strings.'), { status: 400 }, req);
    }
  }

  try {
    const rules = await InstructionRuleService.replaceRules({
      repositoryFullName: (body.repository as string | null | undefined) || null,
      rules: body.rules as InstructionRuleInput[],
      updatedBy: getRequestUserIdentity(req)?.userId || null,
    });
    return successResponse({ rules }, { status: 200 }, req);
  } catch (error) {
    if (error instanceof InstructionRuleServiceError) {
      return errorResponse(error, { status: error.statusCode }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
export const PUT = createApiHandler(putHandler, { roles: ['admin'] });
