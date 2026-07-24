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
import { successResponse, withNoStore } from 'server/lib/response';
import { BadRequestError } from 'server/lib/appError';
import ApiTokenService, { PERSONAL_TOKEN_MAX_TTL_HOURS } from 'server/services/apiToken';
import { serializeUserToken, assertIssuanceEnabled, assertNoUnknownFields, TOKEN_CREATE_FIELDS } from './shared';

/**
 * @openapi
 * /api/v2/me/tokens:
 *   get:
 *     summary: List my API keys
 *     description: >
 *       Returns the caller's own personal API keys (hashes never returned). Available to any
 *       authenticated principal even while api_environments is disabled, so existing keys stay
 *       inspectable and revocable.
 *     tags: [ApiTokens]
 *     operationId: listMyApiTokens
 *     responses:
 *       '200':
 *         description: The caller's keys.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PersonalApiTokenListSuccessResponse' }
 *       '401': { description: Not authenticated. }
 *       '403': { description: ENABLE_AUTH is off (auth_required). }
 *   post:
 *     summary: Create a personal API key
 *     description: >
 *       Mints an identity-bound lfc_pat_ key owned by the caller. Scopes are capped to the
 *       grantable set. repositoryAccess must explicitly choose all repositories or at least one
 *       named repository; entries not yet onboarded resolve through the GitHub App, so a scoped
 *       repos:write key can onboard them later. Expiry may be omitted for a non-expiring key;
 *       finite ttlHours or expiresAt values are capped at 720 hours. Unknown body fields are
 *       rejected (400), so a mistyped expiry field never silently mints a non-expiring key.
 *       Plaintext is returned once with Cache-Control: private, no-store.
 *     tags: [ApiTokens]
 *     operationId: issueMyApiToken
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PersonalApiTokenCreateRequest' }
 *     responses:
 *       '201':
 *         description: Key created; plaintext returned once.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PersonalApiTokenCreateSuccessResponse' }
 *       '400': { description: Invalid body / repository access / expiry. }
 *       '401': { description: Not authenticated. }
 *       '403': { description: Role not permitted, forbidden scope, or key issuance disabled (api_keys_disabled). }
 */
const getHandler = async (req: NextRequest) => {
  ApiTokenService.assertManagementAllowed();
  const identity = requireRequestUserIdentity(req);
  const tokens = await ApiTokenService.listTokensByOwner(identity.userId);
  return successResponse(tokens.map(serializeUserToken), { status: 200 }, req);
};

const postHandler = async (req: NextRequest) => {
  ApiTokenService.assertManagementAllowed();
  await assertIssuanceEnabled();
  const identity = requireRequestUserIdentity(req);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('Request body must be a JSON object', 'invalid_body');
  }
  assertNoUnknownFields(body, TOKEN_CREATE_FIELDS);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 255) {
    throw new BadRequestError('name is required (1-255 characters)', 'invalid_name');
  }

  const scopes = ApiTokenService.assertUserTokenScopes(body.scopes, identity.roles);
  const expiresAt = ApiTokenService.resolveRequestedExpiry(body, {
    maxTtlHours: PERSONAL_TOKEN_MAX_TTL_HOURS,
  });
  const { names, repoIds } = await ApiTokenService.resolveRepositoryAccess(body);

  const { token, record } = await ApiTokenService.issueUserToken({
    name,
    scopes,
    repositoryAllowlist: names,
    repositoryAllowlistRepoIds: repoIds,
    expiresAt,
    owner: {
      userId: identity.userId,
      githubUsername: identity.githubUsername,
      email: identity.email,
      preferredUsername: identity.preferredUsername,
      displayName: identity.displayName,
      roleAtIssue: identity.roles.includes('admin') ? 'admin' : 'user',
    },
  });

  return withNoStore(successResponse({ ...serializeUserToken(record), token }, { status: 201 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session' });
export const POST = createApiHandler(postHandler, { auth: 'session' });
