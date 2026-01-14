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

import type { NextApiRequest, NextApiResponse } from 'next';
import { getLogger, withLogContext } from 'server/lib/logger';
import { HttpError } from '@kubernetes/client-node';
import { DeploymentJobInfo, getDeploymentJobs } from 'server/lib/kubernetes/getDeploymentJobs';

interface DeployLogsListResponse {
  deployments: DeploymentJobInfo[];
}

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/deployLogs:
 *   get:
 *     summary: List deployment jobs for a service
 *     description: |
 *       Returns a list of all deployment jobs for a specific service within a build.
 *       This includes both Helm deployment jobs and GitHub-type deployment jobs.
 *     tags:
 *       - Deployments
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
 *         description: The name of the service
 *     responses:
 *       '200':
 *         description: List of deployment jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deployments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       jobName:
 *                         type: string
 *                         description: Kubernetes job name
 *                         example: deploy-uuid-helm-123-abc123
 *                       deployUuid:
 *                         type: string
 *                         description: Deploy UUID
 *                         example: deploy-uuid
 *                       sha:
 *                         type: string
 *                         description: Git commit SHA
 *                         example: abc123
 *                       status:
 *                         type: string
 *                         enum: [Active, Complete, Failed]
 *                         description: Current status of the deployment job
 *                       startedAt:
 *                         type: string
 *                         format: date-time
 *                         description: When the job started
 *                       completedAt:
 *                         type: string
 *                         format: date-time
 *                         description: When the job completed
 *                       duration:
 *                         type: number
 *                         description: Deployment duration in seconds
 *                       error:
 *                         type: string
 *                         description: Error message if job failed
 *                       podName:
 *                         type: string
 *                         description: Name of the pod running the job
 *                       deploymentType:
 *                         type: string
 *                         enum: [helm, github]
 *                         description: Type of deployment (helm or github)
 *       '400':
 *         description: Invalid parameters
 *       '404':
 *         description: Environment or service not found
 *       '405':
 *         description: Method not allowed
 *       '502':
 *         description: Failed to communicate with Kubernetes
 *       '500':
 *         description: Internal server error
 */
const deployLogsHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  const { uuid, name } = req.query;

  return withLogContext({ buildUuid: uuid as string }, async () => {
    if (req.method !== 'GET') {
      getLogger().warn(`API: method not allowed method=${req.method}`);
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: `${req.method} is not allowed` });
    }

    if (typeof uuid !== 'string' || typeof name !== 'string') {
      getLogger().warn(`API: invalid params uuid=${uuid} name=${name}`);
      return res.status(400).json({ error: 'Missing or invalid uuid or name parameters' });
    }

    try {
      const namespace = `env-${uuid}`;

      const deployments = await getDeploymentJobs(name, namespace);

      const response: DeployLogsListResponse = {
        deployments,
      };

      return res.status(200).json(response);
    } catch (error) {
      getLogger().error({ error }, `API: deploy logs fetch failed service=${name}`);

      if (error instanceof HttpError) {
        if (error.response?.statusCode === 404) {
          return res.status(404).json({ error: 'Environment or service not found.' });
        }
        return res.status(502).json({ error: 'Failed to communicate with Kubernetes.' });
      }

      return res.status(500).json({ error: 'Internal server error occurred.' });
    }
  });
};

export default deployLogsHandler;
