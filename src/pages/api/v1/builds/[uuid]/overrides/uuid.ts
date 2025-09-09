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
import rootLogger from 'server/lib/logger';
import { Build } from 'server/models';
import BuildService from 'server/services/build';
import OverrideService from 'server/services/override';

const logger = rootLogger.child({
  filename: 'builds/[uuid]/overrides/uuid.ts',
});

/**
 * @openapi
 * /api/v1/builds/{uuid}/overrides/uuid:
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
 *                 message:
 *                   type: string
 *                   example: UUID updated successfully
 *                 build:
 *                   type: object
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
 *                       value: UUID must be different from current UUID
 *                     invalid_format:
 *                       value: UUID can only contain letters, numbers, and hyphens
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
 *                   example: UUID 'my-custom-environment' is already in use
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
  if (req.method !== 'PATCH') {
    logger.info({ method: req.method }, `[${req.method}] Method not allowed`);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const currentUuid = req.query?.uuid as string;
  const { uuid: newUuid } = req.body;

  if (!newUuid || typeof newUuid !== 'string') {
    logger.info(`[${currentUuid}] Missing or invalid uuid in request body`);
    return res.status(400).json({ error: 'uuid is required' });
  }

  try {
    const override = new OverrideService();

    const build: Build = await override.db.models.Build.query()
      .findOne({ uuid: currentUuid })
      .withGraphFetched('pullRequest');

    if (!build) {
      logger.info(`[${currentUuid}] Build not found, cannot patch uuid.`);
      return res.status(404).json({ error: 'Build not found' });
    }

    if (newUuid === build.uuid) {
      logger.info(`[${currentUuid}] Attempted to update UUID to same value: ${newUuid}`);
      return res.status(400).json({ error: 'UUID must be different' });
    }

    const validation = await override.validateUuid(newUuid);
    if (!validation.valid) {
      logger.info(`[${currentUuid}] UUID validation failed on attempt to change: ${validation.error}`);
      return res.status(400).json({ error: validation.error });
    }

    const result = await override.updateBuildUuid(build, newUuid);

    if (build.pullRequest.deployOnUpdate) {
      await new BuildService().resolveAndDeployBuildQueue.add('resolve-deploy', {
        buildId: build.id,
        runUUID: nanoid(),
      });
    }

    return res.status(200).json({
      message: 'UUID updated successfully',
      build: {
        id: result.build.id,
        uuid: result.build.uuid,
        namespace: result.build.namespace,
        updatedAt: result.build.updatedAt,
      },
    });
  } catch (error) {
    logger.error({ error }, `[${currentUuid}] Error updating UUID to ${newUuid}: ${error}`);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
