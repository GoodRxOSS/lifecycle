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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import {
  FEATURE_DEFINITIONS,
  getFeaturesConfig,
  updateFeaturesConfig,
  type FeatureUpdates,
} from 'server/services/featuresConfig';

/**
 * @openapi
 * /api/v2/config/features:
 *   get:
 *     summary: Get feature flags
 *     description: Returns the global Feature configuration stored in global_config under the features key.
 *     tags:
 *       - Config
 *     operationId: getFeaturesConfig
 *     responses:
 *       '200':
 *         description: Feature configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FeaturesConfigSuccessResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Update feature flags
 *     description: Updates supplied flags in the global Feature configuration stored in global_config under the features key.
 *     tags:
 *       - Config
 *     operationId: updateFeaturesConfig
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/FeaturesConfigInput'
 *     responses:
 *       '200':
 *         description: Updated Feature configuration.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FeaturesConfigSuccessResponse'
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
const getHandler = async (req: NextRequest) =>
  successResponse({ features: await getFeaturesConfig() }, { status: 200 }, req);

const putHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }
  const keys = new Set<string>(FEATURE_DEFINITIONS.map((feature) => feature.key));
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Object.keys(body).length ||
    Object.entries(body).some(([key, value]) => !keys.has(key) || typeof value !== 'boolean')
  ) {
    return errorResponse(new Error('Expected supported feature names with boolean values'), { status: 400 }, req);
  }
  return successResponse({ features: await updateFeaturesConfig(body as FeatureUpdates) }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session' });
export const PUT = createApiHandler(putHandler, { auth: 'session', roles: ['admin'] });
