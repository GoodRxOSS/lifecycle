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
import { BadRequestError } from 'server/lib/appError';
import ApiTokenService, { OwnerSelectorField } from 'server/services/apiToken';

/**
 * @openapi
 * /api/v2/tokens/revoke-by-owner:
 *   post:
 *     summary: Revoke all of a user's tokens (offboarding hook)
 *     description: >
 *       Revokes every user token owned by one person. Provide exactly one of ownerUserId,
 *       ownerEmail, or ownerPreferredUsername (email/username matched case-insensitively).
 *       If the identifier resolves to more than one owner, returns 409. Admin only; available
 *       even when api_environments is disabled.
 *     tags: [ApiTokens]
 *     operationId: revokeApiTokensByOwner
 *     responses:
 *       '200': { description: "{ count } tokens revoked." }
 *       '400': { description: Not exactly one identifier. }
 *       '403': { description: Requires the admin role. }
 *       '409': { description: Identifier resolves to multiple owners (ambiguous_owner). }
 */
const postHandler = async (req: NextRequest) => {
  ApiTokenService.assertManagementAllowed();
  const identity = requireRequestUserIdentity(req);
  const body = await req.json().catch(() => null);

  const selectors: [OwnerSelectorField, unknown][] = [
    ['ownerUserId', body?.ownerUserId],
    ['ownerEmail', body?.ownerEmail],
    ['ownerPreferredUsername', body?.ownerPreferredUsername],
  ];
  const provided = selectors.filter(([, value]) => typeof value === 'string' && value.trim());
  if (provided.length !== 1) {
    throw new BadRequestError(
      'Provide exactly one of ownerUserId, ownerEmail, ownerPreferredUsername.',
      'invalid_selector'
    );
  }

  const [field, value] = provided[0];
  const { count } = await ApiTokenService.revokeByOwnerIdentifier(field, (value as string).trim(), identity.userId);
  return successResponse({ count }, { status: 200 }, req);
};

export const POST = createApiHandler(postHandler, { auth: 'session', roles: ['admin'] });
