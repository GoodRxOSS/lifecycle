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
import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import { apiEnvironmentsConfigSchema } from 'server/lib/validation/apiAccessConfigSchemas';
import ApiAccessConfigService from 'server/services/apiAccessConfig';
import type { ApiEnvironmentsConfig } from 'server/services/types/globalConfig';

/**
 * @openapi
 * /api/v2/config/api-environments:
 *   get:
 *     summary: Get API environments configuration
 *     description: >
 *       Returns the api_environments global config: whether API-created environments are enabled
 *       and their TTL policy. Independent of the api_keys config — key issuance and authentication
 *       are governed separately.
 *     tags:
 *       - Config
 *     operationId: getApiEnvironmentsConfig
 *     responses:
 *       '200':
 *         description: API environments configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiEnvironmentsConfigSuccessResponse'
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
 *   put:
 *     summary: Update API environments configuration
 *     description: >
 *       Replaces the api_environments global config. defaultTtlHours must not exceed maxTtlHours.
 *     tags:
 *       - Config
 *     operationId: updateApiEnvironmentsConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ApiEnvironmentsConfig'
 *     responses:
 *       '200':
 *         description: Updated API environments configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiEnvironmentsConfigSuccessResponse'
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
 */
const getHandler = async (req: NextRequest) => {
  const config = await ApiAccessConfigService.getInstance().getApiEnvironmentsConfig();
  return successResponse({ config }, { status: 200 }, req);
};

const putHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const validator = new JsonSchema.Validator();
  const result = validator.validate(body, apiEnvironmentsConfigSchema);
  if (!result.valid) {
    const messages = result.errors.map((entry) => entry.stack).join('; ');
    return errorResponse(new Error(`Validation failed: ${messages}`), { status: 400 }, req);
  }

  const parsed = body as ApiEnvironmentsConfig;
  if ((parsed.defaultTtlHours ?? 0) > (parsed.maxTtlHours ?? 0)) {
    return errorResponse(
      new Error('Validation failed: defaultTtlHours must not exceed maxTtlHours'),
      { status: 400 },
      req
    );
  }

  const identity = requireRequestUserIdentity(req);
  const config = await ApiAccessConfigService.getInstance().setApiEnvironmentsConfig(parsed, identity.userId);
  return successResponse({ config }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
export const PUT = createApiHandler(putHandler, { auth: 'session', roles: ['admin'] });
