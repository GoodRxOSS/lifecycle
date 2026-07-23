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
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import { assertBuildRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import { successResponse } from 'server/lib/response';
import { BadRequestError, NotFoundError } from 'server/lib/appError';
import BuildService from 'server/services/build';
import { BuildKind } from 'shared/constants';

/**
 * @openapi
 * /api/v2/environments/{uuid}/extend:
 *   post:
 *     summary: Extend an environment lease
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Extends the expiresAt lease of an API-created environment from
 *       max(now, current expiry), capped at now + api_environments.maxTtlHours.
 *     tags: [Environments]
 *     operationId: extendEnvironment
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hours: { type: integer, minimum: 1, maximum: 9007199254740991, description: "Defaults to api_environments.extensionHours." }
 *     responses:
 *       '200':
 *         description: New expiresAt.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentLeaseExtensionSuccessResponse' }
 *       '400': { description: Invalid request body or non-positive/non-integer hours (invalid_body). }
 *       '404': { description: API environment not found (env_not_found). }
 *       '409': { description: Teardown already owns the environment (env_tearing_down). }
 */
const postHandler = createPrincipalApiHandler(
  { scope: 'env:write' },
  async (req: NextRequest, principal, ctx: { params: Promise<{ uuid: string }> }) => {
    const { uuid } = await ctx.params;
    const rawBody = await req.text();
    let body: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        const parsed = JSON.parse(rawBody);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        body = parsed;
      } catch {
        throw new BadRequestError('Request body must be a JSON object', 'invalid_body');
      }
    }
    let hours: number | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'hours')) {
      if (typeof body.hours !== 'number' || !Number.isSafeInteger(body.hours) || body.hours <= 0) {
        throw new BadRequestError('hours must be a positive safe integer', 'invalid_body');
      }
      hours = body.hours;
    }

    const buildService = new BuildService();
    const target = await buildService.db.models.Build.query()
      .findOne({ uuid })
      .where('kind', BuildKind.ENVIRONMENT)
      .whereNull('deletedAt')
      .withGraphFetched('pullRequest');
    if (!target) {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    await assertBuildRepositoryAllowed(principal, target);

    const build = await buildService.extendApiEnvironment(uuid, hours, target.id);
    return successResponse({ uuid: build.uuid, expiresAt: build.expiresAt }, { status: 200 }, req);
  }
);

export const POST = postHandler;
