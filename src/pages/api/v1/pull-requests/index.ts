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
import PullRequestService from 'server/services/pullRequest';

/**
 * @openapi
 * /api/v1/pull-requests:
 *   get:
 *     summary: Get pull requests with filtering and pagination
 *     description: |
 *       Retrieves pull requests with optional filtering by user, repository, and status exclusion.
 *       Results are ordered by updatedAt descending and paginated with a default limit of 25.
 *     tags:
 *       - Pull Requests
 *     parameters:
 *       - in: query
 *         name: user
 *         required: false
 *         schema:
 *           type: string
 *         description: Filter by GitHub username (githubLogin)
 *         example: "johndoe"
 *       - in: query
 *         name: repo
 *         required: false
 *         schema:
 *           type: string
 *         description: Filter by repository name (fullName)
 *         example: "owner/repository"
 *       - in: query
 *         name: exclude
 *         required: false
 *         schema:
 *           oneOf:
 *             - type: array
 *               items:
 *                 type: string
 *             - type: string
 *         description: |
 *           Status values to exclude from results. Can be passed as:
 *           - JSON array string: exclude=["closed","merged"]
 *           - Multiple query params: exclude=closed&exclude=merged
 *           - Single value: exclude=closed
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 25
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Successfully retrieved pull requests list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - pull_requests
 *                 - metadata
 *               properties:
 *                 pull_requests:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       deployOnUpdate:
 *                         type: boolean
 *                       branchName:
 *                         type: string
 *                       fullName:
 *                         type: string
 *                       latestCommit:
 *                         type: string
 *                       pullRequestNumber:
 *                         type: integer
 *                       repositoryId:
 *                         type: integer
 *                       status:
 *                         type: string
 *                       title:
 *                         type: string
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       commentId:
 *                         type: string
 *                       githubLogin:
 *                         type: string
 *                       id:
 *                         type: integer
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
 *                       example: 5
 *                     total:
 *                       type: integer
 *                       description: Total number of pull requests after filtering
 *                       example: 100
 *                     limit:
 *                       type: integer
 *                       description: Number of items per page
 *                       example: 25
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid parameters"
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
    const { user, repo, exclude, page, limit } = req.query;

    // Build base query
    let query = pullRequestService.db.models.PullRequest.query()
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
      )
      .orderBy('updatedAt', 'desc');

    // Apply user filter if provided
    if (user && typeof user === 'string') {
      query = query.where('githubLogin', user);
    }

    // Apply repo filter if provided
    if (repo && typeof repo === 'string') {
      query = query.where('fullName', repo);
    }

    // Parse exclude parameter
    if (exclude) {
      let excludeStatuses: string[] = [];
      if (Array.isArray(exclude)) {
        excludeStatuses = exclude.filter((status) => typeof status === 'string');
      } else if (typeof exclude === 'string') {
        try {
          const parsed = JSON.parse(exclude);
          if (Array.isArray(parsed)) {
            excludeStatuses = parsed.filter((status) => typeof status === 'string');
          } else {
            excludeStatuses = [exclude];
          }
        } catch {
          // If not valid JSON, treat as single value
          excludeStatuses = [exclude];
        }
      }

      if (excludeStatuses.length > 0) {
        query = query.whereNotIn('status', excludeStatuses);
      }
    }

    // Apply pagination (always paginate with default limit 25)
    const pageNumber = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNumber = Math.max(1, parseInt(limit as string, 10) || 25);
    const offset = (pageNumber - 1) * limitNumber;

    // Get total count using a cloned query
    const totalCount = await query.resultSize();

    // Apply pagination to the original query
    const pullRequests = await query.offset(offset).limit(limitNumber);

    interface Response {
      pull_requests: any[];
      metadata: {
        currentPage: number;
        totalPages: number;
        total: number;
        limit: number;
      };
    }

    const response: Response = {
      pull_requests: pullRequests,
      metadata: {
        currentPage: pageNumber,
        totalPages: Math.ceil(totalCount / limitNumber),
        total: totalCount,
        limit: limitNumber,
      },
    };

    return res.status(200).json(response);
  } catch (error) {
    getLogger().error(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to fetch pull requests'
    );
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
