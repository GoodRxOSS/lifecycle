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
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { successResponse } from 'server/lib/response';
import ApiTokenService, {
  PERSONAL_TOKEN_DEFAULT_TTL_HOURS,
  PERSONAL_TOKEN_MAX_TTL_HOURS,
  TOKEN_ALLOWLIST_MAX_ENTRIES,
  USER_TOKEN_CEILING,
} from 'server/services/apiToken';
import ApiAccessConfigService from 'server/services/apiAccessConfig';

/**
 * @openapi
 * /api/v2/me/tokens/policy:
 *   get:
 *     summary: Personal API key policy
 *     description: >
 *       Issuance policy for the caller: whether creation is enabled, the allowed access scopes,
 *       and expiry/repository-access rules. serverTime lets clients compute expiries without
 *       trusting their own clock.
 *     tags: [ApiTokens]
 *     operationId: getMyApiTokenPolicy
 *     responses:
 *       '200':
 *         description: The personal-key policy.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PersonalApiTokenPolicySuccessResponse' }
 *       '401': { description: Not authenticated. }
 *       '403': { description: ENABLE_AUTH is off (auth_required). }
 */
const getHandler = async (req: NextRequest) => {
  ApiTokenService.assertManagementAllowed();
  const identity = requireRequestUserIdentity(req);
  const config = await ApiAccessConfigService.getInstance().getApiKeysConfig();
  const roleAllowsCreate = identity.roles.includes('user') || identity.roles.includes('admin');

  return successResponse(
    {
      enabled: config.issuanceEnabled,
      issuanceEnabled: config.issuanceEnabled,
      authenticationEnabled: config.personalAuthEnabled,
      canCreate: config.issuanceEnabled && roleAllowsCreate,
      allowedScopes: USER_TOKEN_CEILING,
      defaultTtlHours: PERSONAL_TOKEN_DEFAULT_TTL_HOURS,
      maxTtlHours: PERSONAL_TOKEN_MAX_TTL_HOURS,
      allowNoExpiration: true,
      allowAllRepositories: true,
      repositoryAllowlistRequired: false,
      repositoryAllowlistMaxEntries: TOKEN_ALLOWLIST_MAX_ENTRIES,
      serverTime: new Date().toISOString(),
    },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler, { auth: 'session' });
