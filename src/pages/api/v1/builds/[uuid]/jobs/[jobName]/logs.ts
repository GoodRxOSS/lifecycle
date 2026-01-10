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
import { getLogger } from 'server/lib/logger/index';
import unifiedLogStreamHandler from '../../services/[name]/logs/[jobName]';

/**
 * @openapi
 * /api/v1/builds/{uuid}/jobs/{jobName}/logs:
 *   get:
 *     summary: Get job log streaming information for webhooks
 *     description: |
 *       Returns WebSocket endpoint and parameters for streaming job logs from Kubernetes.
 *       This endpoint provides information needed to establish a WebSocket connection
 *       for real-time log streaming from webhook jobs.
 *     tags:
 *       - Webhooks
 *       - Jobs
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *       - in: path
 *         name: jobName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the job
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
 *       404:
 *         description: Build or job not found
 *       405:
 *         description: Method not allowed
 *       500:
 *         description: Internal server error
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { uuid, jobName } = req.query;
  getLogger({ buildUuid: uuid as string }).info(
    `method=${req.method} jobName=${jobName} Job logs endpoint called, delegating to unified handler`
  );

  req.query.type = 'webhook';

  req.query.name = undefined;

  return unifiedLogStreamHandler(req, res);
}
