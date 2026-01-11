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
import { generateGraph } from 'server/lib/dependencyGraph';
import { getLogger } from 'server/lib/logger/index';
import { Build } from 'server/models';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v1/builds/{uuid}/graph:
 *   get:
 *     summary: Get build dependency graph
 *     description: |
 *       Retrieves the dependency graph for a specific build. If the graph doesn't exist,
 *       it will be generated and stored before being returned. The graph represents the
 *       relationships between different deployables in the build.
 *     tags:
 *       - Builds
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *     responses:
 *       200:
 *         description: Successfully retrieved dependency graph
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
 *                   example: Dependency graph for abc-123 returned.
 *                 dependencyGraph:
 *                   type: object
 *                   description: The dependency graph structure
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: POST is not allowed
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: An unexpected error occurred.
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { uuid } = req.query;

  try {
    const buildService = new BuildService();

    const build: Build = await buildService.db.models.Build.query()
      .findOne({
        uuid,
      })
      .withGraphFetched('[deploys.deployable, deployables]');

    if (Object.keys(build.dependencyGraph).length === 0) {
      // generate the graph if it does not exist
      const dependencyGraph = await generateGraph(build, 'TB');
      await build.$query().patchAndFetch({
        dependencyGraph,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: `Dependency  graph for ${uuid} returned.`,
      dependencyGraph: build.dependencyGraph,
    });
  } catch (error) {
    getLogger({ buildUuid: uuid as string }).error({ error }, 'Error fetching dependency graph');
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
};
