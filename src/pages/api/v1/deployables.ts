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
  filename: 'deployables.ts',
});

/**
 * @openapi
 * /api/v1/deployables:
 *   get:
 *     summary: Get deployables by build ID
 *     description: |
 *       Retrieves all deployables associated with a specific build ID.
 *     tags:
 *       - Deployables
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: buildId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The ID of the build
 *       - in: query
 *         name: name
 *         required: false
 *         schema:
 *           type: string
 *         description: Filter deployables by name
 *     responses:
 *       200:
 *         description: Successfully retrieved deployables
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   buildUUID:
 *                     type: string
 *                   buildId:
 *                     type: integer
 *                   name:
 *                     type: string
 *                   branchName:
 *                     type: string
 *                   type:
 *                     type: string
 *                   active:
 *                     type: boolean
 *                   grpc:
 *                     type: object
 *                   capacityType:
 *                     type: string
 *                   public:
 *                     type: boolean
 *                   commentBranchName:
 *                     type: string
 *                   deploymentDependsOn:
 *                     type: object
 *                   dockerBuildPipelineName:
 *                     type: string
 *                   builder:
 *                     type: object
 *       400:
 *         description: Invalid build ID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid build ID
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

  const { buildId, name } = req.query;
  const parsedBuildId = parseInt(buildId as string, 10);

  if (!buildId || typeof buildId !== 'string' || isNaN(parsedBuildId)) {
    return res.status(400).json({ error: 'Invalid build ID' });
  }

  try {
    const buildService = new BuildService();

    // First check if build exists
    const build = await buildService.db.models.Build.query().findById(parsedBuildId).select('id');

    if (!build) {
      logger.info(`Build with ID ${parsedBuildId} not found`);
      return res.status(404).json({ error: 'Build not found' });
    }

    // Get deployables for this build
    let query = buildService.db.models.Deployable.query().where('buildId', parsedBuildId);

    // Apply name filter if provided
    if (name && typeof name === 'string') {
      query = query.where('name', name);
    }

    const deployables = await query.select(
      'id',
      'buildUUID',
      'buildId',
      'name',
      'branchName',
      'type',
      'active',
      'grpc',
      'capacityType',
      'public',
      'commentBranchName',
      'deploymentDependsOn',
      'dockerBuildPipelineName',
      'builder'
    );

    return res.status(200).json(deployables);
  } catch (error) {
    logger.error(`Error fetching deployables for build ${parsedBuildId}:`, error);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
