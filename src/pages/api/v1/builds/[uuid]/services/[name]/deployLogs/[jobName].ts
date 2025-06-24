import type { NextApiRequest, NextApiResponse } from 'next';
import rootLogger from 'server/lib/logger';
import { getK8sPodContainers } from 'server/lib/logStreamingHelper';
import * as k8s from '@kubernetes/client-node';
import { HttpError } from '@kubernetes/client-node';

const logger = rootLogger.child({
  filename: __filename,
});

interface DeployLogStreamResponse {
  status: 'Active' | 'Complete' | 'Failed' | 'NotFound' | 'Pending';
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
  error?: string;
}

async function getJobStatus(
  jobName: string,
  namespace: string
): Promise<{
  status: 'Active' | 'Complete' | 'Failed' | 'NotFound' | 'Pending';
  podName?: string;
  error?: string;
}> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const jobResponse = await batchV1Api.readNamespacedJob(jobName, namespace);
    const job = jobResponse.body;

    let status: 'Active' | 'Complete' | 'Failed' | 'Pending' = 'Active';
    let error: string | undefined;

    if (job.status?.succeeded && job.status.succeeded > 0) {
      status = 'Complete';
    } else if (job.status?.failed && job.status.failed > 0) {
      status = 'Failed';
      const failedCondition = job.status.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
      error = failedCondition?.message || 'Job failed';
    } else if (!job.status?.active && !job.status?.succeeded && !job.status?.failed) {
      status = 'Pending';
    }

    let podName: string | undefined;
    if (job.spec?.selector?.matchLabels) {
      const labelSelector = Object.entries(job.spec.selector.matchLabels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');

      const podListResponse = await coreV1Api.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
      );
      const pods = podListResponse.body.items || [];

      if (pods.length > 0) {
        pods.sort(
          (a, b) => (b.metadata?.creationTimestamp?.getTime() || 0) - (a.metadata?.creationTimestamp?.getTime() || 0)
        );
        podName = pods[0].metadata?.name;
      }
    }

    return { status, podName, error };
  } catch (error) {
    if (error instanceof HttpError && error.response?.statusCode === 404) {
      return { status: 'NotFound', error: 'Job no longer exists. Logs have been cleaned up after 24 hours.' };
    }
    throw error;
  }
}

const deployLogStreamHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    logger.warn({ method: req.method }, 'Method not allowed');
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { uuid, name, jobName } = req.query;

  if (typeof uuid !== 'string' || typeof name !== 'string' || typeof jobName !== 'string') {
    logger.warn({ uuid, name, jobName }, 'Missing or invalid query parameters');
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  try {
    const namespace = `env-${uuid}`;

    const { status, podName, error } = await getJobStatus(jobName, namespace);

    if (status === 'NotFound') {
      const response: DeployLogStreamResponse = {
        status: 'NotFound',
        error: error || 'Job not found',
      };
      return res.status(200).json(response);
    }

    if (!podName) {
      const response: DeployLogStreamResponse = {
        status,
        error: 'Pod not found for job',
      };
      return res.status(200).json(response);
    }

    const podInfo = await getK8sPodContainers(podName, namespace);

    const response: DeployLogStreamResponse = {
      status,
      websocket: {
        endpoint: '/api/logs/stream',
        parameters: {
          podName,
          namespace,
          follow: status === 'Active' || status === 'Pending',
          timestamps: true,
        },
      },
      containers: podInfo.containers.map((c) => ({
        name: c.name,
        state: c.state,
      })),
    };

    if (error) {
      response.error = error;
    }

    return res.status(200).json(response);
  } catch (error) {
    logger.error({ err: error }, `Error getting deploy log stream for job ${jobName}.`);

    if (error instanceof HttpError) {
      return res.status(502).json({ error: 'Failed to communicate with Kubernetes.' });
    }

    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

export default deployLogStreamHandler;
