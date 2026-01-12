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
import { getLogger } from 'server/lib/logger/index';
import BuildService from 'server/services/build';
import PullRequestService from 'server/services/pullRequest';

/**
 * @openapi
 * /api/v1/pull-requests/{id}/builds:
 *   get:
 *     summary: Get builds by pull request ID
 *     description: |
 *       Retrieves all builds associated with a specific pull request ID.
 *     tags:
 *       - Builds
 *       - Pull Requests
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The ID of the pull request
 *     responses:
 *       200:
 *         description: Successfully retrieved builds
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   uuid:
 *                     type: string
 *                   status:
 *                     type: string
 *                   statusMessage:
 *                     type: string
 *                   enableFullYaml:
 *                     type: boolean
 *                   sha:
 *                     type: string
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
 *                   pullRequestId:
 *                     type: integer
 *                   manifest:
 *                     type: object
 *                   webhooksYaml:
 *                     type: object
 *                   dashboardLinks:
 *                     type: object
 *                   isStatic:
 *                     type: boolean
 *       400:
 *         description: Invalid pull request ID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid pull request ID
 *       404:
 *         description: Pull request not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Pull request not found
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

  const { id } = req.query;
  const parsedId = parseInt(id as string, 10);

  if (!id || typeof id !== 'string' || isNaN(parsedId)) {
    return res.status(400).json({ error: 'Invalid pull request ID' });
  }

  try {
    const pullRequestService = new PullRequestService();
    const buildService = new BuildService();

    // First check if pull request exists
    const pullRequest = await pullRequestService.db.models.PullRequest.query().findById(parsedId).select('id');

    if (!pullRequest) {
      getLogger().debug(`Pull request not found: id=${parsedId}`);
      return res.status(404).json({ error: 'Pull request not found' });
    }

    // Get builds for this pull request
    const builds = await buildService.db.models.Build.query()
      .where('pullRequestId', parsedId)
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
        'isStatic'
      );

    return res.status(200).json(builds);
  } catch (error) {
    getLogger().error({ error }, `API: builds fetch failed pullRequestId=${parsedId}`);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
