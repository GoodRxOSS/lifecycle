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
import rootLogger from 'server/lib/logger';
import { getK8sJobStatusAndPod } from 'server/lib/logStreamingHelper';
import BuildService from 'server/services/build';

const logger = rootLogger.child({
  filename: 'buildLogs/[jobName].ts',
});

interface BuildLogStreamResponse {
  status: 'Active' | 'Complete' | 'Failed' | 'NotFound' | 'Pending';
  streamingRequired: boolean;
  podName?: string | null;
  websocket?: {
    endpoint: string;
    parameters: {
      podName: string;
      namespace: string;
      follow: boolean;
      timestamps: boolean;
      container?: string;
    };
  };
  containers?: Array<{
    name: string;
    state: string;
  }>;
  message?: string;
  error?: string;
}

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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uuid, name, jobName } = req.query;

  if (
    !uuid ||
    !name ||
    !jobName ||
    typeof uuid !== 'string' ||
    typeof name !== 'string' ||
    typeof jobName !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    const buildService = new BuildService();

    const build = await buildService.db.models.Build.query().findOne({ uuid });

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const namespace = `env-${build.uuid}`;

    const podInfo = await getK8sJobStatusAndPod(jobName, namespace);

    if (!podInfo || podInfo.status === 'NotFound') {
      const response: BuildLogStreamResponse = {
        status: 'NotFound',
        streamingRequired: false,
        message: podInfo?.message || 'Job not found',
      };
      return res.status(200).json(response);
    }

    let status: BuildLogStreamResponse['status'] = 'Pending';
    if (podInfo.status === 'Succeeded') {
      status = 'Complete';
    } else if (podInfo.status === 'Failed') {
      status = 'Failed';
    } else if (podInfo.status === 'Pending') {
      status = 'Pending';
    } else if (podInfo.status === 'Running') {
      status = 'Active';
    } else if (podInfo.status === 'Unknown' || podInfo.status === 'NotFound') {
      status = 'Pending';
    }

    const response: BuildLogStreamResponse = {
      status,
      streamingRequired: status === 'Active' || status === 'Pending',
      podName: podInfo.podName,
    };

    if (podInfo.podName) {
      response.websocket = {
        endpoint: '/api/logs/stream',
        parameters: {
          podName: podInfo.podName,
          namespace: namespace,
          follow: status === 'Active' || status === 'Pending',
          timestamps: true,
        },
      };
    }

    if (podInfo.containers && podInfo.containers.length > 0) {
      response.containers = podInfo.containers.map((c) => ({
        name: c.name,
        state: c.state,
      }));
    }

    if (status === 'Complete') {
      response.message = `Job pod ${podInfo.podName} has status: Completed. Streaming not active.`;
    } else if (status === 'Failed') {
      response.message = `Job pod ${podInfo.podName} has status: Failed. Streaming not active.`;
    }

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`Error getting build log streaming info for job ${jobName}`, { error, uuid, name });
    if (error.message?.includes('Kubernetes') || error.statusCode === 502) {
      return res.status(502).json({ error: 'Failed to communicate with Kubernetes.' });
    }
    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
}
