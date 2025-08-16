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
import BuildService from 'server/services/build';
import { validateAuth } from 'server/lib/auth/validate';

const logger = rootLogger.child({
  filename: 'builds/[uuid]/index.ts',
});

/**
 * @openapi
 * /api/v1/builds/{uuid}:
 *   get:
 *     summary: Get build by UUID
 *     description: |
 *       Retrieves detailed information about a specific build by its UUID.
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
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { valid } = await validateAuth(req, res);
  if (!valid) return;

  const { uuid } = req.query;

  if (!uuid || typeof uuid !== 'string') {
    return res.status(400).json({ error: 'Invalid UUID' });
  }

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
      logger.info(`Build with UUID ${uuid} not found`);
      return res.status(404).json({ error: 'Build not found' });
    }

    return res.status(200).json(build);
  } catch (error) {
    logger.error(`Error fetching build ${uuid}:`, error);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
