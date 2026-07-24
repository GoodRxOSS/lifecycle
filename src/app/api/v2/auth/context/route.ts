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

import type { NextRequest } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import { successResponse, withNoStore } from 'server/lib/response';
import type { Principal } from 'server/lib/principal';

/**
 * @openapi
 * /api/v2/auth/context:
 *   get:
 *     summary: Describe the calling principal
 *     description: >-
 *       Returns the non-secret identity, scopes, and repository constraint of the caller so a client
 *       can confirm which credential authenticated and what it may do. Never returns the token, its
 *       hash or prefix, the owner email, or the internal identity object.
 *     tags:
 *       - Auth
 *     operationId: getAuthContext
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     responses:
 *       '200':
 *         description: The authenticated principal's non-secret context.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required:
 *                     - data
 *                   properties:
 *                     data:
 *                       type: object
 *                       required:
 *                         - principal
 *                         - authMethod
 *                         - scopes
 *                         - repositories
 *                         - tokenId
 *                       additionalProperties: false
 *                       properties:
 *                         principal:
 *                           type: object
 *                           required:
 *                             - kind
 *                             - id
 *                           additionalProperties: false
 *                           properties:
 *                             kind:
 *                               type: string
 *                               enum:
 *                                 - user
 *                                 - personal_key
 *                                 - service_key
 *                             id:
 *                               type: string
 *                               description: Owner subject for users and personal keys; token actor for service keys.
 *                         authMethod:
 *                           type: string
 *                           enum:
 *                             - session
 *                             - api_key
 *                         scopes:
 *                           type: array
 *                           nullable: true
 *                           description: null for unscoped sessions; the granted scope list for keys.
 *                           items:
 *                             type: string
 *                         repositories:
 *                           type: object
 *                           required:
 *                             - mode
 *                             - repositoryIds
 *                             - repositoryNames
 *                           additionalProperties: false
 *                           properties:
 *                             mode:
 *                               type: string
 *                               enum:
 *                                 - all
 *                                 - selected
 *                             repositoryIds:
 *                               type: array
 *                               items:
 *                                 type: integer
 *                             repositoryNames:
 *                               type: array
 *                               description: Selected repository names, including the constraint for legacy name-bound keys.
 *                               items:
 *                                 type: string
 *                         tokenId:
 *                           type: integer
 *                           nullable: true
 *                           description: The API key id for key principals; null for sessions.
 *       '401':
 *         description: No credential, or an invalid credential, was presented.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: The credential kind is disabled by the administrator.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, principal: Principal) => {
  return withNoStore(
    successResponse(
      {
        principal: { kind: principal.kind, id: principal.userId ?? principal.actor },
        authMethod: principal.authMethod,
        scopes: principal.scopes,
        repositories: {
          mode: principal.repositoryAllowlistRepoIds || principal.repositoryAllowlist ? 'selected' : 'all',
          repositoryIds: principal.repositoryAllowlistRepoIds ?? [],
          repositoryNames: principal.repositoryAllowlist ?? [],
        },
        tokenId: principal.tokenId,
      },
      { status: 200 },
      req
    )
  );
};

export const GET = createPrincipalApiHandler({ scope: null }, getHandler);
