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

    // Get the build
    const build = await buildService.db.models.Build.query().findOne({ uuid });

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    // Construct namespace from build UUID
    const namespace = `env-${build.uuid}`;

    // Get pod info for the job
    const podInfo = await getK8sJobStatusAndPod(jobName, namespace);

    if (!podInfo || podInfo.status === 'NotFound') {
      const response: BuildLogStreamResponse = {
        status: 'NotFound',
        streamingRequired: false,
        message: podInfo?.message || 'Job not found',
      };
      return res.status(200).json(response);
    }

    // Map status to simplified values
    let status: BuildLogStreamResponse['status'] = 'Active';
    if (podInfo.status === 'Succeeded') {
      status = 'Complete';
    } else if (podInfo.status === 'Failed') {
      status = 'Failed';
    } else if (podInfo.status === 'Pending') {
      status = 'Pending';
    }

    // Build response with websocket info (always include for pod access)
    const response: BuildLogStreamResponse = {
      status,
      streamingRequired: status === 'Active' || status === 'Pending',
      podName: podInfo.podName,
    };

    // Always include websocket info if we have a pod
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

    // Add containers info if available
    if (podInfo.containers && podInfo.containers.length > 0) {
      response.containers = podInfo.containers.map((c) => ({
        name: c.name,
        state: c.state,
      }));
    }

    // Add message for completed/failed jobs
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
