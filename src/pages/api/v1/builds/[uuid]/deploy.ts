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

import { NextApiRequest, NextApiResponse } from 'next/types';
import rootLogger from 'server/lib/logger';
import { Build } from 'server/models';
import { nanoid } from 'nanoid';
import BuildService from 'server/services/build';
import { validateAuth } from 'server/lib/auth/validate';

const logger = rootLogger.child({
  filename: 'builds/[uuid]/deploy.ts',
});

/**
 * @openapi
 * /api/v1/builds/{uuid}/deploy:
 *   post:
 *     summary: Redeploy an entire build
 *     description: |
 *       Triggers a redeployment of all services within a build. The build
 *       will be queued for deployment and its status will be updated accordingly.
 *     tags:
 *       - Builds
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *     responses:
 *       200:
 *         description: Build has been successfully queued for redeployment
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Redeploy for build abc-123 has been queued
 *       404:
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Build not found for abc-123
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
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unable to proceed with redeploy for build abc-123.
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { valid } = await validateAuth(req, res);
  if (!valid) return;

  const { uuid } = req.query;

  try {
    const buildService = new BuildService();
    const build: Build = await buildService.db.models.Build.query()
      .findOne({ uuid })
      .withGraphFetched('deploys.deployable');

    if (!build) {
      logger.info(`Build with UUID ${uuid} not found`);
      return res.status(404).json({ error: `Build not found for ${uuid}` });
    }

    const buildId = build.id;
    const runUUID = nanoid();
    await buildService.resolveAndDeployBuildQueue.add('resolve-deploy', {
      buildId,
      runUUID,
    });

    return res.status(200).json({
      status: 'success',
      message: `Redeploy for build ${uuid} has been queued`,
    });
  } catch (error) {
    logger.error(`Unable to proceed with redeploy for build ${uuid}. Error: \n ${error}`);
    return res.status(500).json({ error: `Unable to proceed with redeploy for build ${uuid}.` });
  }
};
