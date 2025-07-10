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
import PullRequestService from 'server/services/pullRequest';

const logger = rootLogger.child({
  filename: 'api/v1/pull-requests/[id].ts',
});

/**
 * @openapi
 * /api/v1/pull-requests/{id}:
 *   get:
 *     summary: Get pull request by ID
 *     description: |
 *       Retrieves detailed information about a specific pull request by its ID.
 *     tags:
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
 *         description: Successfully retrieved pull request details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deployOnUpdate:
 *                   type: boolean
 *                 branchName:
 *                   type: string
 *                 fullName:
 *                   type: string
 *                 latestCommit:
 *                   type: string
 *                 pullRequestNumber:
 *                   type: integer
 *                 repositoryId:
 *                   type: integer
 *                 status:
 *                   type: string
 *                 title:
 *                   type: string
 *                 updatedAt:
 *                   type: string
 *                   format: date-time
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *                 commentId:
 *                   type: string
 *                 githubLogin:
 *                   type: string
 *                 id:
 *                   type: integer
 *                 labels:
 *                   type: object
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

    const pullRequest = await pullRequestService.db.models.PullRequest.query()
      .findById(parsedId)
      .select(
        'deployOnUpdate',
        'branchName',
        'fullName',
        'latestCommit',
        'pullRequestNumber',
        'repositoryId',
        'status',
        'title',
        'updatedAt',
        'createdAt',
        'commentId',
        'githubLogin',
        'id',
        'labels'
      );

    if (!pullRequest) {
      logger.info(`Pull request with ID ${parsedId} not found`);
      return res.status(404).json({ error: 'Pull request not found' });
    }

    return res.status(200).json(pullRequest);
  } catch (error) {
    logger.error(`Error fetching pull request ${parsedId}:`, error);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
