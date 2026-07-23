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
import { NotFoundError } from 'server/lib/appError';
import ApiTokenService from 'server/services/apiToken';

/**
 * @openapi
 * /api/v2/me/tokens/{id}:
 *   delete:
 *     summary: Revoke one of my API keys
 *     description: >
 *       Revokes a key the caller owns. A key owned by someone else 404s (no existence leak).
 *       Idempotent, and available even while api_environments is disabled so owners can always
 *       clean up existing keys.
 *     tags: [ApiTokens]
 *     operationId: revokeMyApiToken
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       '200':
 *         description: Key revoked.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiTokenRevokeSuccessResponse' }
 *       '400': { description: Invalid token id (invalid_token_id). }
 *       '401': { description: Not authenticated. }
 *       '404': { description: Not found or not owned by the caller. }
 */
const deleteHandler = async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  ApiTokenService.assertManagementAllowed();
  const identity = requireRequestUserIdentity(req);
  const { id: rawId } = await params;
  const id = ApiTokenService.parseTokenId(rawId);

  const record = await ApiTokenService.revokeOwnedToken(id, identity.userId);
  if (!record) {
    throw new NotFoundError('API token not found', 'token_not_found');
  }

  return successResponse({ id: record.id, revokedAt: record.revokedAt }, { status: 200 }, req);
};

export const DELETE = createApiHandler(deleteHandler, { auth: 'session' });
