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
import { AppError, NotFoundError } from 'server/lib/appError';
import BuildService from 'server/services/build';
import { isDeployEnabled } from 'server/lib/buildSource';
import { BuildKind } from 'shared/constants';

/**
 * @openapi
 * /api/v2/environments/{uuid}/deploy:
 *   post:
 *     summary: Deploy (or redeploy) an environment
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Queues a resolve-and-deploy run for the environment. Refused when deploys
 *       are paused (deployEnabled=false for API environments, missing deploy label
 *       for PR environments).
 *     tags: [Environments]
 *     operationId: deployEnvironment
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '202':
 *         description: Deploy queued.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentQueuedOperationSuccessResponse' }
 *       '404': { description: Environment not found. }
 *       '409': { description: Deploys are paused (deploy_disabled) or teardown already owns the environment (env_tearing_down). }
 */
const postHandler = createPrincipalApiHandler(
  { scope: 'env:write' },
  async (req: NextRequest, principal, ctx: { params: Promise<{ uuid: string }> }) => {
    const { uuid } = await ctx.params;
    const buildService = new BuildService();
    const build = await buildService.db.models.Build.query()
      .findOne({ uuid })
      .where('kind', BuildKind.ENVIRONMENT)
      .whereNull('deletedAt')
      .withGraphFetched('pullRequest');
    if (!build) {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    await assertBuildRepositoryAllowed(principal, build);
    if (!isDeployEnabled(build)) {
      throw new AppError({
        httpStatus: 409,
        code: 'deploy_disabled',
        message:
          'Deploys are paused for this environment; PATCH { "deployEnabled": true } (or add the deploy label for PR environments) first.',
      });
    }

    const result = await buildService.redeployBuild(build.uuid, build.id);
    if (result?.status === 'not_found') {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    if (result?.status === 'tearing_down') {
      throw new AppError({
        httpStatus: 409,
        code: 'env_tearing_down',
        message: `Environment ${uuid} is being (or has been) torn down and cannot be deployed.`,
      });
    }
    if (result?.status === 'deploy_disabled') {
      throw new AppError({
        httpStatus: 409,
        code: 'deploy_disabled',
        message: 'Deploys are paused for this environment. Resume deploys before requesting a deployment.',
      });
    }
    return successResponse(
      { uuid: build.uuid, status: 'deploy_queued', statusUrl: `/api/v2/environments/${build.uuid}` },
      { status: 202 },
      req
    );
  }
);

export const POST = postHandler;
