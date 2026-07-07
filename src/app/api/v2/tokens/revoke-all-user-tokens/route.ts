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
import ApiTokenService from 'server/services/apiToken';

/**
 * @openapi
 * /api/v2/tokens/revoke-all-user-tokens:
 *   post:
 *     summary: Revoke every user-provisioned token
 *     description: >
 *       Surgical kill switch: revokes all tokens with an owner, leaving admin org tokens and the
 *       environments API running (unlike disabling api_environments, which halts all env creation).
 *       Admin only; available even when api_environments is disabled.
 *     tags: [ApiTokens]
 *     operationId: revokeAllUserTokens
 *     responses:
 *       '200': { description: "{ count } tokens revoked." }
 *       '403': { description: Requires the admin role. }
 */
const postHandler = async (req: NextRequest) => {
  ApiTokenService.assertManagementAllowed();
  const identity = requireRequestUserIdentity(req);
  const { count } = await ApiTokenService.revokeAllUserTokens(identity.userId);
  return successResponse({ count }, { status: 200 }, req);
};

export const POST = createApiHandler(postHandler, { auth: 'session', roles: ['admin'] });
