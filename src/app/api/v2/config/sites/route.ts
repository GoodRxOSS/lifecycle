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
import { errorResponse, successResponse } from 'server/lib/response';
import { sitesConfigSchema } from 'server/lib/validation/sitesConfigSchemas';
import SitesConfigService from 'server/services/sitesConfig';
import type { SitesConfig } from 'server/services/types/globalConfig';

/**
 * @openapi
 * /api/v2/config/sites:
 *   get:
 *     summary: Get Sites configuration
 *     description: Returns the global Sites hosting configuration stored in global_config under the sites key.
 *     tags:
 *       - Config
 *     operationId: getSitesConfig
 *     responses:
 *       '200':
 *         description: Sites hosting configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SitesConfigSuccessResponse'
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
 *     summary: Update Sites configuration
 *     description: Replaces the global Sites hosting configuration stored in global_config under the sites key.
 *     tags:
 *       - Config
 *     operationId: updateSitesConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SitesConfig'
 *     responses:
 *       '200':
 *         description: Updated Sites hosting configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SitesConfigSuccessResponse'
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
  const config = await SitesConfigService.getInstance().getConfig();
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
  const result = validator.validate(body, sitesConfigSchema);
  if (!result.valid) {
    const messages = result.errors.map((entry) => entry.stack).join('; ');
    return errorResponse(new Error(`Validation failed: ${messages}`), { status: 400 }, req);
  }

  const config = await SitesConfigService.getInstance().setConfig(body as SitesConfig);
  return successResponse({ config }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
export const PUT = createApiHandler(putHandler, { roles: ['admin'] });
