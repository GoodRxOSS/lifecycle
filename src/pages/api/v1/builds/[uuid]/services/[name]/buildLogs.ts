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
import { getLogger, withLogContext } from 'server/lib/logger/index';
import { HttpError } from '@kubernetes/client-node';
import { BuildJobInfo, getNativeBuildJobs } from 'server/lib/kubernetes/getNativeBuildJobs';

interface BuildLogsListResponse {
  builds: BuildJobInfo[];
}

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/buildLogs:
 *   get:
 *     summary: List build jobs for a service
 *     description: |
 *       Returns a list of all build jobs for a specific service within a build.
 *       This includes both active and completed build jobs with their status,
 *       timing information, and the build engine used.
 *     tags:
 *       - Builds
 *       - Native Build
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
 *         description: List of build jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 builds:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       jobName:
 *                         type: string
 *                         description: Kubernetes job name
 *                         example: build-api-abc123-1234567890
 *                       buildUuid:
 *                         type: string
 *                         description: Deploy UUID
 *                         example: api-abc123
 *                       sha:
 *                         type: string
 *                         description: Git commit SHA
 *                         example: a1b2c3d4e5f6
 *                       status:
 *                         type: string
 *                         enum: [Active, Complete, Failed, Pending]
 *                         description: Current status of the build job
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
 *                         description: Build duration in seconds
 *                       engine:
 *                         type: string
 *                         enum: [buildkit, kaniko, unknown]
 *                         description: Build engine used
 *       '400':
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '404':
 *         description: Environment or service not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '405':
 *         description: Method not allowed (only GET is supported)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: POST is not allowed
 *       '502':
 *         description: Failed to communicate with Kubernetes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Internal server error occurred.
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  const { uuid, name } = req.query;

  return withLogContext({ buildUuid: uuid as string }, async () => {
    if (req.method !== 'GET') {
      getLogger().warn(`API: method not allowed method=${req.method}`);
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: `${req.method} is not allowed` });
    }

    if (typeof uuid !== 'string' || typeof name !== 'string') {
      getLogger().warn(`API: invalid parameters uuid=${uuid} name=${name}`);
      return res.status(400).json({ error: 'Missing or invalid uuid or name parameters' });
    }

    try {
      const namespace = `env-${uuid}`;

      const buildJobs = await getNativeBuildJobs(name, namespace);

      const response: BuildLogsListResponse = {
        builds: buildJobs,
      };

      return res.status(200).json(response);
    } catch (error) {
      getLogger().error({ error }, `API: build logs fetch failed service=${name}`);

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
