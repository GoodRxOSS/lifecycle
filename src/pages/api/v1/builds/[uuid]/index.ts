/**
 * Copyright 2025 GoodRx, Inc.
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

import { nanoid } from 'nanoid';
import { NextApiRequest, NextApiResponse } from 'next/types';
import { withLogContext, getLogger, LogStage } from 'server/lib/logger/index';
import { Build } from 'server/models';
import BuildService from 'server/services/build';
import OverrideService from 'server/services/override';

async function retrieveBuild(req: NextApiRequest, res: NextApiResponse) {
  const { uuid } = req.query;

  try {
    const buildService = new BuildService();

    const build = await buildService.db.models.Build.query()
      .findOne({ uuid })
      .select(
        'id',
        'uuid',
        'status',
        'statusMessage',
        'enableFullYaml',
        'sha',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'pullRequestId',
        'manifest',
        'webhooksYaml',
        'dashboardLinks',
        'isStatic',
        'namespace'
      );

    if (!build) {
      getLogger({ buildUuid: uuid as string }).debug('Build not found');
      return res.status(404).json({ error: 'Build not found' });
    }

    return res.status(200).json(build);
  } catch (error) {
    getLogger({ buildUuid: uuid as string }).error(
      { error: error instanceof Error ? error.message : String(error) },
      'Error fetching build'
    );
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
}

async function updateBuild(req: NextApiRequest, res: NextApiResponse, correlationId: string) {
  const { uuid } = req.query;
  const { uuid: newUuid } = req.body;

  if (!newUuid || typeof newUuid !== 'string') {
    getLogger({ buildUuid: uuid as string }).debug('Missing or invalid uuid in request body');
    return res.status(400).json({ error: 'uuid is required' });
  }

  try {
    const override = new OverrideService();

    const build: Build = await override.db.models.Build.query().findOne({ uuid }).withGraphFetched('pullRequest');

    if (!build) {
      getLogger({ buildUuid: uuid as string }).debug('Build not found, cannot patch uuid');
      return res.status(404).json({ error: 'Build not found' });
    }

    if (newUuid === build.uuid) {
      getLogger({ buildUuid: uuid as string }).debug(`Attempted to update UUID to same value: newUuid=${newUuid}`);
      return res.status(400).json({ error: 'UUID must be different' });
    }

    const validation = await override.validateUuid(newUuid);
    if (!validation.valid) {
      getLogger({ buildUuid: uuid as string }).debug(`UUID validation failed: error=${validation.error}`);
      return res.status(400).json({ error: validation.error });
    }

    const result = await override.updateBuildUuid(build, newUuid);

    if (build.pullRequest?.deployOnUpdate) {
      getLogger({ stage: LogStage.BUILD_QUEUED, buildUuid: build.uuid }).info(`Triggering redeploy after UUID update`);
      await new BuildService().resolveAndDeployBuildQueue.add('resolve-deploy', {
        buildId: build.id,
        runUUID: nanoid(),
        correlationId,
      });
    }

    return res.status(200).json({
      data: {
        ...result.build,
      },
    });
  } catch (error) {
    getLogger({ buildUuid: uuid as string }).error(
      { error: error instanceof Error ? error.message : String(error) },
      `Error updating UUID to newUuid=${newUuid}`
    );
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
}

/**
 * @openapi
 * /api/v1/builds/{uuid}:
 *   get:
 *     summary: Get build by UUID
 *     description: |
 *       Retrieves detailed information about a specific build by its UUID.
 *     tags:
 *       - Builds
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *     responses:
 *       200:
 *         description: Successfully retrieved build details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                 uuid:
 *                   type: string
 *                 status:
 *                   type: string
 *                 statusMessage:
 *                   type: string
 *                 enableFullYaml:
 *                   type: boolean
 *                 sha:
 *                   type: string
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *                 updatedAt:
 *                   type: string
 *                   format: date-time
 *                 deletedAt:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 pullRequestId:
 *                   type: integer
 *                 manifest:
 *                   type: object
 *                 webhooksYaml:
 *                   type: object
 *                 dashboardLinks:
 *                   type: object
 *                 isStatic:
 *                   type: boolean
 *                 namespace:
 *                   type: string
 *       404:
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Build not found
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *   patch:
 *     summary: Update build UUID
 *     description: |
 *       Updates the UUID (custom identifier) for a build and all related records.
 *       This changes the build's public URL and namespace.
 *     tags:
 *       - Builds
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The current UUID of the build to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               uuid:
 *                 type: string
 *                 description: The new UUID (3-50 characters, alphanumeric + hyphens)
 *                 example: my-custom-environment
 *             required:
 *               - uuid
 *     responses:
 *       200:
 *         description: UUID updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   description: The updated build object
 *                   properties:
 *                     id:
 *                       type: number
 *                       example: 12345
 *                     uuid:
 *                       type: string
 *                       example: my-custom-environment
 *                     namespace:
 *                       type: string
 *                       example: env-my-custom-environment
 *                     updatedAt:
 *                       type: string
 *                       example: 2025-09-09T10:30:00Z
 *                     status:
 *                       type: string
 *                       example: active
 *                     statusMessage:
 *                       type: string
 *                       example: Build is running
 *                     enableFullYaml:
 *                       type: boolean
 *                       example: true
 *                     sha:
 *                       type: string
 *                       example: abc123def456
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                       example: 2025-09-09T09:00:00Z
 *                     deletedAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       example: null
 *                     pullRequestId:
 *                       type: integer
 *                       example: 42
 *                     manifest:
 *                       type: object
 *                       example: {}
 *                     webhooksYaml:
 *                       type: object
 *                       example: {}
 *                     dashboardLinks:
 *                       type: object
 *                       example: {}
 *                     isStatic:
 *                       type: boolean
 *                       example: false
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   examples:
 *                     missing_uuid:
 *                       value: uuid is required
 *                     same_uuid:
 *                       value: UUID must be different
 *                     invalid_format:
 *                       value: UUID can only contain letters, numbers, and hyphens
 *                     invalid_length:
 *                       value: UUID must be between 3 and 50 characters
 *                     invalid_boundaries:
 *                       value: UUID cannot start or end with a hyphen
 *       404:
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Build not found
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: GET is not allowed
 *       409:
 *         description: UUID conflict
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: UUID is not available
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: An unexpected error occurred
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  const { uuid } = req.query;

  if (!uuid || typeof uuid !== 'string') {
    return res.status(400).json({ error: 'Invalid UUID' });
  }

  // Only PATCH needs correlationId for queue operations
  if (req.method === 'PATCH') {
    const correlationId = `api-build-update-${Date.now()}-${nanoid(8)}`;
    return withLogContext({ correlationId }, async () => {
      return updateBuild(req, res, correlationId);
    });
  }

  switch (req.method) {
    case 'GET':
      return retrieveBuild(req, res);
    default:
      return res.status(405).json({ error: `${req.method} is not allowed` });
  }
};
