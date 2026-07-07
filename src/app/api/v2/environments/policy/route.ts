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
import { successResponse } from 'server/lib/response';
import ApiAccessConfigService from 'server/services/apiAccessConfig';

/**
 * @openapi
 * /api/v2/environments/policy:
 *   get:
 *     summary: Environment creation policy
 *     description: >
 *       Whether environments can be created through the API, plus the default and
 *       maximum lifetimes. Lets clients hide or disable creation up front instead
 *       of failing at submit.
 *     tags: [Environments]
 *     operationId: getEnvironmentPolicy
 *     responses:
 *       '200':
 *         description: The environment creation policy.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentPolicySuccessResponse' }
 *       '401': { description: Not authenticated. }
 */
const getHandler = async (req: NextRequest) => {
  const config = await ApiAccessConfigService.getInstance().getApiEnvironmentsConfig();

  return successResponse(
    {
      enabled: config.enabled,
      defaultTtlHours: config.defaultTtlHours,
      maxTtlHours: config.maxTtlHours,
      extensionHours: config.extensionHours,
    },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler, { auth: 'session' });
