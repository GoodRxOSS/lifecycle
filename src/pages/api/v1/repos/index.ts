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
import { getLogger } from 'server/lib/logger';
import PullRequestService from 'server/services/pullRequest';

/**
 * @openapi
 * /api/v1/repos:
 *   get:
 *     summary: Get all distinct repository names from pull requests
 *     description: |
 *       Retrieves a list of distinct repository names (fullName) from the pull requests table.
 *       Returns all repositories by default, with optional pagination support.
 *     tags:
 *       - Repositories
 *     parameters:
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Page number for pagination (if not provided with limit, all results are returned)
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Number of items per page (if not provided with page, all results are returned)
 *     responses:
 *       200:
 *         description: Successfully retrieved repositories list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - repos
 *                 - metadata
 *               properties:
 *                 repos:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of distinct repository names
 *                   example: ["owner/repo1", "owner/repo2", "owner/repo3"]
 *                 metadata:
 *                   type: object
 *                   required:
 *                     - currentPage
 *                     - totalPages
 *                     - total
 *                     - limit
 *                   properties:
 *                     currentPage:
 *                       type: integer
 *                       description: Current page number
 *                       example: 1
 *                     totalPages:
 *                       type: integer
 *                       description: Total number of pages
 *                       example: 1
 *                     total:
 *                       type: integer
 *                       description: Total number of distinct repositories
 *                       example: 3
 *                     limit:
 *                       type: integer
 *                       description: Number of items per page
 *                       example: 20
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "POST is not allowed"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "An unexpected error occurred"
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  try {
    const pullRequestService = new PullRequestService();

    // Extract query parameters
    const { page, limit } = req.query;

    // Build base query for distinct fullName values
    const baseQuery = pullRequestService.db.models.PullRequest.query()
      .distinct('fullName')
      .select('fullName')
      .whereNotNull('fullName');

    // Handle pagination
    interface Response {
      repos: string[];
      metadata: {
        currentPage: number;
        totalPages: number;
        total: number;
        limit: number;
      };
    }

    let response: Response;

    if (page || limit) {
      // If pagination params provided, apply pagination
      const pageNumber = Math.max(1, parseInt(page as string, 10) || 1);
      const limitNumber = Math.max(1, parseInt(limit as string, 10) || 20);
      const offset = (pageNumber - 1) * limitNumber;

      const countResult = (await pullRequestService.db.models.PullRequest.query()
        .countDistinct('fullName as count')
        .whereNotNull('fullName')
        .first()) as { count?: string | number } | undefined;

      const totalCount = parseInt(String(countResult?.count || '0'), 10);

      const reposResult = await baseQuery.offset(offset).limit(limitNumber);

      const repos = reposResult.map((row: { fullName: string }) => row.fullName);

      response = {
        repos,
        metadata: {
          currentPage: pageNumber,
          totalPages: Math.ceil(totalCount / limitNumber),
          total: totalCount,
          limit: limitNumber,
        },
      };
    } else {
      const reposResult = await baseQuery;

      const repos = reposResult.map((row: { fullName: string }) => row.fullName);

      response = {
        repos,
        metadata: {
          currentPage: 1,
          totalPages: 1,
          total: repos.length,
          limit: repos.length,
        },
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    getLogger().error({ error }, 'API: repos fetch failed');
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
