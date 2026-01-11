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

/**
 * @openapi
 * /api/v1/builds:
 *   get:
 *     summary: Get all builds with optional status filtering
 *     description: |
 *       Retrieves a list of builds with optional status exclusion filtering and pagination support.
 *       By default, excludes builds with status 'torn_down' and 'pending'.
 *     tags:
 *       - Builds
 *     parameters:
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
 *           - JSON array string: exclude=["torn_down","pending"]
 *           - Multiple query params: exclude=torn_down&exclude=pending
 *           - Single value: exclude=torn_down
 *           Default: ["torn_down", "pending"]
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
 *         description: Successfully retrieved builds list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - builds
 *                 - metadata
 *               properties:
 *                 builds:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required:
 *                       - uuid
 *                       - status
 *                     properties:
 *                       uuid:
 *                         type: string
 *                         description: Unique identifier for the build
 *                         example: "550e8400-e29b-41d4-a716-446655440000"
 *                       status:
 *                         type: string
 *                         description: Current status of the build
 *                         example: "success"
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
 *                       description: Total number of builds after filtering
 *                       example: 100
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
    const buildService = new BuildService();

    // Extract query parameters
    const { exclude, page, limit } = req.query;

    // Parse exclude parameter - default to ['torn_down', 'pending']
    let excludeStatuses: string[] = ['torn_down', 'pending'];
    if (exclude) {
      if (Array.isArray(exclude)) {
        excludeStatuses = exclude.filter((status) => typeof status === 'string');
      } else if (typeof exclude === 'string') {
        try {
          const parsed = JSON.parse(exclude);
          if (Array.isArray(parsed)) {
            excludeStatuses = parsed.filter((status) => typeof status === 'string');
          }
        } catch {
          // If not valid JSON, treat as single value
          excludeStatuses = [exclude];
        }
      }
    }

    // Build base query
    let query = buildService.db.models.Build.query().select('uuid', 'status').whereNotIn('status', excludeStatuses);

    // Handle pagination
    let response: any = {};

    if (page || limit) {
      // If pagination params provided, apply pagination
      const pageNumber = Math.max(1, parseInt(page as string, 10) || 1);
      const limitNumber = Math.max(1, parseInt(limit as string, 10) || 20);
      const offset = (pageNumber - 1) * limitNumber;

      // Get total count
      const totalCount = await query.resultSize();

      // Apply pagination
      const builds = await query.offset(offset).limit(limitNumber);

      response = {
        builds,
        metadata: {
          currentPage: pageNumber,
          totalPages: Math.ceil(totalCount / limitNumber),
          total: totalCount,
          limit: limitNumber,
        },
      };
    } else {
      // No pagination - return all results
      const builds = await query;

      response = {
        builds,
        metadata: {
          currentPage: 1,
          totalPages: 1,
          total: builds.length,
          limit: builds.length,
        },
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    getLogger({ error }).error('Failed to fetch builds');
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
};
