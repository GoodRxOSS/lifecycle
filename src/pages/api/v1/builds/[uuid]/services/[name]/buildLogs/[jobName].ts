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
import unifiedLogStreamHandler from '../logs/[jobName]';

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/buildLogs/{jobName}:
 *   get:
 *     summary: Get build log streaming information for a specific job
 *     description: |
 *       Returns WebSocket endpoint and parameters for streaming build logs from Kubernetes.
 *       This endpoint provides information needed to establish a WebSocket connection
 *       for real-time log streaming.
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
 *       - in: path
 *         name: jobName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the build job
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
 *                   enum: [Active, Complete, Failed, NotFound]
 *                   description: Current status of the build job
 *                 websocket:
 *                   type: object
 *                   properties:
 *                     endpoint:
 *                       type: string
 *                       example: wss://example.com/k8s/log/namespace/pod-name/container
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
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       state:
 *                         type: string
 *       400:
 *         description: Bad request
 *       404:
 *         description: Build or deploy not found
 *       405:
 *         description: Method not allowed
 *       500:
 *         description: Internal server error
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { uuid, jobName } = req.query;

  return withLogContext({ buildUuid: uuid as string }, async () => {
    getLogger().info(`API: build logs endpoint called method=${req.method} jobName=${jobName}`);

    req.query.type = 'build';

    return unifiedLogStreamHandler(req, res);
  });
}
