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
import GithubService from 'server/services/github';
import { Build } from 'server/models';
import DeployService from 'server/services/deploy';
import { DeployStatus } from 'shared/constants';
import { nanoid } from 'nanoid';
import BuildService from 'server/services/build';
import { validateAuth } from 'server/lib/auth/validate';

const logger = rootLogger.child({
  filename: 'builds/[uuid]/services/[name]/build.ts',
});

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/build:
 *   post:
 *     summary: Redeploy a service within a build
 *     description: |
 *       Triggers a redeployment of a specific service within a build. The service
 *       will be queued for deployment and its status will be updated accordingly.
 *     tags:
 *       - Services
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the service to redeploy
 *     responses:
 *       200:
 *         description: Service has been successfully queued for redeployment
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
 *                   example: Redeploy for service example-service in build abc-123 has been queued
 *       404:
 *         description: Build or service not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Build not found for abc-123
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
 *                   example: Unable to proceed with redeploy for services example-service in build abc-123.
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { valid } = await validateAuth(req, res);
  if (!valid) return;

  const { uuid, name } = req.query;

  try {
    const githubService = new GithubService();
    const build: Build = await githubService.db.models.Build.query()
      .findOne({
        uuid,
      })
      .withGraphFetched('deploys.deployable');

    const buildId = build.id;

    if (!build) {
      logger.info(`Build with UUID ${uuid} not found`);
      return res.status(404).json({ error: `Build not found for ${uuid}` });
    }

    const deploy = build.deploys.find((deploy) => deploy.deployable.name === name);

    if (!deploy) {
      logger.info(`Deployable ${name} not found in build ${uuid}`);
      res.status(404).json({ error: `${name} service is not found in ${uuid} build.` });
      return;
    }

    const githubRepositoryId = deploy.deployable.repositoryId;

    const runUUID = nanoid();
    const buildService = new BuildService();
    await buildService.resolveAndDeployBuildQueue.add('resolve-deploy', {
      buildId,
      githubRepositoryId,
      runUUID,
    });

    const deployService = new DeployService();

    await deploy.$query().patchAndFetch({
      runUUID,
    });

    await deployService.patchAndUpdateActivityFeed(
      deploy,
      {
        status: DeployStatus.QUEUED,
      },
      runUUID
    );
    return res.status(200).json({
      status: 'success',
      message: `Redeploy for service ${name} in build ${uuid} has been queued`,
    });
  } catch (error) {
    logger.error(`Unable to proceed with redeploy for services ${name} in build ${uuid}. Error: \n ${error}`);
    return res.status(500).json({ error: `Unable to proceed with redeploy for services ${name} in build ${uuid}.` });
  }
};
