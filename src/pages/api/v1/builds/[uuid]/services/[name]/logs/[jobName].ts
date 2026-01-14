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

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/logs/{jobName}:
 *   get:
 *     summary: Get log streaming information for a specific job (build or deploy)
 *     description: |
 *       Returns WebSocket endpoint and parameters for streaming logs from Kubernetes.
 *       This unified endpoint handles both build and deployment logs, providing information
 *       needed to establish a WebSocket connection for real-time log streaming.
 *     tags:
 *       - Logs
 *       - Builds
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
 *       - in: path
 *         name: jobName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the job (build or deploy)
 *       - in: query
 *         name: type
 *         required: false
 *         schema:
 *           type: string
 *           enum: [build, deploy, webhook]
 *         description: The type of logs to retrieve (defaults to auto-detection based on job name)
 *     responses:
 *       200:
 *         description: Successful response with WebSocket information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [Active, Complete, Failed, NotFound, Pending]
 *                   description: Current status of the job
 *                 streamingRequired:
 *                   type: boolean
 *                   description: Whether streaming is required for active logs
 *                 podName:
 *                   type: string
 *                   nullable: true
 *                   description: Name of the pod running the job
 *                 websocket:
 *                   type: object
 *                   properties:
 *                     endpoint:
 *                       type: string
 *                       example: /api/logs/stream
 *                     parameters:
 *                       type: object
 *                       properties:
 *                         podName:
 *                           type: string
 *                         namespace:
 *                           type: string
 *                         follow:
 *                           type: boolean
 *                         timestamps:
 *                           type: boolean
 *                         container:
 *                           type: string
 *                           required: false
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       state:
 *                         type: string
 *                 message:
 *                   type: string
 *                   description: Additional message about the job status
 *                 error:
 *                   type: string
 *                   description: Error message if applicable
 *       400:
 *         description: Bad request - missing or invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Missing or invalid parameters
 *       404:
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Build not found
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
 *                   example: Internal server error occurred.
 *       502:
 *         description: Bad gateway - failed to communicate with Kubernetes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to communicate with Kubernetes.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getLogger, withLogContext } from 'server/lib/logger';
import { LogStreamingService } from 'server/services/logStreaming';
import { HttpError } from '@kubernetes/client-node';

const unifiedLogStreamHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  const { uuid, name, jobName, type } = req.query;

  return withLogContext({ buildUuid: uuid as string }, async () => {
    if (req.method !== 'GET') {
      getLogger().warn(`API: method not allowed method=${req.method}`);
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: `${req.method} is not allowed` });
    }

    const isWebhookRequest = type === 'webhook';

    if (typeof uuid !== 'string' || typeof jobName !== 'string' || (!isWebhookRequest && typeof name !== 'string')) {
      getLogger().warn(`API: invalid params uuid=${uuid} name=${name} jobName=${jobName} type=${type}`);
      return res.status(400).json({ error: 'Missing or invalid parameters' });
    }

    if (type && (typeof type !== 'string' || !['build', 'deploy', 'webhook'].includes(type))) {
      getLogger().warn(`API: invalid type param type=${type}`);
      return res.status(400).json({ error: 'Invalid type parameter. Must be "build", "deploy", or "webhook"' });
    }

    try {
      const logService = new LogStreamingService();

      const response = await logService.getLogStreamInfo(
        uuid,
        jobName,
        name as string | undefined,
        type as string | undefined
      );

      return res.status(200).json(response);
    } catch (error: any) {
      getLogger().error({ error }, `API: log streaming info failed jobName=${jobName} service=${name}`);

      if (error.message === 'Build not found') {
        return res.status(404).json({ error: 'Build not found' });
      }

      if (error instanceof HttpError || error.message?.includes('Kubernetes') || error.statusCode === 502) {
        return res.status(502).json({ error: 'Failed to communicate with Kubernetes.' });
      }

      return res.status(500).json({ error: 'Internal server error occurred.' });
    }
  });
};

export default unifiedLogStreamHandler;
