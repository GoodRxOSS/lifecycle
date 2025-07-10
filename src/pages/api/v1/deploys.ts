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

const logger = rootLogger.child({
  filename: 'deploys.ts',
});

/**
 * @openapi
 * /api/v1/deploys:
 *   get:
 *     summary: Get deploys by build ID
 *     description: |
 *       Retrieves all deploys associated with a specific build ID.
 *     tags:
 *       - Deploys
 *     parameters:
 *       - in: query
 *         name: buildId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The ID of the build
 *       - in: query
 *         name: deployableId
 *         required: false
 *         schema:
 *           type: integer
 *         description: Filter deploys by deployable ID
 *     responses:
 *       200:
 *         description: Successfully retrieved deploys
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   status:
 *                     type: string
 *                   statusMessage:
 *                     type: string
 *                   uuid:
 *                     type: string
 *                   dockerImage:
 *                     type: string
 *                   internalHostname:
 *                     type: string
 *                   publicUrl:
 *                     type: string
 *                   env:
 *                     type: object
 *                   buildLogs:
 *                     type: string
 *                   containerLogs:
 *                     type: string
 *                   serviceId:
 *                     type: integer
 *                   buildId:
 *                     type: integer
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *                   updatedAt:
 *                     type: string
 *                     format: date-time
 *                   deletedAt:
 *                     type: string
 *                     format: date-time
 *                     nullable: true
 *                   branchName:
 *                     type: string
 *                   tag:
 *                     type: string
 *                   githubRepositoryId:
 *                     type: integer
 *                   sha:
 *                     type: string
 *                   initDockerImage:
 *                     type: string
 *                   initEnv:
 *                     type: object
 *                   active:
 *                     type: boolean
 *                   cname:
 *                     type: string
 *                   runUUID:
 *                     type: string
 *                   replicaCount:
 *                     type: integer
 *                   yamlConfig:
 *                     type: object
 *                   deployableId:
 *                     type: integer
 *                   isRunningLatest:
 *                     type: boolean
 *                   runningImage:
 *                     type: string
 *                   deployPipelineId:
 *                     type: string
 *                   buildOutput:
 *                     type: string
 *                   buildJobName:
 *                     type: string
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

  const { buildId, deployableId } = req.query;
  const parsedBuildId = parseInt(buildId as string, 10);
  const parsedDeployableId = deployableId ? parseInt(deployableId as string, 10) : undefined;

  if (!buildId || typeof buildId !== 'string' || isNaN(parsedBuildId)) {
    return res.status(400).json({ error: 'Invalid build ID' });
  }

  if (deployableId && (typeof deployableId !== 'string' || isNaN(parsedDeployableId!))) {
    return res.status(400).json({ error: 'Invalid deployable ID' });
  }

  try {
    const buildService = new BuildService();

    // First check if build exists
    const build = await buildService.db.models.Build.query().findById(parsedBuildId).select('id');

    if (!build) {
      logger.info(`Build with ID ${parsedBuildId} not found`);
      return res.status(404).json({ error: 'Build not found' });
    }

    // Get deploys for this build
    let query = buildService.db.models.Deploy.query().where('buildId', parsedBuildId);

    // Apply deployableId filter if provided
    if (parsedDeployableId) {
      query = query.where('deployableId', parsedDeployableId);
    }

    const deploys = await query.select(
      'id',
      'status',
      'statusMessage',
      'uuid',
      'dockerImage',
      'internalHostname',
      'publicUrl',
      'env',
      'buildLogs',
      'containerLogs',
      'serviceId',
      'buildId',
      'createdAt',
      'updatedAt',
      'deletedAt',
      'branchName',
      'tag',
      'githubRepositoryId',
      'sha',
      'initDockerImage',
      'initEnv',
      'active',
      'cname',
      'runUUID',
      'replicaCount',
      'yamlConfig',
      'deployableId',
      'isRunningLatest',
      'runningImage',
      'deployPipelineId',
      'buildOutput',
      'buildJobName'
    );

    return res.status(200).json(deploys);
  } catch (error) {
    logger.error(`Error fetching deploys for build ${parsedBuildId}:`, error);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
