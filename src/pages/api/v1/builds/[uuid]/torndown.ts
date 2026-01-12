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
import { getLogger, withLogContext } from 'server/lib/logger/index';
import { Build } from 'server/models';

import { BuildStatus, DeployStatus } from 'shared/constants';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v1/builds/{uuid}/torndown:
 *   patch:
 *     summary: Tear down a build environment
 *     description: |
 *       Changes the status of all Deploys, Builds and Deployables associated with the specified
 *       UUID to torn_down. This effectively marks the environment as deleted.
 *     tags:
 *       - Builds
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build to tear down
 *     responses:
 *       200:
 *         description: Build successfully torn down
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: The namespace env-noisy-mud-690038 it was delete sucessfuly
 *                 namespacesUpdated:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: number
 *                         example: 64087
 *                       uuid:
 *                         type: string
 *                         example: noisy-mud-690038
 *                       status:
 *                         type: string
 *                         example: torn_down
 *       404:
 *         description: Build not found or is a static environment
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: The build doesn't exist or is static environment
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
 *                   example: An unexpected error occurred.
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'PATCH') {
    getLogger().debug(`Method not allowed: method=${req.method}`);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const uuid = req.query?.uuid;

  if (!uuid) {
    getLogger().debug('The uuid is required');
    return res.status(500).json({ error: 'The uuid is required' });
  }

  return withLogContext({ buildUuid: uuid as string }, async () => {
    try {
      const buildService = new BuildService();

      const build: Build = await buildService.db.models.Build.query()
        .findOne({
          uuid,
        })
        .withGraphFetched('[deploys]');

      if (build.isStatic || !build) {
        getLogger().debug('Build does not exist or is static environment');
        return res.status(404).json({ error: `The build doesn't exist or is static environment` });
      }

      const deploysIds = build.deploys.map((deploy) => deploy.id);

      await buildService.db.models.Build.query().findById(build.id).patch({
        status: BuildStatus.TORN_DOWN,
        statusMessage: 'Namespace was deleted successfully',
      });

      await buildService.db.models.Deploy.query()
        .whereIn('id', deploysIds)
        .patch({ status: DeployStatus.TORN_DOWN, statusMessage: 'Namespace was deleted successfully' });

      const updatedDeploys = await buildService.db.models.Deploy.query()
        .whereIn('id', deploysIds)
        .select('id', 'uuid', 'status');

      return res.status(200).json({
        status: `The namespace env-${uuid} it was delete sucessfuly`,
        namespacesUpdated: updatedDeploys,
      });
    } catch (error) {
      getLogger().error({ error }, 'Build: teardown failed');
      return res.status(500).json({ error: 'An unexpected error occurred.' });
    }
  });
};
