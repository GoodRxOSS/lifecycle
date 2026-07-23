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
import ApiTokenService, { ApiTokenKind, ApiTokenStatus } from 'server/services/apiToken';
import { assertIssuanceEnabled, assertNoUnknownFields, TOKEN_CREATE_FIELDS } from '../me/tokens/shared';
import { serializeAdminToken } from './shared';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

const parseEnumParam = <T extends string>(value: string | null, allowed: readonly T[], name: string): T | null => {
  if (value == null) return null;
  if (!allowed.includes(value as T)) {
    throw new BadRequestError(`${name} must be one of: ${allowed.join(', ')}`, 'invalid_query');
  }
  return value as T;
};

const parsePositiveIntegerParam = (value: string | null, name: string, fallback: number, maximum?: number): number => {
  if (value == null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BadRequestError(`${name} must be a positive integer.`, 'invalid_query');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (maximum != null && parsed > maximum)) {
    const constraint = maximum == null ? 'a safe positive integer' : `between 1 and ${maximum}`;
    throw new BadRequestError(`${name} must be ${constraint}.`, 'invalid_query');
  }
  return parsed;
};

/**
 * @openapi
 * /api/v2/tokens:
 *   get:
 *     summary: List API keys (admin)
 *     description: >
 *       Returns service and personal API keys with owner metadata (hashes are never returned).
 *       Filterable by kind/status and searchable by name, prefix, or owner. Passing page or limit
 *       returns a paginated response. Admin only; available even while api_environments is disabled.
 *     tags:
 *       - ApiTokens
 *     operationId: listApiTokens
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema: { type: string, enum: [service, personal] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, expired, revoked] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *     responses:
 *       '200':
 *         description: API keys visible to admins.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AdminApiTokenListSuccessResponse' }
 *       '400': { description: Invalid kind/status/pagination filter (invalid_query). }
 *       '403': { description: Requires the admin role. }
 *   post:
 *     summary: Create a service API key (admin)
 *     description: >
 *       Creates a shared, ownerless service key for the environments API. repositoryAccess is
 *       explicit — { mode: "all" } or { mode: "selected", repositories: [...] } — so an empty
 *       selection can never silently mean all repositories. New keys may not request env:admin.
 *       Omitting ttlHours/expiresAt creates a non-expiring key (an explicit admin choice);
 *       unknown body fields are rejected (400) so a mistyped expiry field never silently
 *       becomes that choice.
 *       The plaintext (lfc_ prefixed) is returned exactly once with Cache-Control: private,
 *       no-store. Admin only; requires API key issuance (api_keys.issuanceEnabled) to be enabled.
 *     tags:
 *       - ApiTokens
 *     operationId: issueApiToken
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ServiceApiTokenCreateRequest' }
 *     responses:
 *       '201':
 *         description: Key created; `token` is the plaintext secret, shown only once.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ServiceApiTokenCreateSuccessResponse' }
 *       '400': { description: Invalid body. }
 *       '403': { description: Requires the admin role, forbidden scope, or key issuance disabled (api_keys_disabled). }
 */
const getHandler = async (req: NextRequest) => {
  ApiTokenService.assertManagementAllowed();
  const { searchParams } = req.nextUrl;
  const filters = {
    kind: parseEnumParam<ApiTokenKind>(searchParams.get('kind'), ['service', 'personal'], 'kind'),
    status: parseEnumParam<ApiTokenStatus>(searchParams.get('status'), ['active', 'expired', 'revoked'], 'status'),
    search: searchParams.get('search'),
  };

  if (searchParams.get('page') != null || searchParams.get('limit') != null) {
    const page = parsePositiveIntegerParam(searchParams.get('page'), 'page', DEFAULT_PAGE);
    const limit = parsePositiveIntegerParam(searchParams.get('limit'), 'limit', DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const { data, metadata } = await ApiTokenService.listTokensPaginated(filters, { page, limit });
    return successResponse(data.map(serializeAdminToken), { metadata: { pagination: metadata }, status: 200 }, req);
  }

  const tokens = await ApiTokenService.listTokens(filters);
  return successResponse(tokens.map(serializeAdminToken), { status: 200 }, req);
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

  const scopes = ApiTokenService.assertServiceTokenScopes(body.scopes);
  const expiresAt = ApiTokenService.resolveRequestedExpiry(body);
  const { names, repoIds } = await ApiTokenService.resolveRepositoryAccess(body);

  const { token, record } = await ApiTokenService.issueToken({
    name,
    scopes,
    repositoryAllowlist: names,
    repositoryAllowlistRepoIds: repoIds,
    expiresAt,
    createdBy: identity.userId,
  });

  return withNoStore(successResponse({ ...serializeAdminToken(record), token }, { status: 201 }, req));
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
export const POST = createApiHandler(postHandler, { auth: 'session', roles: ['admin'] });
