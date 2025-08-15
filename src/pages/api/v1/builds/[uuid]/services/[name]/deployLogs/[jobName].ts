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
 * /api/v1/builds/{uuid}/services/{name}/deployLogs/{jobName}:
 *   get:
 *     summary: Get deployment log streaming information for a specific job
 *     description: |
 *       Returns WebSocket endpoint and parameters for streaming deployment logs from Kubernetes.
 *       This endpoint provides information needed to establish a WebSocket connection
 *       for real-time log streaming from deployment jobs.
 *     tags:
 *       - Deployments
 *       - Native Helm
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
 *         description: The name of the service
 *       - in: path
 *         name: jobName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the deployment job
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
 *                   description: Current status of the deployment job
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
import rootLogger from 'server/lib/logger';
import unifiedLogStreamHandler from '../logs/[jobName]';
import { validateAuth } from 'server/lib/auth/validate';

const logger = rootLogger.child({
  filename: __filename,
});

const deployLogStreamHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  const { valid } = await validateAuth(req, res);
  if (!valid) return;

  logger.info(
    `method=${req.method} jobName=${req.query.jobName} message="Deploy logs endpoint called, delegating to unified handler"`
  );

  req.query.type = 'deploy';

  return unifiedLogStreamHandler(req, res);
};

export default deployLogStreamHandler;
