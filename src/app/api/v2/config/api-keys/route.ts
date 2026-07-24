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
import { apiKeysConfigSchema } from 'server/lib/validation/apiAccessConfigSchemas';
import ApiAccessConfigService from 'server/services/apiAccessConfig';
import type { ApiKeysConfig } from 'server/services/types/globalConfig';

/**
 * @openapi
 * /api/v2/config/api-keys:
 *   get:
 *     summary: Get API key access configuration
 *     description: >
 *       Returns the api_keys global config: whether new keys can be minted (issuanceEnabled),
 *       the per-kind authentication kill switches, the owner-aggregated rate limit, and the
 *       per-user active-key cap. Changes propagate to other replicas within ~30 seconds.
 *     tags:
 *       - Config
 *     operationId: getApiKeysConfig
 *     responses:
 *       '200':
 *         description: API key access configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiKeysConfigSuccessResponse'
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
 *     summary: Update API key access configuration
 *     description: >
 *       Replaces the api_keys global config. Disabling personalAuthEnabled or serviceAuthEnabled
 *       immediately blocks authentication for that key kind; disabling issuanceEnabled blocks new
 *       key creation but never an owner's list/revoke of existing keys.
 *     tags:
 *       - Config
 *     operationId: updateApiKeysConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ApiKeysConfig'
 *     responses:
 *       '200':
 *         description: Updated API key access configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiKeysConfigSuccessResponse'
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
  const config = await ApiAccessConfigService.getInstance().getApiKeysConfig();
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
  const result = validator.validate(body, apiKeysConfigSchema);
  if (!result.valid) {
    const messages = result.errors.map((entry) => entry.stack).join('; ');
    return errorResponse(new Error(`Validation failed: ${messages}`), { status: 400 }, req);
  }

  const identity = requireRequestUserIdentity(req);
  const config = await ApiAccessConfigService.getInstance().setApiKeysConfig(body as ApiKeysConfig, identity.userId);
  return successResponse({ config }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
export const PUT = createApiHandler(putHandler, { auth: 'session', roles: ['admin'] });
